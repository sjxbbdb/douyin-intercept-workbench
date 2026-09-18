'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const P = require(path.join(ROOT, 'shared', 'lib', 'protocol.js'))
const proto = fs.readFileSync(path.join(ROOT, 'shared', 'protocol.md'), 'utf8')

// 取出某段文档里所有反引号包裹的标识符（比泛匹配小写单词精确得多）
// ⚠️ 不要用 /`([a-z_]+)`/ 之外的宽松匹配：会把正文里的普通英文词也算成枚举值
function backticked(section) {
  return new Set([...section.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]))
}

// ---------- 1. 枚举与文档一致 ----------
test('契约：failure_reasons 闭集与 protocol.md §7.4 一致', () => {
  const section = proto.split('### 7.4')[1].split('###')[0]
  const documented = backticked(section)
  for (const r of P.FAILURE_REASONS) {
    assert.ok(documented.has(r), `failure_reasons 少了 ${r}（或文档拼写不同）`)
  }
  // ⚠️ 反向断言（protocol.md §7.4 明文规定）：
  //    editor_dismissed_unconfirmed 不是失败原因，它对应 sent_suspected。
  //    文档里出现它是**合法**的（否定语境），所以这里断言"文档明确禁止了它"，
  //    而不是"文档没提到它"——后者会把正确的文档判成失败（本项目实测踩过）。
  assert.ok(!P.FAILURE_REASONS.includes('editor_dismissed_unconfirmed'),
    'editor_dismissed_unconfirmed 不得出现在 failure_reasons 枚举里')
  assert.ok(/`editor_dismissed_unconfirmed`\s*不是失败原因/.test(section),
    '§7.4 必须保留"editor_dismissed_unconfirmed 不是失败原因"的明确否定说明')
})

test('契约：platform_endpoint 闭集与 protocol.md §4.8 一致', () => {
  const section = proto.split('### 4.8')[1].split('###')[0]
  for (const ep of P.PLATFORM_ENDPOINTS) {
    assert.ok(section.includes(ep), `platform_endpoint 白名单少了 ${ep}`)
  }
  // ⚠️ 白名单必须不含 scheme / 域名
  for (const ep of P.PLATFORM_ENDPOINTS) {
    assert.ok(!/^https?:/.test(ep), `${ep} 不得含 scheme`)
    assert.ok(!ep.includes('douyin.com'), `${ep} 不得含域名`)
  }
})

test('契约：verdict 口径与 protocol.md §7.2 一致', () => {
  const section = proto.split('### 7.2')[1].split('###')[0]
  const documented = backticked(section)

  // ⚠️ §7.2 的四级口径表只覆盖「一次发送尝试」的四种结果。
  const IN_72_TABLE = ['sent_confirmed', 'sent_confirmed_dom', 'sent_suspected', 'failed']
  for (const v of IN_72_TABLE) {
    assert.ok(documented.has(v), `§7.2 少了 ${v}`)
  }

  // ⚠️ verdict 闭集必须【恰好】是这四种，不得多也不得少。
  //    理由（protocol.md §7.1 + §7.2 约束）：
  //      · §7.2 约束 sent_confirmed + sent_confirmed_dom + sent_suspected + failed
  //        = reply_attempts，即 verdict 只描述"已发起的发送尝试"。
  //      · §7.1 定义 skipped = 命中但【未发起回复】（黑名单/额度满/频控/观察期禁发），
  //        它没有 send_id、不产生 send_log 行，只在 sources.<src>.skipped 计数。
  //    历史教训：曾把 skipped 混入 verdict 枚举，导致 §7.2 的求和约束与枚举自相矛盾。
  assert.deepStrictEqual(
    [...P.VERDICTS].sort(),
    [...IN_72_TABLE].sort(),
    'verdict 闭集必须恰好等于 §7.2 的四种；skipped 属于 SOURCE_COUNTERS，不属于 VERDICTS'
  )
  assert.ok(!P.VERDICTS.includes('skipped'),
    'skipped 不属于 verdict（无 send_id、不产生 send_log 行）')

  // skipped 必须由聚合计数承载，否则该指标会丢失
  assert.ok(P.SOURCE_COUNTERS.includes('skipped'),
    'skipped 必须由 SOURCE_COUNTERS 承载（§7.1）')

  // ⚠️ 钉死红线 2 的三条语义（原文断言，防止文档被削弱）
  assert.ok(section.includes('platform_status_code'),
    '§7.2 必须写明 sent_confirmed 需要 platform_status_code=0')
  assert.ok(section.includes('empty_response'),
    '§7.2 必须写明空响应 → risk_control_signal="empty_response"')
  assert.ok(/不得标记成功/.test(section),
    '§7.2 必须保留"空响应不得标记成功"的明文禁令')
})

