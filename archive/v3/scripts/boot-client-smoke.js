'use strict'
// scripts/boot-client-smoke.js
//
// 客户端**启动冒烟**：不起真 Chrome、不连真授权中心，只验证
// "装配顺序对不对、本地控制台能不能起来、未登录时是否可用"。
//
// ⚠️ 这个脚本存在的理由：`client/host/main.js` 是全项目唯一"把各层接起来"
//    的地方，而**接线错误在单元测试里看不出来**——每层各自都绿，
//    拼起来却可能因为参数名不一致（如 `createApi` vs `create_local_api`）
//    或漏传依赖而直接崩。
//
// ⚠️ 它**不能**替代真机验证（AGENTS.md §6）：这里没有任何真实的抖音
//    页面操作，所以"采集/回复能不能用"不在本脚本的结论范围内。

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const ROOT = path.join(__dirname, '..')
const results = []

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => { results.push({ ok: true, name, detail }); })
    .catch((e) => { results.push({ ok: false, name, error: e && e.message, stack: e && e.stack }) })
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts)
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch (e) {
    // 非 JSON 响应（静态资源）—— 调用方自己看 text
    body = null
  }
  return { status: res.status, headers: res.headers, text, body }
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-boot-'))
  const instanceId = 'smoke'
  const instanceDir = path.join(workspace, 'instances', instanceId)
  fs.mkdirSync(instanceDir, { recursive: true })

  // ⚠️ 把专用 Chrome 的 profile 目录预置成"已存在"，并给一个假的
  //    chromePath —— 目的是让 `BrowserHost.create` 走到"探测端口 → 起进程"
  //    之前就被我们的替身拦住，而不是真的去 spawn 一个浏览器。
  const fakeChrome = path.join(workspace, 'fake-chrome.exe')
  fs.writeFileSync(fakeChrome, '#!/bin/sh\nexit 0\n', 'utf8')

  fs.writeFileSync(path.join(instanceDir, 'client-config.json'), JSON.stringify({
    uiPort: 0,                 // 0 = 让系统分配，避免与开发机上的端口冲突
    uiHost: '127.0.0.1',
    licenseBaseUrl: 'http://127.0.0.1:1', // 故意指向一个必然连不上的地址
    chromePath: fakeChrome,
    logLevel: 'error',
  }, null, 2), 'utf8')

  const main = require(path.join(ROOT, 'client', 'host', 'main.js'))

  // ── 平台层替身 ──────────────────────────────────────────────
  // ⚠️ 本脚本的目标是验证**装配顺序与本地控制台**，不是验证 Chrome 集成。
  //    所以这里把"起浏览器"整条链路换成确定性的替身：
  //      · probePortImpl 永远说"端口空闲"（否则会去找真实 Chrome）
  //      · spawnImpl 返回一个假的 child（有 pid/kill，不会真的起进程）
  //      · getJsonImpl 直接给出 /json/version 的形态
  //      · cdpFactory 给出一个已连接的假 CDP
  //    这样 `BrowserHost.start()` 会走完整流程（拿锁、建标签页角色表、
  //    连 CDP），但一步都不碰真实浏览器。
  const { EventEmitter } = require('node:events')
  const fakeChromeChild = () => {
    const child = new EventEmitter()
    child.pid = 999999
    child.killed = false
    child.kill = () => { child.killed = true; return true }
    child.unref = () => child
    // 让"进程退出"永不发生：真 Chrome 重启会让标签页失联，
    // 那不是本脚本要测的东西。
    return child
  }
  const fakeCdp = () => ({
    connected: false,
    async connect() { this.connected = true; return this },
    async close() { this.connected = false },
    on() {}, off() {}, onLifecycle() {},
    async send() { return {} },
    async dispatchMouseClick() { return { ok: true } },
    sessionIdOf() { return null },
    get pendingCount() { return 0 },
  })

  let app = null
  let bootstrapErr = null

  await check('装配（bootstrap）成功', async () => {
    try {
      app = await main.bootstrap({
        workspace, instanceId,
        spawnImpl: fakeChromeChild,
        probePortImpl: async () => false, // 端口空闲 → 走"启动 Chrome"分支
        getJsonImpl: async (url) => {
          if (String(url).includes('/json/version')) {
            return { Browser: 'Chrome/fake-smoke', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/fake' }
          }
          return { ok: true }
        },
        cdpFactory: fakeCdp,
      })
    } catch (e) {
      bootstrapErr = e
      throw e
    }
    if (!app) throw new Error('bootstrap 返回空')
    return { instance_id: app.config.instanceId, ui_port: app.api ? app.api.port : null }
  })

  if (!app) {
    report(workspace)
    return
  }

  await check('本地 API 已监听且绑定回环', async () => {
    const d = app.api.describe()
    if (!d.loopback_asserted) throw new Error(`未断言回环：${JSON.stringify(d)}`)
    if (!(app.api.port > 0)) throw new Error(`端口非法：${app.api.port}`)
    return { url: d.url || d.url_base, port: app.api.port }
  })

  const base = `http://127.0.0.1:${app.api.port}`
  const token = fs.readFileSync(path.join(instanceDir, 'ui-token.txt'), 'utf8').trim()

  await check('令牌文件已生成（32 字节 hex）', async () => {
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(`令牌形态不对：${token.slice(0, 8)}…`)
    return { length: token.length }
  })

  await check('GET /healthz 无需令牌', async () => {
    const r = await fetchJson(`${base}/healthz`)
    if (r.status !== 200) throw new Error(`状态 ${r.status}`)
    return { status: r.status, ok: r.body && r.body.ok }
  })

  await check('GET /api/state 无令牌 → 401', async () => {
    const r = await fetchJson(`${base}/api/state`)
    if (r.status !== 401) throw new Error(`应为 401，实际 ${r.status}`)
    return { status: r.status }
  })

  await check('GET /api/state 带令牌 → 200 且不含敏感字段', async () => {
    const r = await fetchJson(`${base}/api/state`, { headers: { Authorization: `Bearer ${token}` } })
    if (r.status !== 200) throw new Error(`状态 ${r.status}：${r.text.slice(0, 200)}`)
    if (r.text.includes(token)) throw new Error('响应里出现了令牌原文')
    if (r.text.includes('sign_key')) throw new Error('响应里出现了 sign_key')
    const b = r.body
    return {
      engine: b.engine ? b.engine.state : null,
      logged_in: b.license ? b.license.logged_in : null,
      alerts: b.alerts || [],
      dashboard_empty: b.dashboard ? b.dashboard.empty : null,
    }
  })

  await check('看板成功率分母为 0 时显示 —（不是 100%）', async () => {
    const r = await fetchJson(`${base}/api/state`, { headers: { Authorization: `Bearer ${token}` } })
    const d = r.body && r.body.dashboard
    if (!d) throw new Error('响应里没有 dashboard')
    const shown = d.display && d.display.回复成功率显示
    if (shown !== '—') throw new Error(`未登录无数据时应显示 —，实际 ${JSON.stringify(shown)}`)
    return { 回复成功率显示: shown, empty: d.empty }
  })

  await check('额度文案为服务端原文（红线 1 要求逐字展示）', async () => {
    const r = await fetchJson(`${base}/api/state`, { headers: { Authorization: `Bearer ${token}` } })
    const qn = r.body && r.body.quota_notice
    // 未登录时服务端还没下发，此时应为 null（而不是编一段文案出来）
    if (qn !== null && qn !== undefined) {
      if (typeof qn.headline !== 'string') throw new Error('quota_notice 形态不对')
    }
    return { quota_notice: qn === null || qn === undefined ? null : qn.headline, note: '未登录时为 null 是正确的' }
  })

  await check('急停在**未登录**状态下可用（红线：唯一有保障的停机手段）', async () => {
    const r = await fetchJson(`${base}/api/emergency-stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: true, reason: 'boot-smoke' }),
    })
    if (r.status !== 200) throw new Error(`状态 ${r.status}：${r.text.slice(0, 200)}`)
    const g = app.guard.snapshot()
    if (g.emergency_stop !== true) throw new Error('护栏里的急停没有真的打开')
    // 复位，避免影响后续断言
    await fetchJson(`${base}/api/emergency-stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: false }),
    })
    if (app.guard.snapshot().emergency_stop !== false) throw new Error('急停无法复位')
    return { on_then_off: true }
  })

  await check('未登录时引擎保持停机（无策略 → fail-closed）', async () => {
    const snap = app.scheduler.snapshot()
    if (snap.state === 'running') throw new Error('未登录却启动了调度器（无策略时不该空转）')
    return { state: snap.state }
  })

  await check('坏 Origin 被拒绝（跨站调用防护）', async () => {
    const r = await fetchJson(`${base}/api/state`, {
      headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example.com' },
    })
    if (r.status === 200) throw new Error('白名单外的 Origin 竟然拿到了 200')
    return { status: r.status }
  })

  await check('静态资源可访问（界面能加载）', async () => {
    const idx = await fetchJson(`${base}/`)
    if (idx.status !== 200) throw new Error(`/ 返回 ${idx.status}`)
    if (!idx.text.includes('<!')) throw new Error('/ 不是 HTML')
    const js = await fetchJson(`${base}/app.js`)
    if (js.status !== 200) throw new Error(`/app.js 返回 ${js.status}`)
    const css = await fetchJson(`${base}/app.css`)
    if (css.status !== 200) throw new Error(`/app.css 返回 ${css.status}`)
    return { html: idx.text.length, js: js.text.length, css: css.text.length }
  })

  await check('未知路由 → 结构化 501/404（绝不是 200 + 空对象）', async () => {
    const r = await fetchJson(`${base}/api/nonexistent`, { headers: { Authorization: `Bearer ${token}` } })
    if (r.status === 200) throw new Error('未知路由返回了 200')
    return { status: r.status, has_code: Boolean(r.body && r.body.code) }
  })

  await check('优雅退出：幂等且不抛', async () => {
    const shutdown = main.makeShutdown(app)
    await shutdown('boot-smoke')
    await shutdown('boot-smoke-again') // 第二次必须直接返回，不能重跑清理
    return { idempotent: true }
  })

  report(workspace)
}

