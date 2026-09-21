'use strict';

/**
 * Owns the runtime context and the execution queue for each platform account.
 *
 * This module deliberately knows nothing about Douyin or a particular adapter.
 * A caller supplies a contextFactory and a task function.  Tasks for one
 * account are serialized; queues belonging to different accounts are started
 * independently and can therefore run in parallel.
 */

const crypto = require('node:crypto');

function requiredId(value, name = 'accountId') {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function optionalText(value, name, max = 200) {
  if (value == null) return null;
  return requiredId(value, name).slice(0, max);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function managerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class AccountRuntimeManager {
  constructor({ contextFactory } = {}) {
    if (typeof contextFactory !== 'function') throw new TypeError('account contextFactory is required');
    this.contextFactory = contextFactory;
    this.accounts = new Map();
    this.closed = false;
  }

  /** Register an account without constructing its context. */
  register(accountId, options = {}) {
    const id = requiredId(accountId);
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('account options must be an object');
    if (this.closed) throw managerError('MANAGER_CLOSED', 'account runtime manager is closed');
    const existing = this.accounts.get(id);
    if (existing) {
      if (options.reactivate === true && existing.status === 'invalidated') {
        this.#reactivate(existing, options);
      }
      return this.#snapshotAccount(existing);
    }
    const account = {
      accountId: id,
      options: clone(options),
      status: 'active',
      generation: 0,
      queue: [],
      running: null,
      taskPromises: new Map(),
      contextPromise: null,
      context: null,
      contextClosed: false,
      invalidationReason: null,
      pumping: false
    };
    this.accounts.set(id, account);
    return this.#snapshotAccount(account);
  }

  /** Return a stable account context, creating it on the first task only. */
  async getContext(accountId) {
    const account = this.#getActive(accountId, { create: true });
    return this.#ensureContext(account);
  }

  /**
   * Queue one task for an account.
   *
   * The task receives { accountId, context, signal, taskId, generation }.
   * Supplying taskId/idempotencyKey makes duplicate submissions return the
   * original promise instead of executing the same task twice.
   */
  run(accountId, task, { taskId = null, idempotencyKey = null, metadata = {} } = {}) {
    if (typeof task !== 'function') throw new TypeError('account task must be a function');
    const account = this.#getActive(accountId, { create: true });
    const key = optionalText(idempotencyKey || taskId, 'taskId', 240);
    if (key && account.taskPromises.has(key)) return account.taskPromises.get(key);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new TypeError('task metadata must be an object');

    const job = {
      task,
      key,
      metadata: clone(metadata),
      generation: account.generation,
      controller: new AbortController(),
      settled: false,
      resolve: null,
      reject: null,
      promise: null
    };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    if (key) account.taskPromises.set(key, job.promise);
    account.queue.push(job);
    this.#pump(account);
    return job.promise;
  }

  enqueue(accountId, task, options = {}) { return this.run(accountId, task, options); }

  /** Cancel a queued/running task by its idempotency key. */
  cancel(accountId, taskId, reason = 'task_cancelled') {
    const account = this.accounts.get(requiredId(accountId));
    if (!account) return false;
    const key = optionalText(taskId, 'taskId', 240);
    const queued = account.queue.find((job) => job.key === key);
    const job = queued || (account.running?.key === key ? account.running : null);
    if (!job) return false;
    this.#settleJob(account, job, managerError('TASK_CANCELLED', requiredId(reason, 'cancel reason')));
    job.controller.abort(reason);
    if (queued) account.queue = account.queue.filter((candidate) => candidate !== job);
    return true;
  }

  /**
   * Invalidate one account.  Its signal is aborted and queued tasks are
   * rejected.  The current callback is allowed to finish/observe AbortSignal,
   * but its result can never be committed after the generation changes.
   */
  invalidate(accountId, reason = 'account_invalidated') {
    const account = this.accounts.get(requiredId(accountId));
    if (!account || account.status === 'closed') return false;
    const message = requiredId(reason, 'invalidation reason');
    account.status = 'invalidated';
    account.generation += 1;
    account.invalidationReason = message;
    for (const job of account.queue.splice(0)) {
      job.controller.abort(message);
      this.#settleJob(account, job, managerError('ACCOUNT_INVALIDATED', message));
    }
    if (account.running) {
      account.running.controller.abort(message);
      this.#settleJob(account, account.running, managerError('ACCOUNT_INVALIDATED', message));
    }
    this.#notifyContext(account, 'invalidate', message);
    return true;
  }

  /** Close contexts for invalidated accounts while keeping the manager usable. */
  async closeInvalidated() {
    await Promise.all([...this.accounts.values()]
      .filter((account) => account.status === 'invalidated')
      .map((account) => this.#closeContext(account)));
    return this.snapshot();
  }

  snapshot() {
    return {
      closed: this.closed,
      accounts: [...this.accounts.values()].map((account) => this.#snapshotAccount(account))
    };
  }

  /** Invalidate every account and close every created context. */
  async close(reason = 'manager_closed') {
    if (this.closed) return this.snapshot();
    this.closed = true;
    for (const account of this.accounts.values()) {
      this.invalidate(account.accountId, reason);
      account.status = 'closed';
    }
    await Promise.all([...this.accounts.values()].map((account) => this.#closeContext(account)));
    return this.snapshot();
  }

  #getActive(accountId, { create = false } = {}) {
    const id = requiredId(accountId);
    let account = this.accounts.get(id);
    if (!account && create) {
      this.register(id);
      account = this.accounts.get(id);
    }
    if (!account) throw managerError('ACCOUNT_NOT_REGISTERED', `account is not registered: ${id}`);
    if (account.status !== 'active') throw managerError('ACCOUNT_INVALIDATED', `account is ${account.status}: ${id}`);
    return account;
  }

  #ensureContext(account) {
    if (account.context) return Promise.resolve(account.context);
    if (account.contextPromise) return account.contextPromise;
    const generation = account.generation;
    account.contextPromise = Promise.resolve().then(() => this.contextFactory({ accountId: account.accountId, options: clone(account.options), generation })).then((context) => {
      if (!context || (typeof context !== 'object' && typeof context !== 'function')) throw managerError('CONTEXT_INVALID', `contextFactory returned no context for ${account.accountId}`);
      if (account.status !== 'active' || account.generation !== generation) {
        try { context.close?.(); } catch {}
        throw managerError('ACCOUNT_INVALIDATED', `account was invalidated while creating context: ${account.accountId}`);
      }
      account.context = context;
      account.contextClosed = false;
      return context;
    }).catch((error) => {
      account.contextPromise = null;
      throw error;
    });
    return account.contextPromise;
  }

  #pump(account) {
    if (account.pumping || account.status !== 'active') return;
    const job = account.queue.shift();
    if (!job) return;
    account.pumping = true;
    account.running = job;
    this.#execute(account, job).then((result) => this.#settleJob(account, job, null, result), (error) => this.#settleJob(account, job, error)).finally(() => {
      if (account.running === job) account.running = null;
      account.pumping = false;
      this.#pump(account);
    });
  }

  async #execute(account, job) {
    if (job.generation !== account.generation || account.status !== 'active') throw managerError('ACCOUNT_INVALIDATED', account.invalidationReason || 'account is invalidated');
    const context = await this.#ensureContext(account);
    if (job.generation !== account.generation || account.status !== 'active' || job.controller.signal.aborted) throw managerError('ACCOUNT_INVALIDATED', account.invalidationReason || 'account is invalidated');
    return job.task({ accountId: account.accountId, context, signal: job.controller.signal, taskId: job.key, generation: job.generation, metadata: clone(job.metadata) });
  }

  #settleJob(account, job, error, result) {
    if (job.settled) return;
    job.settled = true;
    if (error) job.reject(error); else job.resolve(result);
    if (job.key && account.taskPromises.get(job.key) === job.promise && error?.code === 'TASK_CANCELLED') account.taskPromises.delete(job.key);
  }

  #notifyContext(account, method, ...args) {
    if (!account.context || typeof account.context[method] !== 'function') return;
    Promise.resolve().then(() => account.context[method](...args)).catch(() => {});
  }

  #reactivate(account, options) {
    if (account.context || account.contextPromise) {
      const previous = account.context;
      account.context = null;
      account.contextPromise = null;
      account.contextClosed = true;
      Promise.resolve(previous?.close?.()).catch(() => {});
    }
    account.status = 'active';
    account.generation += 1;
    account.options = clone({ ...account.options, ...options });
    account.invalidationReason = null;
    account.taskPromises.clear();
    account.context = null;
    account.contextPromise = null;
    account.contextClosed = false;
  }

  async #closeContext(account) {
    if (account.contextClosed) return;
    account.contextClosed = true;
    try { await account.context?.close?.(); } catch {}
    account.context = null;
    account.contextPromise = null;
  }

  #snapshotAccount(account) {
    return {
      accountId: account.accountId,
      status: account.status,
      generation: account.generation,
      queued: account.queue.length,
      running: account.running ? { taskId: account.running.key } : null,
      contextReady: Boolean(account.context),
      invalidationReason: account.invalidationReason
    };
  }
}

module.exports = { AccountRuntimeManager };