// ---------- 2. 错误码 ----------
test('契约：错误码表可解析，且 HTTP 状态码符合契约', () => {
  const section = proto.split('### 3.2')[1].split('## 4.')[0]
  const rows = section.split('\n').filter((l) => l.startsWith('| `'))
  assert.ok(rows.length >= 30, `错误码表只有 ${rows.length} 行，可能格式被破坏`)

  const codes = {}
  for (const row of rows) {
    const m = row.match(/^\|\s*`([A-Z_]+)`\s*\|\s*(\d{3})\s*\|/)
    if (m) codes[m[1]] = Number(m[2])
  }
  // ⚠️ 这两处的状态码是最容易写错的，单独钉死
  assert.strictEqual(codes.POLICY_DAILY_CAP_EXCEEDED, 200, '超上限是 200（明细留痕），不是 4xx')
  assert.strictEqual(codes.POLICY_VIOLATION, 409)
  assert.strictEqual(codes.CREDIT_EXHAUSTED, 402)
  assert.strictEqual(codes.POLICY_SENDING_DISABLED, 409)
  assert.strictEqual(codes.AUDIT_SEND_CONFLICT, 409)
  assert.strictEqual(codes.SERVER_VERSION_UNSUPPORTED, 426)
})

test('契约：代码里出现的错误码都在契约表中', () => {
  const codeFiles = collectJsFiles(path.join(ROOT, 'license-server')).concat(collectJsFiles(path.join(ROOT, 'client')))
  const section = proto.split('### 3.2')[1].split('## 4.')[0]
  const known = new Set((section.match(/`([A-Z][A-Z_]{3,})`/g) || []).map((s) => s.replace(/`/g, '')))
  const offenders = []
  for (const f of codeFiles) {
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(/["']([A-Z][A-Z_]{3,})["']/g)) {
      const c = m[1]
      // 忽略非错误码的全大写常量
      if (!/^(AUTH|CREDIT|PLAN|POLICY|AUDIT|REPORT|SERVER|RATE)_/.test(c)) continue
      if (!known.has(c)) offenders.push(`${path.relative(ROOT, f)}: ${c}`)
    }
  }
  assert.deepStrictEqual(offenders, [], '发现契约表之外的错误码：\n' + offenders.join('\n'))
})

// ---------- 2b. 错误码 HTTP 状态双向一致 ----------
// ⚠️ 上一版测试只校验"代码里的码在契约表中存在"，**不校验状态码是否一致**。
//    实测漏掉过一次真实错误：errors.js 把 AUTH_REPLAY 标为 409，契约是 401。
//    状态码不一致会让客户端按错误的语义处理（如把"需重新登录"当成"参数非法"）。
test('契约：errors.js 的 HTTP 状态码与契约表逐项一致', () => {
  const { ERROR_CODES } = require('../../shared/lib/errors')
  const section = proto.split('### 3.2')[1].split('## 4.')[0]
  const rows = section.split('\n').filter((l) => l.startsWith('| `'))

  // 解析契约表：支持一行多个码（`A` / `B` | 401 |）
  const contract = {}
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim())
    if (cells.length < 4) continue
    const codesCell = cells[1]
    const statusCell = cells[2]
    if (!/^\d{3}$/.test(statusCell)) continue
    for (const m of codesCell.matchAll(/`([A-Z][A-Z_]{3,})`/g)) {
      contract[m[1]] = Number(statusCell)
    }
  }
  assert.ok(Object.keys(contract).length >= 25, `契约表解析出 ${Object.keys(contract).length} 个码，可能格式被破坏`)

  // 逐项比对：凡契约表登记的码，errors.js 的状态码必须一致
  const mismatched = []
  for (const [code, status] of Object.entries(ERROR_CODES)) {
    if (!(code in contract)) continue // 由上一个测试负责"码是否存在"
    if (contract[code] !== status) {
      mismatched.push(`${code}: errors.js=${status} 契约=${contract[code]}`)
    }
  }
  assert.deepStrictEqual(mismatched, [], '错误码 HTTP 状态与契约不一致：\n' + mismatched.join('\n'))
})

test('契约：errors.js 未登记的码不应在契约表中出现（反向检查）', () => {
  const { ERROR_CODES } = require('../../shared/lib/errors')
  const section = proto.split('### 3.2')[1].split('## 4.')[0]
  const rows = section.split('\n').filter((l) => l.startsWith('| `'))
  const missing = []
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim())
    if (cells.length < 4) continue
    if (!/^\d{3}$/.test(cells[2])) continue
    for (const m of cells[1].matchAll(/`([A-Z][A-Z_]{3,})`/g)) {
      const code = m[1]
      if (!/^(AUTH|CREDIT|PLAN|POLICY|AUDIT|REPORT|SERVER|RATE)_/.test(code)) continue
      if (!(code in ERROR_CODES)) missing.push(code)
    }
  }
  assert.deepStrictEqual(missing, [],
    '契约表登记了但 errors.js 未实现的错误码（客户端会收到未定义的码）：\n' + missing.join('\n'))
})

