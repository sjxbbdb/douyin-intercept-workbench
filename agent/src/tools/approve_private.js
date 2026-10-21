'use strict';

const batches = require('../store/batches');
const ledger = require('../ledger');
const scope = require('../scope');
const capture = require('./_capture');
const authority = require('../authority-client');
const { ACTIONS } = require('../blocked-codes');

// 第二阶段：私信。tier=execute，和 approve_batch 一样是写工具。
//
// 🔴 两阶段契约在这里被真正用上：
//   1) 公屏那一次的 sendId 必须作为 publicSendId 带回来 —— 缺了 probe 直接
//      public_missing 拒绝，它是必填而不是可选；
//   2) 服务端也必须【见过】这个 publicSendId 被 commit 成 sent_confirmed，
//      否则授权返回 public_not_confirmed（我在 approve_batch 里补的 commit 就是为它）；
//   3) 私信有自己的 sendId（外加 :private），复用公屏的会被台账当成重放。
//
// 任何一步不确定就不发：fail-closed。

const TERMINAL_LEDGER_STATES = ['sent_confirmed', 'unknown', 'failed', 'blocked'];

function fail(code, reason) {
  return capture.fail(code, reason);
}

function run(ctx, params) {
  const p = params || {};
  const batchId = typeof p.batchId === 'string' ? p.batchId.trim() : '';
  if (!batchId) return fail('blocked/invalid_input', 'batchId is required');
  const sourceType = p.sourceType == null ? 'comment' : String(p.sourceType);
  if (sourceType !== 'comment') {
    // 直播间的弹幕私信走的是另一条通路，当前没有工具入口；不假装支持。
    return fail('blocked/unsupported', 'only comment batches support approve_private for now');
  }
  const decisions = Array.isArray(p.decisions) ? p.decisions : null;
  if (!decisions || !decisions.length) return fail('blocked/invalid_input', 'decisions must be a non-empty array');
  if (decisions.length > 20) return fail('blocked/invalid_input', 'decisions must not exceed 20 in one call');
  for (let i = 0; i < decisions.length; i += 1) {
    const item = decisions[i] || {};
    if (ACTIONS.indexOf(String(item.action)) === -1) {
      return fail('blocked/invalid_input', 'decision ' + i + ': action must be one of ' + ACTIONS.join('/'));
    }
    if (typeof item.eventId !== 'string' || !item.eventId.trim()) {
      return fail('blocked/invalid_input', 'decision ' + i + ': eventId is required');
    }
    if (item.text != null) {
      // 私信文案同样只能来自冻结计划。
      return fail('blocked/invalid_input',
        'decision ' + i + ': text must not be supplied; the frozen plan already carries it');
    }
  }

  const resolved = scope.resolve(ctx);
  if (!resolved.ok) return resolved;

  return (async function () {
    const loaded = batches.read(ctx.agentStateDir, resolved.accountScope, batchId);
    if (!loaded.ok) return loaded;
    if (!loaded.record) {
      return fail('blocked/unknown_batch', 'no frozen record for this batch; run plan_batch first');
    }
    const record = loaded.record;
    const byEvent = new Map();
    (record.targets || []).forEach(function (t) { byEvent.set(String(t.eventId), t); });

    const serverPolicy = await authority.policy(ctx);
    if (!serverPolicy.available) {
      return fail('blocked/' + String(serverPolicy.reason || 'authorization_unavailable'),
        'cannot send private messages without a server-issued policy');
    }
    const policyRef = {
      policyId: serverPolicy.policyRef.policyId,
      policyVersion: serverPolicy.policyRef.policyVersion
    };

    const granted = [];
    const blocked = [];
    for (let i = 0; i < decisions.length; i += 1) {
      const decision = decisions[i];
      if (String(decision.action) !== 'approve') continue;
      const eventId = String(decision.eventId);
      const target = byEvent.get(eventId);
      if (!target) {
        // 不在冻结计划里的事件不能凭空发私信。
        blocked.push({ eventId: eventId, code: 'blocked/event_not_in_plan' });
        continue;
      }
      const privateSendId = batches.privateSendIdFor(batchId, eventId);
      // 公屏那一次的 sendId 就是 publicSendId —— 这是两阶段的绑定点。
      const publicSendId = batches.sendIdFor(batchId, eventId);
      const auth = await authority.requestAuthorization(ctx, {
        sendId: privateSendId,
        kind: 'private',
        phase: 'private',
        // 每用户配额按收件人算：用批次里的加盐身份，不泄露 sec_uid。
        targetKey: 'private:' + String(target.authorHash || eventId),
        publicSendId: publicSendId
      });
      if (!auth.granted) {
        blocked.push({ eventId: eventId, code: 'blocked/' + String(auth.reason || 'authorization_unavailable'),
                       detail: auth.detail || null });
        continue;
      }
      granted.push({ eventId: eventId, sendId: privateSendId, publicSendId: publicSendId,
                     authorizationId: auth.authorizationId });
    }

    if (!granted.length) {
      return { ok: true, result: {
        ok: true, accountScope: resolved.accountScope, batchId, sourceType: 'comment',
        approved: 0, blocked, queuedSendIds: [], results: null,
        note: '没有任何一条拿到服务端私信授权，因此没有调用执行器'
      } };
    }

    const outcome = capture.invoke(ctx, 'comment_private', {
      batchId: batchId,
      items: granted.map(function (g) {
        return { eventId: g.eventId, sendId: g.sendId, publicSendId: g.publicSendId };
      }),
      policyRef: policyRef
    });
    if (!outcome.ok) {
      return { ok: false, code: outcome.code, reason: outcome.reason, protocolCode: outcome.protocolCode,
               grantedCount: granted.length, blocked };
    }

    // 与公屏同样的纪律：结果必须按【台账原始状态】回报服务端。
    const authorityCommits = [];
    for (const g of granted) {
      const row = ledger.sendRow(ctx.config.stateDir, resolved.accountScope, g.sendId);
      const ledgerState = row.ok && row.row ? String(row.row.status) : 'unreadable';
      const state = TERMINAL_LEDGER_STATES.indexOf(ledgerState) === -1 ? 'unknown' : ledgerState;
      const committed = await authority.commitAuthorization(ctx, g.authorizationId, {
        state: state, reason: 'probe_' + ledgerState
      });
      authorityCommits.push({ sendId: g.sendId, publicSendId: g.publicSendId,
        ledgerState, committedState: state, ok: committed.ok,
        error: committed.ok ? null : String(committed.reason || 'commit_failed') });
    }

    const result = outcome.result || {};
    return { ok: true, result: {
      ok: true,
      accountScope: resolved.accountScope,
      batchId,
      sourceType: 'comment',
      approved: granted.length,
      blocked,
      results: result.results || null,
      queuedSendIds: granted.map(function (g) { return g.sendId; }),
      publicSendIds: granted.map(function (g) { return g.publicSendId; }),
      authorityCommits,
      authorityCommitFailed: authorityCommits.filter(function (c) { return !c.ok; }).length,
      checkpoint: result.checkpoint == null ? null : result.checkpoint,
      policyRef,
      note: '私信已交给执行器。注意：私信没有平台 HTTP 回执，台账会是 unknown（不是 sent_confirmed）'
    } };
  })();
}

module.exports = { name: 'approve_private', run };
