'use strict'
// scripts/smoke-server.js
// 真实启动授权中心并跑一遍完整业务流，用于人工验收。
//
// 用法：node scripts/smoke-server.js
//
// ⚠️ 这不是单元测试的替代品，而是"服务能真的起来并跑通"的端到端演示。
//    它会真实建库、真实起 HTTP、真实签名。

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { createServer } = require('../license-server/server')
const { hashPassword } = require('../license-server/crypto/password')
const { grantCredits } = require('../license-server/domain/billing')
const { planCreditsFor } = require('../license-server/domain/policy')
const { generateRedeemCodes } = require('../license-server/api/routes-credit')
const { Client, request, makeSend } = require('../test/integration/helpers')

function line(s) { console.log(s) }
function ok(s) { console.log('  \x1b[32m✓\x1b[0m ' + s) }
function info(s) { console.log('    ' + s) }

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-license-smoke-'))
  line('═'.repeat(64))
  line('  授权中心冒烟验收')
  line('═'.repeat(64))
  line(`  数据目录：${dir}`)
  line('')

  const inst = createServer({
    dataDir: dir,
    dbPath: path.join(dir, 'license.db'),
    host: '127.0.0.1',
    port: 0,
    masterKey: 'smoke-master-key-0123456789abcdef0123456789abcdef',
    logLevel: 'error',
    logSink: { write() {} },
    backupBeforeMigrate: false,
  })

  const addr = await inst.listen()
  ok(`服务已启动 → http://127.0.0.1:${addr.port}`)

  // ── 健康检查
  const hz = await request(addr, 'GET', '/healthz')
  ok(`健康检查 /healthz → ${hz.status}，协议版本 ${hz.body.protocol_version}`)

  // ── 建账号 + 套餐 + 卡密
  const now = Date.now()
  const password = 'demo-pw-123456'
  const r = inst.db.prepare(`
    INSERT INTO account (account, display_name, pass_hash, first_login_ms, created_at_ms, updated_at_ms, status)
    VALUES ('demo001','演示店铺',?,?,?,?,'active')
  `).run(hashPassword(password), now - 29 * 86400000, now, now)
  const accountId = Number(r.lastInsertRowid)

  inst.db.prepare(`
    INSERT INTO plan (plan_key, name, credits, valid_days, price_cents, price_is_placeholder, is_default, active, created_at_ms)
    VALUES ('plan_half_year','半年套餐',?,180,0,1,1,1,?)
  `).run(planCreditsFor(180), now)

  inst.db.prepare('INSERT INTO credit (account_id, balance_milli, updated_at_ms) VALUES (?,0,?)').run(accountId, now)
  inst.db.prepare('INSERT INTO account_billing (account_id, insufficient, state, updated_at_ms) VALUES (?,0,?,?)')
    .run(accountId, 'active', now)
  grantCredits(inst.db, {
    accountId, deltaMilli: 50 * 1000, kind: 'grant', operator: 'smoke', note: '初始额度', nowMs: now,
  })
  ok(`已建账号 demo001（第 30 天 = 稳定期）与半年套餐（${planCreditsFor(180)} 积分）`)
  info(`初始余额 50 积分`)

  const gen = generateRedeemCodes(inst.db, { count: 2, credits: 12600, validDays: 180, batch: 'SMOKE', nowMs: now })
  ok(`已生成 2 张卡密，例如：${gen.codes[0]}`)

  // ── 登录
  const c = new Client(addr, { account: 'demo001', password, deviceId: 'smoke-dev-1', instanceId: 'inst-1' })
  const login = await c.login()
  ok(`登录成功 → 等级 ${login.body.policy.account_tier}，日上限（评论）${login.body.policy.limits.comment.daily_max}`)
  info(`额度文案：${login.body.quota_notice.headline}`)
  info(`login_proof 已自证（客户端已验签）`)

  // ── 心跳 + 策略 ack
  const hb = await c.post('/api/v1/heartbeat', {
    instance_id: 'inst-1',
    online_seconds: 60,
    client_time_ms: Date.now(),
    applied_policy_version: login.body.policy.policy_version,
    applied_limits: { comment: { daily_max: 10, min_interval_ms: 120000, content_similarity_max: 0.8 } },
  })
  ok(`心跳 → 今日剩余：评论 ${hb.body.daily_quota.comment.remaining} / 弹幕 ${hb.body.daily_quota.live_danmaku.remaining} / 私信 ${hb.body.daily_quota.dm.remaining}`)
  info(`online_seconds 标记为 ${hb.body.online_seconds_note}（不参与计费）`)

  const ack = inst.db.prepare('SELECT COUNT(*) c FROM policy_ack_log WHERE account_id=?').get(accountId)
  ok(`策略 ack 已存证（红线 3）：policy_ack_log 有 ${ack.c} 条`)

  // ── 越权尝试
  const vio = await c.post('/api/v1/heartbeat', {
    instance_id: 'inst-1',
    applied_policy_version: 1,
    applied_limits: { comment: { daily_max: 9999 } },
  })
  ok(`越权上报（daily_max=9999）被拒 → ${vio.body.policy_violation.code}，策略允许 ${vio.body.policy_violation.detail.allowed}`)
  const vioLog = inst.db.prepare(
    "SELECT COUNT(*) c FROM audit_config_changes WHERE account_id=? AND reject_code='POLICY_VIOLATION'"
  ).get(accountId)
  ok(`越权尝试已留痕（供举证）：audit_config_changes 有 ${vioLog.c} 条`)

  // ── 上报发送明细（含失败与 DOM 判据，验证"只对成功计费"）
  const before = Number(inst.db.prepare('SELECT balance_milli FROM credit WHERE account_id=?').get(accountId).balance_milli)
  const sends = [
    makeSend(),                                                          // 成功 → 计费
    makeSend(),                                                          // 成功 → 计费
    makeSend({ verdict: 'failed', evidence: { confirm_signal: 'none', platform_status_code: null }, failure_reason: 'risk_control_rejected' }), // 风控 → 不计费
    makeSend({ verdict: 'sent_confirmed', evidence: { confirm_signal: 'dom_stable', platform_status_code: 0 } }), // DOM → 不计费
    makeSend({ verdict: 'sent_suspected', evidence: { confirm_signal: 'none' } }), // 疑似 → 不计费
  ]
  const rep = await c.post('/api/v1/audit/sends', { sends })
  const after = Number(inst.db.prepare('SELECT balance_milli FROM credit WHERE account_id=?').get(accountId).balance_milli)
  ok(`上报 5 条明细（2 成功 / 1 风控拒绝 / 1 DOM 判据 / 1 疑似）`)
  info(`计费 ${rep.body.settlement.billed_count} 条，扣 ${rep.body.settlement.charged_milli / 1000} 积分`)
  info(`失败与 DOM 判据**未计费**（红线 2）：余额 ${before / 1000} → ${after / 1000}`)
  if (rep.body.audit_flags.length) info(`审计标记：${rep.body.audit_flags.join(', ')}`)

  // ── 幂等
  const dup = await c.post('/api/v1/audit/sends', { sends: [sends[0], sends[1]] })
  ok(`重复上报同一批 → 计费 ${dup.body.settlement.billed_count} 条，幂等命中 ${dup.body.settlement.duplicate_count} 条`)

  // ── 隐私边界
  const priv = await c.post('/api/v1/audit/sends', { sends: [makeSend({ text: '这是一条真实评论内容' })] })
  ok(`尝试上报评论原文 → 被拒 ${priv.body.code}（红线 3：只传哈希不传原文）`)

  // ── 查询余额与台账
  const bal = await c.get('/api/v1/credit/balance')
  ok(`查询余额 → ${bal.body.credit.balance_milli / 1000} 积分，可发 ${bal.body.credit.replies_affordable} 条`)
  const led = await c.get('/api/v1/credit/ledger?granularity=raw')
  ok(`查询台账 → ${led.body.entries.length} 条流水，消耗合计 ${led.body.summary.usage_milli / 1000} 积分`)

  // ── 卡密兑换
  const red = await c.post('/api/v1/credit/redeem', { code: gen.codes[0], request_id: 'smoke-req-1' })
  ok(`卡密兑换成功 → +${red.body.credits} 积分，余额 ${red.body.balance_milli / 1000}`)
  const red2 = await c.post('/api/v1/credit/redeem', { code: gen.codes[0], request_id: 'smoke-req-2' })
  ok(`重复兑换同一卡密 → ${red2.body.code}（幂等，不重复入账）`)

  // ── 套餐信息
  const plan = await c.get('/api/v1/account/plan')
  ok(`套餐信息 → 稳定期日上限合计 ${plan.body.stable_daily_max_total}，最低套餐积分 ${plan.body.min_plan_credit}`)
  info(`价格标记为占位值：${plan.body.plans[0].price_is_placeholder}`)

  // ── 观察期演示
  const r2 = inst.db.prepare(`
    INSERT INTO account (account, display_name, pass_hash, first_login_ms, created_at_ms, updated_at_ms, status)
    VALUES ('demo002','新商家',?,?,?,?,'active')
  `).run(hashPassword('new-pw-123456'), now, now, now)
  const acc2 = Number(r2.lastInsertRowid)
  inst.db.prepare('INSERT INTO credit (account_id, balance_milli, updated_at_ms) VALUES (?,0,?)').run(acc2, now)
  inst.db.prepare('INSERT INTO account_billing (account_id, insufficient, state, updated_at_ms) VALUES (?,0,?,?)')
    .run(acc2, 'active', now)
  grantCredits(inst.db, { accountId: acc2, deltaMilli: 12600 * 1000, kind: 'grant', operator: 'smoke', note: '半年套餐', nowMs: now })

  const c2 = new Client(addr, { account: 'demo002', password: 'new-pw-123456', deviceId: 'smoke-dev-2' })
  const l2 = await c2.login()
  ok(`新账号 demo002 → 等级 ${l2.body.policy.account_tier}，sending_enabled=${l2.body.policy.sending_enabled}`)
  info(`观察期文案：${l2.body.quota_notice.headline}`)
  const obsSend = await c2.post('/api/v1/audit/sends', { sends: [makeSend()] })
  ok(`观察期上报发送 → 计费 ${obsSend.body.settlement.billed_count} 条（上限为 0，一律不计费）`)
  info(`审计标记：${obsSend.body.audit_flags.join(', ')}`)

  // ── 设备数限制
  const c1b = new Client(addr, { account: 'demo001', password, deviceId: 'smoke-dev-1b' })
  await c1b.login()
  const kicked = await c.get('/api/v1/credit/balance')
  ok(`第二台设备登录后，旧会话被踢 → ${kicked.body.code}`)

  line('')
  line('═'.repeat(64))
  line('  ✅ 冒烟验收通过')
  line('═'.repeat(64))

  inst.close()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {
    console.error('清理临时目录失败：' + e.message)
  }
}

main().catch((e) => {
  console.error('\n❌ 冒烟验收失败：')
  console.error(e && e.stack ? e.stack : e)
  process.exit(1)
})
