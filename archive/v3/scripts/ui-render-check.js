'use strict'
// scripts/ui-render-check.js
//
// 界面**真实渲染**检查：用无头 Chrome 打开本地控制台，收集
// console 错误 / 未捕获异常 / 失败请求，并断言关键 DOM 真的被构建出来了。
//
// ⚠️ 为什么单独一个脚本：`ui-check.js` 只做静态扫描（源码里有没有某段逻辑），
//    而"DOM 构建代码在浏览器里执行时是否抛错"它一概看不出来。
//    本项目的界面是**手写 DOM**（无框架），这类代码最容易在运行时报错
//    （访问了 null、事件绑定顺序错、渲染函数早于数据到达被调用），
//    而静态扫描对这些完全无感。
//
// ⚠️ 它仍然**不是**真机验证：这里没有真实抖音账号，也没有真实授权中心。
//    它验证的是"界面能在浏览器里无错地完成首屏渲染与轮询"。
//
// 用法：node scripts/ui-render-check.js [--keep-open]

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')

const ROOT = path.join(__dirname, '..')

const CHROME_CANDIDATES = [
  process.env.REPLY_CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

function findBrowser() {
  for (const c of CHROME_CANDIDATES) {
    if (!c) continue
    try { if (fs.existsSync(c)) return c } catch (e) {
      // 探测系统目录时可能遇到权限拒绝；继续试下一个候选即可，但计数留痕。
      findBrowser.denied = (findBrowser.denied || 0) + 1
    }
  }
  return null
}

/**
 * 极简 CDP over WebSocket —— 只为本脚本服务，不复用生产实现。
 *
 * ⚠️ 这里**刻意不 require('ws')**：`ws` 是本项目唯一的第三方依赖，
 *    而它只在"真机跑客户端"时才需要。开发机上 `node_modules` 往往是空的，
 *    于是 `require('ws')` 会让这个校验脚本直接跑不起来——而"跑不起来"
 *    比"跑起来发现没问题"更糟，因为它会静默地不提供任何验证。
 *    所以这里用 `node:http` 手写最小 WebSocket 客户端：
 *    只支持 CDP 需要的三种帧（文本、ping、close），不做压缩与扩展协商。
 */
function makeCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const http = require('node:http')
    const crypto = require('node:crypto')
    const u = new URL(wsUrl)
    const key = crypto.randomBytes(16).toString('base64')

    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        Host: `${u.hostname}:${u.port || 80}`,
      },
    })

    let id = 0
    const pending = new Map()
    const listeners = []
    let sock = null
    let buf = Buffer.alloc(0)
    let closed = false

    const api = {
      events: [],
      on(fn) { listeners.push(fn) },
      send(method, params) {
        return new Promise((res, rej) => {
          const msgId = ++id
          pending.set(msgId, { res, rej })
          writeText(JSON.stringify({ id: msgId, method, params: params || {} }))
          const t = setTimeout(() => {
            if (pending.has(msgId)) { pending.delete(msgId); rej(new Error(`CDP 超时：${method}`)) }
          }, 20000)
          if (t.unref) t.unref()
        })
      },
      close() {
        if (closed) return
        closed = true
        try { if (sock) sock.destroy() } catch (e) { void e }
      },
    }

    function writeFrame(opcode, payload) {
      if (!sock || closed) return
      const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
      const len = data.length
      let header
      // ⚠️ 客户端发出的帧必须**掩码**（RFC 6455），否则服务端直接断连。
      const mask = crypto.randomBytes(4)
      if (len < 126) {
        header = Buffer.alloc(2)
        header[1] = 0x80 | len
      } else if (len < 65536) {
        header = Buffer.alloc(4)
        header[1] = 0x80 | 126
        header.writeUInt16BE(len, 2)
      } else {
        header = Buffer.alloc(10)
        header[1] = 0x80 | 127
        header.writeBigUInt64BE(BigInt(len), 2)
      }
      header[0] = 0x80 | opcode
      const masked = Buffer.allocUnsafe(len)
      for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4]
      sock.write(Buffer.concat([header, mask, masked]))
    }
    function writeText(s) { writeFrame(0x1, s) }

    /** 解帧。只处理"服务端→客户端"的帧（无掩码）。 */
    function pump() {
      for (;;) {
        if (buf.length < 2) return
        const b0 = buf[0]
        const b1 = buf[1]
        const opcode = b0 & 0x0f
        const masked = (b1 & 0x80) !== 0
        let len = b1 & 0x7f
        let off = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2); off = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          len = Number(buf.readBigUInt64BE(2)); off = 10
        }
        let maskKey = null
        if (masked) {
          if (buf.length < off + 4) return
          maskKey = buf.slice(off, off + 4); off += 4
        }
        if (buf.length < off + len) return
        let payload = buf.slice(off, off + len)
        if (maskKey) {
          const d = Buffer.from(payload)
          for (let i = 0; i < d.length; i++) d[i] ^= maskKey[i % 4]
          payload = d
        }
        buf = buf.slice(off + len)

        if (opcode === 0x8) { api.close(); return }
        if (opcode === 0x9) { writeFrame(0xA, payload); continue } // ping → pong
        if (opcode === 0x1) {
          let m = null
          try { m = JSON.parse(payload.toString('utf8')) } catch (e) { continue }
          if (m.id && pending.has(m.id)) {
            const { res, rej } = pending.get(m.id)
            pending.delete(m.id)
            if (m.error) rej(new Error(String(m.error.message)))
            else res(m.result)
            continue
          }
          if (m.method) {
            api.events.push(m)
            for (const fn of listeners) {
              try { fn(m) } catch (e) {
                // 监听器抛错不能影响协议循环，但必须让人看到。
                process.stderr.write(`[cdp] 事件监听器抛错：${e.message}\n`)
              }
            }
          }
        }
      }
    }

    req.on('upgrade', (res, socket) => {
      if (res.headers['sec-websocket-accept'] === undefined) {
        reject(new Error('WebSocket 握手失败：缺少 Sec-WebSocket-Accept'))
        return
      }
      sock = socket
      sock.on('data', (d) => { buf = Buffer.concat([buf, d]); pump() })
      sock.on('close', () => { closed = true })
      sock.on('error', (e) => {
        for (const { rej } of pending.values()) rej(e)
        pending.clear()
      })
      resolve(api)
    })
    req.on('error', reject)
    req.end()
  })
}

