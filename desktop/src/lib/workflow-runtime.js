'use strict';

const crypto = require('node:crypto');

const RUN_STATES = Object.freeze({
  PLANNED: 'PLANNED',
  RUNNING: 'RUNNING',
  CHECKPOINT: 'CHECKPOINT',
  UNKNOWN: 'UNKNOWN',
  WAITING_HUMAN: 'WAITING_HUMAN',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
});

const TERMINAL_STATES = new Set([RUN_STATES.COMPLETED, RUN_STATES.FAILED]);
const RESUMABLE_STATES = new Set([
  RUN_STATES.PLANNED,
  RUN_STATES.CHECKPOINT,
  RUN_STATES.UNKNOWN,
  RUN_STATES.WAITING_HUMAN,
  RUN_STATES.PAUSED
]);
const RETRYABLE = 'retryable';
const DEFAULT_RETRY_BACKOFF_MS = Object.freeze([5_000, 15_000, 30_000]);

function now() { return new Date().toISOString(); }
function clone(value) { return structuredClone(value); }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function plainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}
function requiredText(value, name, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function normalizeDefinition(definition) {
  plainObject(definition, 'workflow definition');
  const workflowId = requiredText(definition.workflowId || definition.id, 'workflowId', 120);
  const version = requiredText(definition.version, 'workflow version', 40);
  if (!Array.isArray(definition.steps) || definition.steps.length === 0 || definition.steps.length > 100) throw new TypeError('workflow steps must be a non-empty list');
  const steps = definition.steps.map((step, index) => {
    const value = typeof step === 'string' ? { stepId: step } : plainObject(step, `workflow step ${index}`);
    return {
      stepId: requiredText(value.stepId || value.id, `workflow step ${index}`, 120),
      retryLimit: Number.isInteger(value.retryLimit) && value.retryLimit >= 0 && value.retryLimit <= 3 ? value.retryLimit : 2,
      sideEffect: value.sideEffect === true
    };
  });
  return { workflowId, version, steps };
}

class WorkflowRuntime {
  constructor({ store, accountId, modelDecider, workflows = [], stepExecutor, reconcileAction, healthCheck, onStateChange, clock = now, sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)), retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS } = {}) {
    if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') throw new TypeError('workflow store is required');
    this.store = store;
    this.accountId = requiredText(accountId || 'guest', 'accountId', 200);
    this.modelDecider = modelDecider;
    this.stepExecutor = stepExecutor;
    this.reconcileAction = reconcileAction;
    this.healthCheck = healthCheck;
    this.onStateChange = onStateChange;
    this.clock = clock;
    if (!Array.isArray(retryBackoffMs) || retryBackoffMs.length !== DEFAULT_RETRY_BACKOFF_MS.length || retryBackoffMs.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new TypeError('retryBackoffMs must contain three non-negative integers');
    this.retryBackoffMs = [...retryBackoffMs];
    if (typeof sleep !== 'function') throw new TypeError('workflow sleep must be a function');
    this.sleep = sleep;
    this.workflows = new Map(workflows.map((definition) => {
      const normalized = normalizeDefinition(definition);
      return [`${normalized.workflowId}@${normalized.version}`, normalized];
    }));
    this.running = new Map();
    this.#ensureState();
  }

  registerWorkflow(definition) {
    const normalized = normalizeDefinition(definition);
    this.workflows.set(`${normalized.workflowId}@${normalized.version}`, normalized);
    return clone(normalized);
  }

  listWorkflows() { return [...this.workflows.values()].map(clone); }

  snapshot() {
    const data = this.store.get();
    return {
      accountId: this.accountId,
      runs: data.workflowRuns.filter((run) => run.accountId === this.accountId).map(clone)
    };
  }

  getRun(runId) {
    const value = requiredText(runId, 'runId', 160);
    const run = this.store.get().workflowRuns.find((candidate) => candidate.runId === value);
    if (!run || run.accountId !== this.accountId) throw new Error('workflow run not found');
    return clone(run);
  }

  async planFromIntent(intent, context = {}) {
    requiredText(intent, 'intent', 4000);
    plainObject(context, 'workflow context');
    if (typeof this.modelDecider !== 'function') throw new Error('workflow model decision is unavailable');
    const decision = await this.modelDecider({ intent: intent.trim(), context: clone(context), accountId: this.accountId });
    return this.#normalizePlan(decision, true);
  }

  startPlan(plan) {
    const normalizedPlan = this.#normalizePlan(plan);
    const definition = this.workflows.get(`${normalizedPlan.workflowId}@${normalizedPlan.version}`);
    if (!definition) throw new Error(`workflow is not registered: ${normalizedPlan.workflowId}@${normalizedPlan.version}`);
    const data = this.#readData();
    const active = data.workflowRuns.find((run) => run.accountId === this.accountId && !TERMINAL_STATES.has(run.status));
    if (active) {
      const error = new Error('account already has an active workflow run');
      error.code = 'ACCOUNT_LOCKED';
      throw error;
    }
    const runId = id('run');
    const run = {
      runId,
      accountId: this.accountId,
      workflowId: normalizedPlan.workflowId,
      version: normalizedPlan.version,
      plan: normalizedPlan,
      status: RUN_STATES.PLANNED,
      currentStep: 0,
      steps: definition.steps.map((step) => ({ stepId: step.stepId, status: 'pending', attempts: 0, sideEffect: step.sideEffect, actionId: id('action'), idempotencyKey: id('idem') })),
      checkpoint: null,
      lastError: null,
      createdAt: this.clock(),
      updatedAt: this.clock()
    };
    data.workflowRuns.push(run);
    this.#writeData(data);
    return clone(run);
  }

  async run(runId) {
    const value = requiredText(runId, 'runId', 160);
    if (this.running.has(value)) return this.running.get(value);
    const promise = this.#run(value).finally(() => this.running.delete(value));
    this.running.set(value, promise);
    return promise;
  }

  async resumeRun(runId, { skipHealthCheck = false } = {}) {
    const run = this.getRun(runId);
    if (!RESUMABLE_STATES.has(run.status)) throw new Error(`workflow cannot be resumed from ${run.status}`);
    if (this.healthCheck && !skipHealthCheck) await this.checkHealth(run.runId);
    if (run.status === RUN_STATES.UNKNOWN) {
      const reconciled = await this.#reconcileUnknown(run);
      if (!reconciled) return this.getRun(run.runId);
    }
    return this.run(run.runId);
  }

  async checkHealth(runId) {
    const run = this.getRun(runId);
    if (typeof this.healthCheck !== 'function') {
      const error = new Error('workflow health check is unavailable');
      error.code = 'HEALTH_CHECK_UNAVAILABLE';
      throw error;
    }
    const results = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await this.healthCheck({ accountId: this.accountId, run: clone(this.getRun(run.runId)), attempt });
      const ok = result === true || (result && result.ok === true);
      results.push(result);
      if (!ok) {
        const error = new Error('workflow health check failed');
        error.code = 'HEALTH_CHECK_FAILED';
        error.results = clone(results);
        throw error;
      }
    }
    return { checksPassed: 2, results };
  }

  pauseRun(runId, reason = 'manual_pause') {
    const data = this.#readData();
    const run = this.#findOwned(data, runId);
    if (TERMINAL_STATES.has(run.status)) return clone(run);
    run.status = RUN_STATES.PAUSED;
    run.lastError = { code: 'PAUSED', reason: requiredText(reason, 'pause reason', 300) };
    run.updatedAt = this.clock();
    this.#writeData(data);
    return clone(run);
  }

  invalidate(reason = 'session_invalidated') {
    const data = this.#readData();
    const pauseReason = requiredText(reason, 'invalidation reason', 300);
    let changed = false;
    for (const run of data.workflowRuns) {
      if (run.accountId !== this.accountId || TERMINAL_STATES.has(run.status)) continue;
      run.status = RUN_STATES.PAUSED;
      run.lastError = { code: 'SESSION_INVALIDATED', reason: pauseReason };
      run.updatedAt = this.clock();
      changed = true;
    }
    if (changed) this.#writeData(data);
    return this.snapshot();
  }

  async #run(runId) {
    let data = this.#readData();
    let run = this.#findOwned(data, runId);
    if (TERMINAL_STATES.has(run.status)) return clone(run);
    if (run.status === RUN_STATES.UNKNOWN) return clone(run);
    const definition = this.workflows.get(`${run.workflowId}@${run.version}`);
    if (!definition) throw new Error(`workflow is not registered: ${run.workflowId}@${run.version}`);
    run.status = RUN_STATES.RUNNING;
    run.updatedAt = this.clock();
    this.#writeData(data);

    while (run.currentStep < definition.steps.length) {
      data = this.#readData();
      run = this.#findOwned(data, runId);
      if (run.status === RUN_STATES.PAUSED) return clone(run);
      const definitionStep = definition.steps[run.currentStep];
      const step = run.steps[run.currentStep];
      step.status = 'running';
      run.status = RUN_STATES.RUNNING;
      run.updatedAt = this.clock();
      this.#writeData(data);

      const maxAttempts = definitionStep.retryLimit + 1;
      const attemptLimit = definitionStep.sideEffect ? 1 : maxAttempts;
      let outcome = null;
      for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
        data = this.#readData();
        run = this.#findOwned(data, runId);
        if (run.status === RUN_STATES.PAUSED) return clone(run);
        run.steps[run.currentStep].attempts = attempt;
        run.updatedAt = this.clock();
        this.#writeData(data);
        try {
          if (typeof this.stepExecutor !== 'function') {
            outcome = { status: 'failed', error: { code: 'EXECUTOR_UNAVAILABLE', message: 'workflow executor is unavailable' } };
          } else outcome = await this.stepExecutor({
            accountId: this.accountId,
            run: clone(run),
            plan: clone(run.plan),
            step: clone(definitionStep),
            action: { actionId: run.steps[run.currentStep].actionId, idempotencyKey: run.steps[run.currentStep].idempotencyKey, sideEffect: definitionStep.sideEffect }
          });
        } catch (error) {
          outcome = { status: RETRYABLE, error: { code: error.code || 'STEP_ERROR', message: error.message || 'step failed' } };
        }
        const normalized = this.#normalizeOutcome(outcome);
        if (normalized.status !== RETRYABLE || attempt >= attemptLimit) {
          outcome = normalized;
          break;
        }
        await this.sleep(this.retryBackoffMs[Math.min(attempt - 1, this.retryBackoffMs.length - 1)], { runId, stepId: definitionStep.stepId, attempt });
      }

      data = this.#readData();
      run = this.#findOwned(data, runId);
      if (run.status === RUN_STATES.PAUSED) return clone(run);
      const currentStep = run.steps[run.currentStep];
      if (outcome?.status === 'completed') {
        currentStep.status = 'completed';
        run.currentStep += 1;
        run.checkpoint = null;
        run.lastError = null;
        run.updatedAt = this.clock();
        this.#writeData(data);
        continue;
      }
      currentStep.status = outcome?.status === RETRYABLE ? 'unknown' : outcome.status;
      run.lastError = outcome.error || (outcome.reason ? { code: outcome.reason } : null);
      if (outcome?.status === RETRYABLE) {
        run.status = RUN_STATES.UNKNOWN;
        run.lastError = { code: definitionStep.sideEffect ? 'SIDE_EFFECT_RESULT_UNKNOWN' : 'RETRY_EXHAUSTED', ...(outcome.error || {}) };
      } else if (outcome?.status === 'unknown') {
        run.status = RUN_STATES.UNKNOWN;
      } else if (outcome?.status === 'checkpoint') {
        run.status = RUN_STATES.CHECKPOINT;
        run.checkpoint = outcome.checkpoint;
      } else if (outcome?.status === 'wait_human') {
        run.status = RUN_STATES.WAITING_HUMAN;
        run.checkpoint = outcome.checkpoint || null;
      } else {
        run.status = RUN_STATES.FAILED;
      }
      run.updatedAt = this.clock();
      this.#writeData(data);
      return clone(run);
    }
    data = this.#readData();
    run = this.#findOwned(data, runId);
    run.status = RUN_STATES.COMPLETED;
    run.updatedAt = this.clock();
    this.#writeData(data);
    return clone(run);
  }

  async #reconcileUnknown(run) {
    if (typeof this.reconcileAction !== 'function') {
      const error = new Error('unknown workflow action requires reconciliation before resume');
      error.code = 'RECONCILE_REQUIRED';
      throw error;
    }
    const definition = this.workflows.get(`${run.workflowId}@${run.version}`);
    const step = definition?.steps[run.currentStep];
    const action = run.steps[run.currentStep];
    if (!definition || !step || !action) throw new Error('workflow action checkpoint is missing');
    const result = await this.reconcileAction({
      accountId: this.accountId,
      run: clone(run),
      plan: clone(run.plan),
      step: clone(step),
      action: { actionId: action.actionId, idempotencyKey: action.idempotencyKey, sideEffect: step.sideEffect }
    });
    plainObject(result, 'reconcile result');
    const data = this.#readData();
    const current = this.#findOwned(data, run.runId);
    if (result.status === 'confirmed') {
      current.steps[current.currentStep].status = 'completed';
      current.currentStep += 1;
      current.status = RUN_STATES.RUNNING;
      current.lastError = null;
      current.checkpoint = { reconciled: 'confirmed', actionId: action.actionId };
    } else if (result.status === 'not_found' && result.safeToRetry === true) {
      current.steps[current.currentStep].status = 'pending';
      current.status = RUN_STATES.RUNNING;
      current.lastError = null;
      current.checkpoint = { reconciled: 'safe_to_retry', actionId: action.actionId };
    } else if (result.status === 'wait_human') {
      current.status = RUN_STATES.WAITING_HUMAN;
      current.checkpoint = result.checkpoint == null ? null : clone(result.checkpoint);
      current.lastError = { code: 'RECONCILE_WAITING_HUMAN' };
    } else {
      current.status = RUN_STATES.UNKNOWN;
      current.checkpoint = { reconciled: 'unconfirmed', actionId: action.actionId };
      current.lastError = { code: 'RECONCILE_UNCONFIRMED' };
    }
    current.updatedAt = this.clock();
    this.#writeData(data);
    return result.status === 'confirmed' || (result.status === 'not_found' && result.safeToRetry === true);
  }

  #normalizeOutcome(outcome) {
    if (outcome == null || outcome.status === 'completed' || outcome.status === 'success' || outcome.status === 'done') return { status: 'completed' };
    plainObject(outcome, 'workflow step outcome');
    const status = outcome.status;
    if (![RETRYABLE, 'unknown', 'checkpoint', 'wait_human', 'failed'].includes(status)) throw new Error(`unsupported workflow step outcome: ${status}`);
    const result = { status };
    if (outcome.reason != null) result.reason = requiredText(String(outcome.reason), 'outcome reason', 300);
    if (outcome.error != null) result.error = clone(outcome.error);
    if (outcome.checkpoint != null) result.checkpoint = clone(outcome.checkpoint);
    return result;
  }

  #normalizePlan(plan, strictDecision = false) {
    if (strictDecision && plan?.plan !== undefined) throw new Error('workflow model decision must return workflowId, version and params');
    const value = plan?.plan && typeof plan.plan === 'object' ? plan.plan : plan;
    plainObject(value, 'workflow plan');
    if (strictDecision) {
      const unexpected = Object.keys(value).filter((key) => !['planId', 'issuedAt', 'expiresAt', 'workflowId', 'version', 'params'].includes(key));
      if (unexpected.length) throw new Error(`workflow model decision contains unsupported fields: ${unexpected.join(',')}`);
    }
    const workflowId = requiredText(value.workflowId, 'workflowId', 120);
    const version = requiredText(value.version, 'workflow version', 40);
    const params = value.params == null ? {} : plainObject(value.params, 'workflow params');
    const normalized = {
      planId: requiredText(value.planId || id('plan'), 'planId', 160),
      workflowId,
      version,
      params: clone(params),
      createdAt: value.createdAt || this.clock()
    };
    for (const key of ['issuedAt', 'expiresAt']) {
      if (value[key] !== undefined && value[key] !== null) {
        if (!['string', 'number'].includes(typeof value[key]) || (typeof value[key] === 'string' && !value[key].trim()) || (typeof value[key] === 'number' && !Number.isFinite(value[key]))) throw new TypeError(`${key} must be a valid server-issued value`);
        normalized[key] = value[key];
      }
    }
    return normalized;
  }

  #ensureState() {
    const data = this.store.get();
    if (!Array.isArray(data.workflowRuns)) { data.workflowRuns = []; this.store.set(data); }
  }

  #readData() {
    const data = this.store.get();
    if (!Array.isArray(data.workflowRuns)) data.workflowRuns = [];
    return data;
  }

  #writeData(data) { this.store.set(data); this.onStateChange?.(this.snapshot()); }

  #findOwned(data, runId) {
    const value = requiredText(runId, 'runId', 160);
    const run = data.workflowRuns.find((candidate) => candidate.runId === value);
    if (!run || run.accountId !== this.accountId) throw new Error('workflow run not found');
    return run;
  }
}

module.exports = { WorkflowRuntime, RUN_STATES, TERMINAL_STATES };
