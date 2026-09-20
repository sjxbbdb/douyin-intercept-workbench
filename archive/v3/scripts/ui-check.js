'use strict'
// 一次性校验：把客户端起起来，抓取界面资源，检查关键结构。
// ⚠️ 用完即关：脚本结束前必须 close()，不留监听。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { EventEmitter } = require('node:events')

const ROOT = path.join(__dirname, '..')

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-'))
  const instanceId = 'uicheck'
  const instanceDir = path.join(workspace, 'instances', instanceId)
  fs.mkdirSync(instanceDir, { recursive: true })
  fs.writeFileSync(path.join(instanceDir, 'client-config.json'), JSON.stringify({
    uiPort: 0, uiHost: '127.0.0.1', licenseBaseUrl: 'http://127.0.0.1:1', logLevel: 'error',
  }), 'utf8')

  const main = require(path.join(ROOT, 'client', 'host', 'main.js'))
  const fakeChild = () => {
    const c = new EventEmitter()
    c.pid = 999999; c.killed = false
    c.kill = () => { c.killed = true; return true }
    c.unref = () => c
    return c
  }
  const app = await main.bootstrap({
    workspace, instanceId,
    spawnImpl: fakeChild,
    probePortImpl: async () => false,
    getJsonImpl: async (u) => String(u).includes('/json/version')
      ? { Browser: 'Chrome/fake', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/x' }
      : { ok: true },
    cdpFactory: () => ({
      async connect() { return this }, async close() {}, on() {}, off() {}, onLifecycle() {},
      async send() { return {} }, async dispatchMouseClick() { return { ok: true } }, sessionIdOf() { return null },
    }),
  })

  const base = `http://127.0.0.1:${app.api.port}`
  const token = fs.readFileSync(path.join(instanceDir, 'ui-token.txt'), 'utf8').trim()

  const html = await (await fetch(`${base}/`)).text()
  const js = await (await fetch(`${base}/app.js`)).text()
  const css = await (await fetch(`${base}/app.css`)).text()
  const state = await (await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${token}` } })).json()

  const report = []
  const ok = (n, c, d) => report.push({ ok: Boolean(c), n, d })

  // ── HTML 结构 ──────────────────────────────────────────────
  ok('HTML 有 <!DOCTYPE html>', /^\s*<!DOCTYPE html>/i.test(html))
  ok('声明了 UTF-8', /charset=["']?utf-8/i.test(html))
  ok('引用了 app.css', html.includes('app.css'))
  ok('引用了 app.js', html.includes('app.js'))
  ok('有急停按钮元素', /emergency|急停/i.test(html))
  ok('有面板容器', /panel|面板/i.test(html))
  // ⚠️ 这两条检查必须**先剥注释**。HTML 的说明性注释里写着
  //    "原生 DOM，无框架、无构建、无 CDN"，直接扫全文会把那句
  //    **自我约束**判成违规——和契约测试里踩过的是同一个坑。
  const htmlCode = html.replace(/<!--[\s\S]*?-->/g, ' ')
  const jsCode = js.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')

  ok('HTML 没有外部资源引用（离线可用）',
    !/(https?:)?\/\/(?!127\.0\.0\.1|localhost)/.test(htmlCode))
  ok('没有 CDN 引用（注释不算）', !/cdn|unpkg|jsdelivr|googleapis/i.test(htmlCode + jsCode))

  // ── CSS 设计 token ─────────────────────────────────────────
  ok('CSS 有 :root 设计 token', /:root\s*\{/.test(css))
  ok('CSS 有暗色背景变量', /--[\w-]*(bg|background)[\w-]*\s*:/.test(css))
  ok('CSS 有等宽/数字字体族（看板数字对齐）', /font-family/.test(css))

  // ── JS 行为 ────────────────────────────────────────────────
  ok('JS 注册了 Esc 急停快捷键', /Escape/.test(jsCode))
  ok('JS 注册了 1-9 面板切换', /PANELS\[Number\(ev\.key\)\s*-\s*1\]|\^\[1-9\]\$/.test(jsCode))
  ok('JS 有 Ctrl+K 命令面板', /ctrlKey[\s\S]{0,80}'k'/i.test(jsCode) || /ctrlKey[\s\S]{0,80}"k"/i.test(jsCode))
  ok('JS 用 fetch 轮询 /api/state', jsCode.includes('/api/state'))
  ok('JS 走 2 秒轮询常量', /2000|POLL_INTERVAL/.test(jsCode))
  ok('JS 处理 null 成功率（显示 —）', jsCode.includes('—'))
  ok('JS 有"暂无数据"空态文案', jsCode.includes('暂无数据'))
  ok('JS 不直接读数据文件', !/readFileSync|node:fs/.test(jsCode))

  // ── 看板零算术（口径只有 shared/lib/stats.js 一份）──────────
  const noComment = jsCode
  ok('JS 不做 * 100 这类百分比换算', !/\*\s*100\b/.test(noComment))
  ok('JS 不做 / 1000 这类单位换算', !/\/\s*1000\b/.test(noComment))
  ok('JS 不自己算成功率（不出现 / reply_attempts）', !/\/\s*[a-zA-Z_.]*reply_attempts/.test(noComment))

  // ── API 契约 ───────────────────────────────────────────────
  ok('/api/state 返回 dashboard', Boolean(state.dashboard))
  ok('/api/state 返回 trend', Array.isArray(state.trend))
  ok('/api/state 返回 alerts 数组', Array.isArray(state.alerts))
  ok('/api/state 有 license 且不含 token 原文', Boolean(state.license) && !JSON.stringify(state).includes(token))
  ok('额度文案未登录时为 null（不编文案）', state.quota_notice === null || state.quota_notice === undefined)
  ok('未登录时 alerts 里说明未登录', state.alerts.some((a) => /未登录|login/i.test(JSON.stringify(a))))
  ok('守卫快照可展示', Boolean(state.guard && state.guard.limits))
  ok('引擎状态可展示', Boolean(state.engine && typeof state.engine.state === 'string'))

  // ── 输出 ───────────────────────────────────────────────────
  console.log('\n===== 界面结构与契约检查 =====')
  for (const r of report) console.log(`  ${r.ok ? '✓' : '✗'} ${r.n}${r.d ? ' → ' + r.d : ''}`)
  const bad = report.filter((r) => !r.ok)
  console.log(`\n  ${report.length - bad.length}/${report.length} 通过`)

  if (bad.length) {
    console.log('\n--- 未通过项 ---')
    for (const b of bad) console.log('  ✗ ' + b.n)
  }

  console.log('\n--- /api/state 前 40 行 ---')
  console.log(JSON.stringify(state, null, 2).split('\n').slice(0, 40).join('\n'))

  await app.api.close()
  await app.browserHost.close({ silent: true })
  app.store.close()
  try { fs.rmSync(workspace, { recursive: true, force: true }) } catch (e) { console.log('清理失败:', e.message) }

  // ⚠️ 用 `process.exitCode` 而**不是** `process.exit()`。
  //
  //    踩过的坑：全部断言都过了，进程却间歇性地以
  //    `-1073740791`（0xC0000409，Windows 上的栈缓冲溢出/快速失败）结束，
  //    看起来像"检查失败"。真实原因是 `process.exit()` 在
  //    `browserHost.close()` 刚释放句柄时被调用，命中了 libuv 的收尾竞态：
  //    `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`。
  //    同一个坑在 `ui-render-check.js` 里也踩过一次。
  //
  //    设 `exitCode` 后让事件循环自然结束，句柄有机会正常释放；
  //    代价是如果有句柄没被释放，进程会挂着不退——而这**恰好是更有用的
  //    失败信号**（"有东西没关干净"），比一个假的成功/失败码好得多。
  await sleep(200)
  process.exitCode = bad.length ? 1 : 0
  return
}

function sleep(ms) {
  return new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref() })
}

main().catch((e) => {
  console.error('[fatal]', e)
  process.exitCode = 1
})