async function getJson(url) {
  const res = await fetch(url)
  return res.json()
}

async function main() {
  const keepOpen = process.argv.includes('--keep-open')
  const browserPath = findBrowser()
  if (!browserPath) {
    console.log('  ⏭ 未找到 Chrome/Edge，跳过真实渲染检查（不算失败）')
    process.exit(0)
  }

  // ── 起客户端（平台层用替身，不碰真 Chrome）──────────────────
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-render-'))
  const instanceId = 'render'
  const instanceDir = path.join(workspace, 'instances', instanceId)
  fs.mkdirSync(instanceDir, { recursive: true })
  fs.writeFileSync(path.join(instanceDir, 'client-config.json'), JSON.stringify({
    uiPort: 0, uiHost: '127.0.0.1', licenseBaseUrl: 'http://127.0.0.1:1', logLevel: 'error',
  }), 'utf8')

  const mainMod = require(path.join(ROOT, 'client', 'host', 'main.js'))
  const fakeChild = () => {
    const c = new EventEmitter()
    c.pid = 999999; c.killed = false
    c.kill = () => { c.killed = true; return true }
    c.unref = () => c
    return c
  }
  const app = await mainMod.bootstrap({
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

  const pageUrl = `http://127.0.0.1:${app.api.port}/?token=${fs.readFileSync(path.join(instanceDir, 'ui-token.txt'), 'utf8').trim()}`

  // ── 起无头浏览器 ────────────────────────────────────────────
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-render-profile-'))
  const debugPort = 19333
  const child = spawn(browserPath, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync',
    'about:blank',
  ], { stdio: 'ignore', detached: false })

  const cleanup = async () => {
    try { child.kill() } catch (e) { void e }
    try { await app.api.close() } catch (e) { void e }
    try { await app.browserHost.close({ silent: true }) } catch (e) { void e }
    try { app.store.close() } catch (e) { void e }
    for (const d of [workspace, profile]) {
      try { fs.rmSync(d, { recursive: true, force: true }) } catch (e) { void e }
    }
  }

  const problems = []
  const notes = []

  try {
    // 等调试端口就绪
    let version = null
    for (let i = 0; i < 60; i++) {
      try { version = await getJson(`http://127.0.0.1:${debugPort}/json/version`); break } catch (e) { await sleep(250) }
    }
    if (!version) throw new Error('无头浏览器调试端口未就绪')

    const targets = await getJson(`http://127.0.0.1:${debugPort}/json/list`)
    const page = targets.find((t) => t.type === 'page')
    if (!page) throw new Error('没有可用的页面目标')

    const cdp = await makeCdp(page.webSocketDebuggerUrl)

    const consoleErrors = []
    const exceptions = []
    const failedRequests = []
    const requestUrls = []

    cdp.on((m) => {
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || a.type).join(' '))
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {}
        exceptions.push(d.exception ? (d.exception.description || d.exception.value) : d.text)
      }
      if (m.method === 'Network.loadingFailed') {
        failedRequests.push({ id: m.params.requestId, err: m.params.errorText })
      }
      if (m.method === 'Network.requestWillBeSent') {
        requestUrls.push(m.params.request.url)
      }
    })

    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    await cdp.send('Page.enable')
    await cdp.send('Page.navigate', { url: pageUrl })

    // 等首屏 + 至少两轮轮询（2 秒一轮）
    await sleep(6500)

    const evalJs = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate 抛错')
      return r.result.value
    }

    // ── 断言：关键 DOM 真的被构建了 ─────────────────────────
    const probe = await evalJs(`(function(){
      var tabs = document.querySelectorAll('#tabs .tab');
      var panels = document.querySelectorAll('.panel');
      var visiblePanels = 0;
      for (var i=0;i<panels.length;i++){ if(!panels[i].hidden) visiblePanels++; }
      var bodyText = document.body.innerText || '';
      return {
        tab_count: tabs.length,
        panel_count: panels.length,
        visible_panels: visiblePanels,
        has_emergency_button: /急停/.test(bodyText),
        has_empty_state: /暂无数据/.test(bodyText),
        has_dash: bodyText.indexOf('\\u2014') >= 0,
        body_len: bodyText.length,
        title: document.title,
        js_loaded: typeof window.__UI_LOADED__ !== 'undefined' || tabs.length > 0
      };
    })()`)

    if (!(probe.tab_count >= 9)) problems.push(`标签页只有 ${probe.tab_count} 个（期望 ≥9）`)
    if (!(probe.panel_count >= 9)) problems.push(`面板只有 ${probe.panel_count} 个（期望 ≥9）`)
    if (probe.visible_panels !== 1) problems.push(`可见面板数 ${probe.visible_panels}（期望恰好 1）`)
    if (!probe.has_emergency_button) problems.push('页面上找不到「急停」')
    if (probe.body_len < 200) problems.push(`正文太短（${probe.body_len} 字符），疑似渲染失败`)

    // ── 断言：点击标签页能切换面板 ──────────────────────────
    const switched = await evalJs(`(function(){
      var tabs = Array.from(document.querySelectorAll('#tabs .tab'));
      if (tabs.length < 3) return { ok:false, reason:'tabs_too_few' };
      tabs[2].click();
      var panels = Array.from(document.querySelectorAll('.panel'));
      var vis = panels.filter(function(p){ return !p.hidden; });
      return { ok: vis.length === 1 && vis[0].getAttribute('data-panel') === tabs[2].getAttribute('data-panel'),
               visible: vis.length ? vis[0].getAttribute('data-panel') : null,
               want: tabs[2].getAttribute('data-panel') };
    })()`)
    if (!switched.ok) problems.push(`点击标签页未能切换面板：${JSON.stringify(switched)}`)

    // ── 断言：Esc 能触发急停（并复位）───────────────────────
    // ⚠️ 这条检查有三个容易误判的地方，所以断言方式刻意分成三步：
    //    ① 先确认按下 Esc 之前**确实是停的**（否则可能上一轮遗留了状态）
    //    ② 按下 Esc 后，等"请求发出"（用 Network 事件观察，
    //       而不是猜一个 sleep 秒数——猜短了会误判成"急停不生效"）
    //    ③ 等状态真正翻过来（轮询直到超时），而不是固定等 1.2 秒
    const token0 = new URLSearchParams(pageUrl.split('?')[1]).get('token')
    const guardBefore = await evalJs(`fetch('/api/state', { headers: { 'X-UI-Token': ${JSON.stringify(token0)} } })
      .then(function(r){ return r.json() }).then(function(j){ return !!(j.guard && j.guard.emergency_stop) })`)

    const reqSeen = { emergencyStopPosted: false }
    cdp.on((m) => {
      if (m.method === 'Network.requestWillBeSent'
          && /\/api\/emergency-stop/.test(m.params.request.url)) {
        reqSeen.emergencyStopPosted = true
      }
    })

    await evalJs(`(function(){
      document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true }));
      return true;
    })()`)

    // 等请求发出（最多 3 秒）
    for (let i = 0; i < 15 && !reqSeen.emergencyStopPosted; i++) await sleep(200)

    // 等状态翻转（最多 5 秒）
    let guardAfter = guardBefore
    for (let i = 0; i < 25 && guardAfter === guardBefore; i++) {
      await sleep(200)
      guardAfter = await evalJs(`fetch('/api/state', { headers: { 'X-UI-Token': ${JSON.stringify(token0)} } })
        .then(function(r){ return r.json() }).then(function(j){ return !!(j.guard && j.guard.emergency_stop) })`)
    }

    if (!reqSeen.emergencyStopPosted) {
      problems.push('按 Esc 后没有发出 /api/emergency-stop 请求 —— 快捷键没生效')
    } else if (guardAfter !== !guardBefore) {
      problems.push(`Esc 发出了急停请求但状态没翻转（前 ${guardBefore} / 后 ${guardAfter}）`)
    } else {
      notes.push(`Esc 急停生效（${guardBefore} → ${guardAfter}），已通过 API 复位`)
      await fetch(`http://127.0.0.1:${app.api.port}/api/emergency-stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-UI-Token': token0 },
        body: JSON.stringify({ on: false }),
      })
      const back = await evalJs(`fetch('/api/state', { headers: { 'X-UI-Token': ${JSON.stringify(token0)} } })
        .then(function(r){ return r.json() }).then(function(j){ return !!(j.guard && j.guard.emergency_stop) })`)
      if (back !== false) problems.push('急停无法复位 —— 界面会卡在停机态')
    }

    // ── 断言：没有 console 错误 / 未捕获异常 ────────────────
    if (exceptions.length) problems.push(`未捕获异常 ${exceptions.length} 条：${exceptions.slice(0, 3).join(' | ')}`)
    if (consoleErrors.length) problems.push(`console.error ${consoleErrors.length} 条：${consoleErrors.slice(0, 3).join(' | ')}`)

    // ── 断言：所有请求都是本地地址 ──────────────────────────
    const external = requestUrls.filter((u) => !/^http:\/\/127\.0\.0\.1:/.test(u) && !/^data:/.test(u) && !/^about:/.test(u))
    if (external.length) problems.push(`发出了非本地请求：${external.slice(0, 3).join(' | ')}`)

    const realFailures = failedRequests.filter((f) => !/net::ERR_ABORTED/.test(f.err))
    if (realFailures.length) notes.push(`有 ${realFailures.length} 个网络请求失败（多为 favicon 之类，非阻断）`)

    // ── 输出 ─────────────────────────────────────────────────
    console.log('\n' + '='.repeat(64))
    console.log('  界面真实渲染检查（无头 ' + path.basename(browserPath) + '）')
    console.log('='.repeat(64))
    console.log(`  标签页 ${probe.tab_count} 个 · 面板 ${probe.panel_count} 个 · 可见 ${probe.visible_panels} 个`)
    console.log(`  标题：${probe.title}`)
    console.log(`  正文长度：${probe.body_len} 字符`)
    console.log(`  本地请求：${requestUrls.filter((u) => /^http:\/\/127\.0\.0\.1:/.test(u)).length} 条`)
    for (const n of notes) console.log(`  · ${n}`)

    if (problems.length) {
      console.log('\n  ❌ 发现问题：')
      for (const p of problems) console.log(`    ✗ ${p}`)
    } else {
      console.log('\n  ✅ 界面在真实浏览器里无错渲染：')
      console.log('     · 9 个面板与标签页已构建，恰好 1 个可见')
      console.log('     · 点击标签页能切换面板')
      console.log('     · 无未捕获异常、无 console.error')
      console.log('     · 所有请求都是本地地址（离线可用）')
    }
    if (keepOpen) {
      console.log('\n  --keep-open：保持浏览器打开 60 秒供人工查看')
      await sleep(60000)
    }

    cdp.close()
    // ⚠️ 给 socket 一点时间真正关掉再清理。
    //    踩过的坑：`cdp.close()` 之后立刻 `child.kill()` + `process.exit()`，
    //    在 Windows 上会命中 libuv 的
    //    `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
    //    ——进程在**已经成功完成全部检查之后**异常退出（exit code 1），
    //    看起来像"检查失败"，实际是清理阶段的收尾竞态。
    //    正确做法是：等一下让句柄自然释放，然后**设置 exitCode 而不是
    //    process.exit()**，把收尾交给事件循环。
    await sleep(300)
    await cleanup()
    await sleep(300)
    process.exitCode = problems.length ? 1 : 0
    return
  } catch (e) {
    console.log('\n  ❌ 渲染检查失败：' + e.message)
    await cleanup()
    await sleep(300)
    process.exitCode = 1
    return
  }
}

function sleep(ms) {
  return new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref() })
}

main().catch((e) => { console.error('[fatal]', e); process.exit(1) })
