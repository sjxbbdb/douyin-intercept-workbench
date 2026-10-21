'use strict';

const ledger = require('../ledger');
const scope = require('../scope');
const capture = require('./_capture');
const authority = require('../authority-client');

// 台账里的终态。只有这四种可以上报给服务端；
// reserved/started 表示"还在路上"，一律按 unknown 上报 —— 绝不冒充成功。
const TERMINAL_LEDGER_STATES = ['sent_confirmed', 'unknown', 'failed', 'blocked'];
const { ACTIONS } = require('../blocked-codes');

// 唯一的写工具：把审批结果交给 probe 执行。
//
// 这是"发送"在 agent 层的入口，而 probe 那边的发送能力【早就实现且真机验证过】
// （comment_reply / comment_private，公屏回执 status_code=0 才算 confirmed）。
//
// 🔴 三条硬规矩：
//   1) action 只允许 approve / reject / skip —— 不可换目标、不可改文案、不可新增条目；
//   2) 每一条 approved 都要【单独】向服务端申请授权；服务端不给就不发这一条，
//      而且绝不因为"本地想看"就放过（本地闸门与服务端授权，两边都过才发）；
//   3) 任何一步不确定（授权超时、返回畸形）一律不发 —— fail-closed。

function run(ctx, params) {
  const p = params || {};
  const batchId = typeof p.batchId === 'string' ? p.batchId.trim() : '';
  if (!batchId) return capture.fail('blocked/invalid_input', 'batchId is required');
  const sourceType = p.sourceType == null ? 'comment' : String(p.sourceType);
  if (['comment', 'live'].indexOf(sourceType) === -1) {
    return capture.fail('blocked/invalid_input', 'sourceType must be comment or live');
  }
  const decisions = Array.isArray(p.decisions) ? p.decisions : null;
  if (!decisions || !decisions.length) {
    return capture.fail('blocked/invalid_input', 'decisions must be a non-empty array');
  }
  if (decisions.length > 50) {
    return capture.fail('blocked/invalid_input', 'decisions must not exceed 50 in one call');
  }
  for (let i = 0; i < decisions.length; i += 1) {
    const item = decisions[i] || {};
    if (ACTIONS.indexOf(String(item.action)) === -1) {
      return capture.fail('blocked/invalid_input',
        'decision ' + i + ': action must be one of ' + ACTIONS.join('/'));
    }
    if (typeof item.eventId !== 'string' || !item.eventId.trim()) {
      return capture.fail('blocked/invalid_input', 'decision ' + i + ': eventId is required');
    }
    if (typeof item.sendId !== 'string' || !item.sendId.trim()) {
      return capture.fail('blocked/invalid_input', 'decision ' + i + ': sendId is required');
    }
    if (item.text != null && item.action === 'approve') {
      // 文案只能来自冻结计划，不允许调用方自带。
      return capture.fail('blocked/invalid_input',
        'decision ' + i + ': text must not be supplied; the frozen plan already carries it');
    }
  }
  const resolved = scope.resolve(ctx);
  if (!resolved.ok) return resolved;

  return (async function () {
    const phase = sourceType === 'live' ? 'danmaku_reply' : 'comment';
    const granted = [];
    const blocked = [];

    // 🔴 真机踩过：建批次时把【服务端策略身份】冻进了计划，执行时必须带回来，
    //    否则 probe 的 _require_policy 直接拒（policy_ref_missing）——
    //    这是它该有的行为，缺的是我这里没把身份带回去。
    //
    //    这里重新向服务端取【当前】身份，而不是回放本地副本：
    //      · 服务端没变 -> 与冻结值一致，放行；
    //      · 服务端改过版本 -> probe 报 policy_ref_mismatch，强制重新建批次。
    //    回放本地副本只是自证，证明不了"这个身份是服务端现在认可的"。
    const serverPolicy = await authority.policy(ctx);
    if (!serverPolicy.available) {
      return capture.fail('blocked/' + String(serverPolicy.reason || 'authorization_unavailable'),
        'cannot execute without a server-issued policy: ' + String(serverPolicy.detail || serverPolicy.reason));
    }
    const policyRef = {
      policyId: serverPolicy.policyRef.policyId,
      policyVersion: serverPolicy.policyRef.policyVersion
    };

    for (let i = 0; i < decisions.length; i += 1) {
      const item = decisions[i];
      if (String(item.action) !== 'approve') continue;
      // 逐条申请授权：服务端为这次发送计数并裁决。
      const auth = await authority.requestAuthorization(ctx, {
        sendId: item.sendId,
        kind: phase,
        phase: 'public',
        targetKey: String(item.targetKey || ('event:' + item.eventId))
      });
      if (!auth.granted) {
        blocked.push({ eventId: item.eventId, sendId: item.sendId,
                       code: 'blocked/' + String(auth.reason || 'authorization_unavailable'),
                       detail: auth.detail || null });
        continue;
      }
      granted.push({ decision: item, authorizationId: auth.authorizationId });
    }

    if (!granted.length) {
      // 一条都没被授权 —— 不碰 probe，直接如实返回。
      return { ok: true, result: {
        ok: true, accountScope: resolved.accountScope, batchId,
        approved: 0, blocked, queuedSendIds: [], results: null,
        note: '没有任何一条拿到服务端授权，因此没有调用执行器'
      } };
    }

    // 真正的执行交给 probe 的既有能力（真机验证过的两阶段契约在里面）。
    const items = granted.map(function (entry) {
      const item = entry.decision;
      return {
        eventId: String(item.eventId),
        sendId: String(item.sendId),
        publicSendId: item.publicSendId == null ? null : String(item.publicSendId)
      };
    });
    const outcome = capture.invoke(ctx,
      sourceType === 'live' ? 'live_reply' : 'comment_reply',
      { batchId: batchId, items: items, policyRef: policyRef });

    if (!outcome.ok) {
      // 执行失败：把已授权的条目如实报出来（它们已经消耗了服务端配额）。
      return { ok: false, code: outcome.code, reason: outcome.reason,
               protocolCode: outcome.protocolCode,
               grantedCount: granted.length, blocked };
    }
    const result = outcome.result || {};

    // 🔴 真机发现的漏洞：执行完【从不】把结果报回服务端。
    //    后果有两个，都很致命：
    //      ① 授权停在 reserved，服务端配额永远不释放 —— 会被自己的账拖死；
    //      ② 服务端从没见过某次公屏"确认成功"，于是私信授权永远拿不到
    //         （public_not_confirmed），两阶段契约在服务端侧就断了。
    //
    //    上报的值必须来自【台账原始状态】，不是 probe 的对外 status：
    //    对外 status 故意把 sent_confirmed 投影成 unknown（避免过度宣称），
    //    拿它上报会把成功记成未知，私信同样进不去。
    const authorityCommits = [];
    for (const entry of granted) {
      const sendId = String(entry.decision.sendId);
      const row = ledger.sendRow(ctx.config.stateDir, resolved.accountScope, sendId);
      const ledgerState = row.ok && row.row ? String(row.row.status) : 'unreadable';
      const state = TERMINAL_LEDGER_STATES.indexOf(ledgerState) === -1 ? 'unknown' : ledgerState;
      const committed = await authority.commitAuthorization(ctx, entry.authorizationId, {
        state: state,
        reason: 'probe_' + ledgerState
      });
      authorityCommits.push({
        sendId,
        authorizationId: entry.authorizationId,
        ledgerState,
        committedState: state,
        ok: committed.ok,
        error: committed.ok ? null : String(committed.reason || 'commit_failed')
      });
    }

    return { ok: true, result: {
      ok: true,
      accountScope: resolved.accountScope,
      batchId,
      approved: granted.length,
      blocked,
      results: result.results || null,
      queuedSendIds: granted.map(function (e) { return String(e.decision.sendId); }),
      // 每条授权在服务端的了结情况：这是私信能不能拿到的前提。
      authorityCommits,
      authorityCommitFailed: authorityCommits.filter(function (c) { return !c.ok; }).length,
      checkpoint: result.checkpoint == null ? null : result.checkpoint,
      // 两阶段的第二阶段（私信）必须另走一次审批：只有公屏拿到平台回执
      // （sent_confirmed）之后才谈得上。
      nextPhase: sourceType === 'live' ? 'live_private' : 'comment_private',
      note: '公屏已交给执行器；私信必须等平台回执确认之后再单独审批'
    } };
  })();
}

module.exports = { name: 'approve_batch', run };