function report(workspace) {
  const okCount = results.filter((r) => r.ok).length
  console.log('\n' + '='.repeat(64))
  console.log('  客户端启动冒烟')
  console.log('='.repeat(64))
  for (const r of results) {
    if (r.ok) {
      console.log(`  ✓ ${r.name}`)
      if (r.detail) console.log(`      ${JSON.stringify(r.detail)}`)
    } else {
      console.log(`  ✗ ${r.name}`)
      console.log(`      ${r.error}`)
    }
  }
  console.log('='.repeat(64))
  console.log(`  ${okCount}/${results.length} 项通过`)

  if (okCount !== results.length) {
    for (const r of results.filter((x) => !x.ok)) {
      if (r.stack) console.log(`\n[${r.name}]\n${r.stack}`)
    }
    console.log('\n  ❌ 启动冒烟未通过')
  } else {
    console.log('\n  ✅ 启动冒烟通过')
    console.log('  ⚠️ 注意：本脚本**不覆盖**任何真实抖音页面操作。')
    console.log('     采集/回复的可用性必须真机验证（AGENTS.md §6 完成定义）。')
  }
  try { fs.rmSync(workspace, { recursive: true, force: true }) } catch (e) {
    console.log(`  （临时目录未清理：${e.message}）`)
  }
  process.exit(okCount === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error('[fatal] 冒烟脚本自身异常：', e)
  process.exit(1)
})