// ---------- 3. 数值唯一来源 ----------
test('契约：客户端不得硬编码策略数值（红线 1）', () => {
  const banned = [
    /\bdaily_?max\s*[:=]\s*\d+/,        // daily_max: 30
    /\bmin_?interval\w*\s*[:=]\s*\d+/,  // min_interval_ms: 60000
    /\b(0\.85|85)\b\s*(?:similarity|相似度)/,
    /\b12600\b/,                        // min_plan_credit
  ]
  const offenders = []
  for (const f of collectJsFiles(path.join(ROOT, 'client'))) {
    if (f.includes('selectors.js')) continue
    const src = fs.readFileSync(f, 'utf8')
    for (const re of banned) if (re.test(src)) offenders.push(`${path.relative(ROOT, f)} 命中 ${re}`)
  }
  assert.deepStrictEqual(offenders, [])
})

// ---------- 4. 选择器唯一来源（S-4） ----------
test('契约：data-e2e 只允许出现在 selectors.js', () => {
  const offenders = []
  for (const dir of ['client', 'license-server', 'shared']) {
    for (const f of collectJsFiles(path.join(ROOT, dir))) {
      if (f.includes(path.join('platform', 'selectors.js'))) continue
      const src = fs.readFileSync(f, 'utf8')
      if (/data-e2e|data-sec-uid|comment-list|comment-item/.test(src)) {
        offenders.push(path.relative(ROOT, f))
      }
    }
  }
  assert.deepStrictEqual(offenders, [], '选择器字符串散落在以下文件（违反 S-4）：\n' + offenders.join('\n'))
})

// ---------- 5. 空 catch（AGENTS.md §2.8） ----------
test('契约：不存在空 catch', () => {
  const offenders = []
  for (const dir of ['client', 'license-server', 'shared']) {
    for (const f of collectJsFiles(path.join(ROOT, dir))) {
      const src = fs.readFileSync(f, 'utf8')
      if (/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(src)) offenders.push(path.relative(ROOT, f))
    }
  }
  assert.deepStrictEqual(offenders, [], '发现空 catch（旧代码因此静默丢数据）：\n' + offenders.join('\n'))
})

// ---------- 6. 单写者（AGENTS.md §2.9） ----------
test('契约：writeFileSync 只允许出现在 host/store.js', () => {
  const offenders = []
  for (const f of collectJsFiles(path.join(ROOT, 'client'))) {
    if (f.endsWith(path.join('host', 'store.js'))) continue
    if (fs.readFileSync(f, 'utf8').includes('writeFileSync')) offenders.push(path.relative(ROOT, f))
  }
  assert.deepStrictEqual(offenders, [])
})

// ---------- 7. 绝对路径（D-1 阻断级缺陷） ----------
test('契约：不存在硬编码绝对路径', () => {
  const offenders = []
  for (const dir of ['client', 'license-server', 'shared']) {
    for (const f of collectJsFiles(path.join(ROOT, dir))) {
      const src = fs.readFileSync(f, 'utf8')
      if (/["'`][A-Za-z]:\\\\/.test(src) || /["'`]\/(home|root|var|opt)\//.test(src)) {
        offenders.push(path.relative(ROOT, f))
      }
    }
  }
  assert.deepStrictEqual(offenders, [], '硬编码绝对路径（旧代码阻断级缺陷 D-1）：\n' + offenders.join('\n'))
})

// ---------- 8. 白名单依赖 ----------
test('契约：package.json 只依赖 ws', () => {
  const pkgFile = path.join(ROOT, 'package.json')
  assert.ok(fs.existsSync(pkgFile), '缺少 package.json（应只声明 ws 依赖）')
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  const deps = Object.keys(pkg.dependencies || {})
  assert.deepStrictEqual(deps.filter((d) => d !== 'ws'), [], '引入了白名单外的依赖')
})

function collectJsFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'legacy') continue
      out.push(...collectJsFiles(p))
    } else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}