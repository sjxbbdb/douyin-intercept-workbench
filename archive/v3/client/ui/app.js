'use strict'

// client/ui/app.js
//
// 本地控制台的前端 —— **原生 DOM，无框架、无构建、无 CDN、无图表库**。
//
// ⚠️ 三条不可违背的约束（shared/术语与选型基准.md §3.2.1
//    + AGENTS.md §2 + docs/需求规格.md D-14）：
//
//   1. **前端不做任何看板算术**。所有比例、成功率、使用率都来自
//      `GET /api/state` 的 `dashboard` 对象，那是 `shared/lib/stats.js`
//      的 `buildDashboard()` 算出来的**唯一一份实现**。
//      前端再算一遍的后果是"界面说 87%、服务端说 84%"——而两只眼睛
//      看的是同一批数据。本文件里**不存在**任何 `x / y` 形式的比率计算。
//      （唯一的数学是画柱状图时把四类计数**等比缩放**成像素高度，
//        见 `render_trend`；那不是口径计算，是绘图。）
//
//   2. **`null` 一律显示 `—`**，绝不显示 `0%`，更不显示 `100%`。
//      成功率的分母是 0 时（一条都没尝试），`buildDashboard` 明确返回 `null`。
//      把它画成 100% 会让商家以为"全都发出去了"——这是本项目最危险的误导。
//
//   3. **没有任何硬编码样例数字**（旧代码 D-14）。空态一律"暂无数据"。
//
// ⚠️ XSS：评论相关文本（失败原因、审计详情、告警文案）都可能是**外部输入**。
//    本文件**完全不用** `innerHTML` 拼接数据，一律 `document.createElement`
//    + `textContent`（见 `el()` / `text()`）。唯一的 `innerHTML` 用法是把
//    已经构造好的 DOM 节点挂上去（`replaceChildren`），不涉及字符串拼接。
//
// ⚠️ 令牌：从 `location.search` 的 `?token=` 取，随后放进 `sessionStorage`
//    并**立刻从地址栏抹掉**（`history.replaceState`）——留在地址栏会被
//    截图、被浏览器历史、被"分享链接"带走。令牌只存在于内存与 sessionStorage。
//
// ⚠️ 轮询失败**必须显式告警**，绝不让数字静静停在旧值上。
//    旧代码的形态就是"接口挂了，界面还挂着上一次的数字"，商家据此做的
//    每一个判断都是错的。

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/** 令牌的 sessionStorage 键。⚠️ 用 sessionStorage 而不是持久化的 Web Storage：
 *  关掉标签页即失效，不会在商家机器上长期留存一个可驱动发送的凭据。 */
var TOKEN_KEY = 'reply_workbench_ui_token'

/** 面板定义。快捷键 1–9 与顺序一一对应。 */
var PANELS = [
  { id: 'dashboard', key: '1', title: '看板' },
  { id: 'engine', key: '2', title: '引擎' },
  { id: 'queue', key: '3', title: '队列' },
  { id: 'rules', key: '4', title: '规则' },
  { id: 'limits', key: '5', title: '限额' },
  { id: 'observe', key: '6', title: '可观测' },
  { id: 'credential', key: '7', title: '凭据' },
  { id: 'circuit', key: '8', title: '熔断' },
  { id: 'about', key: '9', title: '说明' },
]

/** 四个 verdict 的中文名。
 *  ⚠️ **四个各自一个名字，绝不合并**：`sent_confirmed_dom` 与
 *  `sent_suspected` 计费资格不同（前者不计费、后者结果未知），
 *  合并显示会让商家把"疑似发出去了"当成"发出去了"。 */
var VERDICT_LABEL = {
  sent_confirmed: '平台确认送达',
  sent_confirmed_dom: 'DOM 判据（不计费）',
  sent_suspected: '疑似送达（结果未知）',
  failed: '失败',
  skipped: '跳过',
}

/** 队列状态中文名。 */
var QUEUE_STATE_LABEL = {
  queued: '待处理',
  processing: '处理中',
  done: '已完成',
  skipped: '已跳过',
  failed: '失败',
}

/** 引擎状态中文名。 */
var ENGINE_LABEL = {
  running: '运行中',
  paused: '已暂停',
  idle: '空闲（未开始取任务）',
  stopped: '已停止',
  error: '异常',
}

/** 熔断级别中文名。 */
var CIRCUIT_LABEL = {
  none: '未熔断',
  l1: '第 1 级 · 暂停 30 分钟',
  l2: '第 2 级 · 暂停 1 小时',
  l3: '第 3 级 · 停到次日 00:00',
}

/** 面板标题（含最小 HTML 结构的说明文字）。 */
var ABOUT_TEXT = [
  '本地控制台的判定与算术只有一份实现：告警与额度由 client/host/api.js 推导，'
  + '看板由 shared/lib/stats.js 的 buildDashboard() 计算。本页面只负责把它们画出来。',
  '四道本地安全门：只绑回环地址、会话令牌、CORS 白名单（并显式拒绝白名单外的 Origin）、'
  + 'Host 头回环校验。四者缺一都会让本机接口暴露给其它网页或局域网。',
  '急停不受登录状态影响：未登录、无策略、会话已失效时它都有效。急停停的是**发送**，'
  + '程序不会退出，采集与心跳照常。',
  '模板池至少 5 条变体、且不得使用 {随机1-9} 这类占位符。原因：发送前有内容相似度关卡，'
  + '与近期已发内容过像的文案会被拒绝；占位符替换出来的是同一条文案的机械变体，'
  + '会全部被拒，而平台侧看起来就是复读机。请改用语言变体（「这个 / 这款 / 它」）。',
  '规则里的关键词与回复文案只保存在本机（runtime-state.json），'
  + '上报到授权中心的只有哈希与计数——评论原文、回复原文、sec_uid 永不离开本机。',
]

// ═══════════════════════════════════════════════════════════
// DOM 工具
// ═══════════════════════════════════════════════════════════

/**
 * 建元素。
 *
 * ⚠️ 一律 `textContent`，**绝不** `innerHTML`：评论相关的文本（失败原因、
 *    审计详情、告警文案）都可能来自外部输入，字符串拼接就是一条真实的
 *    XSS 路径。这里把"转义"从"记得转义"变成"结构上不可能忘"。
 *
 * @param {string} tag
 * @param {object} [attrs] class / id / type / title / data-* / aria-* / text / value / disabled / hidden
 * @param {Array<Node|string|null|undefined>} [children]
 */
function el(tag, attrs, children) {
  var node = document.createElement(tag)
  var a = attrs || {}
  Object.keys(a).forEach(function (k) {
    var v = a[k]
    if (v === undefined || v === null) return
    if (k === 'text') { node.textContent = String(v); return }
    if (k === 'class') { node.className = String(v); return }
    if (k === 'value') { node.value = String(v); return }
    if (k === 'disabled' || k === 'hidden' || k === 'checked') {
      if (v) node.setAttribute(k, '')
      return
    }
    if (k === 'onclick' || k === 'oninput' || k === 'onchange' || k === 'onkeydown') {
      node.addEventListener(k.slice(2), v)
      return
    }
    node.setAttribute(k, String(v))
  })
  append_all(node, children)
  return node
}

/** 追加子节点，跳过 null/undefined（便于条件渲染）。字符串按**文本**插入。 */
function append_all(node, children) {
  if (children === undefined || children === null) return node
  var list = Array.isArray(children) ? children : [children]
  for (var i = 0; i < list.length; i++) {
    var c = list[i]
    if (c === null || c === undefined || c === false) continue
    node.appendChild(typeof c === 'string' || typeof c === 'number'
      ? document.createTextNode(String(c)) : c)
  }
  return node
}

/** 清空并重建一个容器。 */
function fill(container, children) {
  container.replaceChildren()
  append_all(container, children)
  return container
}

function $(id) { return document.getElementById(id) }

/**
 * 数字格式化。
 * ⚠️ `null` / `undefined` / 非有限值 → `—`。**不是 0**。
 *    这是"成功率分母为 0"那条要求的最后一道保险：即使上游漏了判空，
 *    这里也不会把 `null` 画成 `0`。
 */
function fmt_num(v) {
  if (v === null || v === undefined) return '—'
  var n = Number(v)
  return Number.isFinite(n) ? String(n) : '—'
}

/** 时间 → `HH:MM:SS`（本地时区）。0/非法 → `—`。 */
function fmt_time(ms) {
  var n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '—'
  var d = new Date(n)
  function p(x) { return x < 10 ? '0' + x : String(x) }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

/** 时间 → `MM-DD HH:MM`。 */
function fmt_datetime(ms) {
  var n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '—'
  var d = new Date(n)
  function p(x) { return x < 10 ? '0' + x : String(x) }
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/** 毫秒 → 人类可读时长（用于"还有多久恢复"）。 */
function fmt_duration(ms) {
  var n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '—'
  var total_min = Math.ceil(n / 60000)
  if (total_min < 60) return total_min + ' 分钟'
  var h = Math.floor(total_min / 60)
  var m = total_min % 60
  return m === 0 ? (h + ' 小时') : (h + ' 小时 ' + m + ' 分钟')
}

/** 哈希短显（只用于展示，不参与任何判定）。 */
function short_hash(h, n) {
  if (typeof h !== 'string' || h === '') return '—'
  var keep = n || 10
  return h.length <= keep ? h : (h.slice(0, keep) + '…')
}

/** 渠道中文名。 */
function source_label(src) {
  return { comment: '评论', live_danmaku: '弹幕', dm: '私信' }[src] || String(src || '—')
}

/** 判定标签节点。 */
function verdict_chip(verdict) {
  var label = VERDICT_LABEL[verdict] || String(verdict || '未知')
  return el('span', { class: 'chip chip-' + String(verdict || 'none'), text: label })
}

/** 通用"键 + 值"表格。 */
function kv_table(rows) {
  return el('table', { class: 'table' }, [
    el('tbody', null, rows.map(function (r) {
      return el('tr', null, [
        el('th', { text: r[0] }),
        el('td', { class: r[2] || '', text: r[1] === null || r[1] === undefined ? '—' : String(r[1]) }),
      ])
    })),
  ])
}

/** 空态。⚠️ 固定文案"暂无数据"，不允许出现样例数字。 */
function empty_state(note) {
  return el('div', { class: 'empty', text: note || '暂无数据' })
}

// ═══════════════════════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════════════════════

var state = {
  token: null,
  /** 最近一次 /api/state 的响应体；失败时为 null（**并清空**，不留旧值） */
  data: null,
  /** 连续失败次数 */
  failures: 0,
  online: false,
  active_panel: 'dashboard',
  /** 限额面板：用户正在编辑的字段（避免轮询把输入框重置） */
  limit_dirty: {},
  /** 规则面板：每张规则卡的变体数显示节点 */
  variant_nodes: [],
  palette_index: 0,
  palette_items: [],
  last_error_line: null,
}

// ═══════════════════════════════════════════════════════════
// 令牌与请求
// ═══════════════════════════════════════════════════════════

/**
 * 解析令牌。
 *
 * ⚠️ 取到后**立刻** `history.replaceState` 把 `?token=` 从地址栏抹掉：
 *    留在地址栏会被截图、进浏览器历史、被"复制链接"带走。
 */
function init_token() {
  var params = new URLSearchParams(window.location.search)
  var from_url = params.get('token')
  var token = null
  if (from_url) {
    token = from_url
    try { window.sessionStorage.setItem(TOKEN_KEY, from_url) } catch (e) {
      // ⚠️ 不吞异常：隐私模式下 sessionStorage 会抛。这不是致命问题，
      //    但必须留痕——否则"刷新页面就要重新输令牌"永远查不出原因。
      log_local('warn', 'sessionStorage 不可用，令牌只在本次页面生命周期内有效：' + e.message)
    }
    params.delete('token')
    var qs = params.toString()
    try {
      window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''))
    } catch (e) {
      log_local('warn', '无法从地址栏清除令牌参数：' + e.message)
    }
  } else {
    try { token = window.sessionStorage.getItem(TOKEN_KEY) } catch (e) {
      log_local('warn', 'sessionStorage 读取失败：' + e.message)
      token = null
    }
  }
  state.token = token || null
  var footer = $('footer-token')
  if (footer) {
    footer.textContent = state.token
      ? '令牌：已从地址栏载入并已从地址栏清除'
      : '令牌：缺失 —— 请从启动器打开的页面进入（地址形如 ?token=…）'
  }
  return state.token
}

/** 本地日志（只在页面上留一条，不刷控制台噪声）。 */
function log_local(level, message) {
  state.last_error_line = { level: level, message: message, at_ms: Date.now() }
}

/**
 * 调本地接口。
 *
 * ⚠️ 令牌附在 `X-UI-Token` 上（同时也支持 query）——用请求头而不是 query，
 *    是为了不让令牌进入任何访问日志与 Referer。
 *
 * @returns {Promise<{status:number, body:object}>}
 */
async function api(path, opts) {
  var o = opts || {}
  var headers = { 'X-UI-Token': state.token || '' }
  var init = { method: o.method || 'GET', headers: headers, cache: 'no-store' }
  if (o.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(o.body)
  }
  var res = await fetch(path, init)
  var text = await res.text()
  var body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch (e) {
    // ⚠️ 不吞异常：响应不是 JSON 说明接口层出了问题（或代理插了一手），
    //    必须显式归因，不能当成"空数据"。
    throw new Error('本地接口返回的不是 JSON（HTTP ' + res.status + '）：' + text.slice(0, 200))
  }
  if (body === null || typeof body !== 'object') {
    throw new Error('本地接口返回了空响应（HTTP ' + res.status + '）')
  }
  return { status: res.status, body: body, ok: res.ok }
}

/** 把接口错误统一成一句面向商家的中文。 */
function api_error_text(r) {
  var b = r && r.body ? r.body : {}
  var msg = b.message || '本地接口返回了错误'
  if (b.code) msg = '[' + b.code + '] ' + msg
  if (b.detail && b.detail.reason) msg += '（' + b.detail.reason + '）'
  return msg
}

// ═══════════════════════════════════════════════════════════
// 轮询
// ═══════════════════════════════════════════════════════════

var poll_timer = null

function start_polling() {
  stop_polling()
  poll_once()
  var period = (state.data && Number(state.data.poll_interval_ms)) || 2000
  poll_timer = window.setInterval(poll_once, period)
}

function stop_polling() {
  if (poll_timer !== null) {
    window.clearInterval(poll_timer)
    poll_timer = null
  }
}

async function poll_once() {
  if (!state.token) {
    set_online(false, '缺少令牌：请从启动器打开的带 ?token= 的地址进入。')
    return
  }
  try {
    var r = await api('/api/state')
    if (!r.ok || r.body.ok !== true) {
      set_online(false, api_error_text(r))
      return
    }
    state.data = r.body
    state.failures = 0
    set_online(true, null)
    render_all()
  } catch (e) {
    state.failures += 1
    set_online(false, e && e.message ? e.message : String(e))
  }
}

/**
 * 设置离线横幅。
 *
 * ⚠️ 文案必须明确写出"本地服务未响应"并说明数字已清空——旧代码的形态是
 *    接口挂了但界面还挂着上一次的数字，商家据此做的每个判断都是错的。
 */
function set_online(ok, message) {
  var was = state.online
  state.online = ok
  if (!ok) state.data = null

  var conn = $('conn-state')
  if (conn) {
    conn.dataset.state = ok ? 'ok' : 'down'
    conn.textContent = ok ? '已连接' : '未连接'
  }
  var banner = $('banner-offline')
  if (banner) banner.hidden = ok
  var detail = $('banner-offline-detail')
  if (detail) {
    detail.textContent = message
      ? ('本地服务未响应。原因：' + message + '。界面数字已清空，请勿把它们当作当前状态。')
      : '本地服务未响应。界面数字已清空，请勿把它们当作当前状态。'
  }
  if (!ok && was) log_local('warn', '本地服务未响应：' + (message || ''))
  if (ok && !was) start_polling_period_fix()
}

/** 首次拿到响应后用服务端给的 poll_interval_ms 校准周期。 */
function start_polling_period_fix() {
  if (state.data && Number(state.data.poll_interval_ms) > 0) start_polling()
}

// ═══════════════════════════════════════════════════════════
// 渲染总入口
// ═══════════════════════════════════════════════════════════

function render_all() {
  var d = state.data
  render_topbar(d)
  render_alerts(d)
  render_dashboard(d)
  render_engine(d)
  render_queue(d)
  render_rules_static(d)
  render_limits(d)
  render_observe(d)
  render_credential(d)
  render_circuit(d)
  render_about(d)
}

// ── 顶栏 ──────────────────────────────────────────────────

function render_topbar(d) {
  var guard = d.guard || {}
  var engine = d.engine || {}
  var license = d.license || {}
  var notice = d.quota_notice || null
  var dashboard = d.dashboard || {}
  var counts = dashboard.counts || {}

  // 实例
  var inst = $('instance-label')
  if (inst) inst.textContent = '实例 ' + (d.instance_id || '（未命名）')

  // 急停按钮状态
  var btn = $('btn-emergency')
  var label = $('emergency-label')
  var on = Boolean(guard.emergency_stop)
  if (btn) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    btn.title = on
      ? '当前已急停。点击解除（解除后仍需护栏放行才会发送）。'
      : '紧急停止所有发送（快捷键 Esc）。不受登录状态影响。'
  }
  if (label) label.textContent = on ? '已急停 · 点击解除' : '急停'

  // 引擎
  var eng = $('metric-engine')
  if (eng) {
    var st = engine.state || 'unknown'
    eng.textContent = ENGINE_LABEL[st] || st
    if (engine.pause_reason) eng.textContent += ' · ' + engine.pause_reason
  }

  // 余额与"可发 N 条"
  // ⚠️ 两个数字**都来自服务端已经算好的字段**：
  //    · `dashboard.display_meta.credit_display` —— 积分（由 api.js 由毫积分换算）
  //    · `quota_notice.replies_affordable` —— 可发条数（服务端按单价算出）
  //    前端不做除法：一旦前端自己换算，"界面显示 12 积分、服务端扣了 13"
  //    这类差异就没有唯一的判定点。
  var credit = $('metric-credit')
  if (credit) {
    credit.textContent = (dashboard.display_meta && dashboard.display_meta.credit_display) || '—'
  }
  var aff = $('metric-affordable')
  if (aff) {
    var n = notice && Number(notice.replies_affordable)
    aff.textContent = Number.isFinite(n) ? ('可发 ' + n + ' 条') : '—'
  }

  // 今日额度（分渠道）：文本由 api.js 的 `quota_usage_display` 给出
  var q = $('metric-quota')
  if (q) {
    var parts = Array.isArray(dashboard.quota_usage_display) ? dashboard.quota_usage_display : []
    q.textContent = parts.length ? parts.join('　') : '—'
  }

  // 队列
  var qq = $('metric-queue')
  if (qq) {
    var qs = (d.queue && d.queue.stats) || null
    qq.textContent = qs ? (fmt_num(qs.queued) + ' 待处理 / ' + fmt_num(qs.total) + ' 总') : '—'
  }

  // 额度文案：**原样**（红线 1）。不截断、不改写、不折叠。
  var box = $('quota-notice')
  if (box) {
    if (notice && (notice.headline || notice.detail)) {
      box.hidden = false
      var h = $('quota-headline')
      if (h) h.textContent = notice.headline || ''
      var dd = $('quota-detail')
      if (dd) dd.textContent = notice.detail || ''
    } else {
      box.hidden = true
      var h2 = $('quota-headline')
      if (h2) h2.textContent = ''
      var dd2 = $('quota-detail')
      if (dd2) dd2.textContent = ''
    }
  }

  // 未接入的依赖要明说，不能让界面画 0 假装正常
  if (Array.isArray(d.missing_dependencies) && d.missing_dependencies.length > 0) {
    log_local('warn', '未接入的模块：' + d.missing_dependencies.join('、'))
  }
}

// ── 告警（判定全部来自服务端）─────────────────────────────

function render_alerts(d) {
  var host = $('alerts')
  if (!host) return
  var alerts = Array.isArray(d.alerts) ? d.alerts : []
  if (alerts.length === 0) { fill(host, []); return }
  fill(host, alerts.map(function (a) {
    return el('div', { class: 'alert alert-' + (a.level || 'info') }, [
      el('span', { class: 'alert-title', text: a.title || a.code || '告警' }),
      el('span', { class: 'alert-detail', text: a.detail || '' }),
    ])
  }))
}

// ── 看板 ──────────────────────────────────────────────────

function render_dashboard(d) {
  var host = $('panel-dashboard')
  if (!host) return
  var dashboard = d.dashboard || {}
  var counts = dashboard.counts || {}
  var display = dashboard.display || {}
  var by_source = Array.isArray(dashboard.by_source) ? dashboard.by_source : []
  var by_source_display = dashboard.by_source_display || {}
  var failure_reasons = dashboard.failure_reasons || {}
  var trend = Array.isArray(d.trend) ? d.trend : []

  var is_empty = dashboard.empty === true || (Number(counts.hits) === 0 && Number(counts.reply_attempts) === 0)

  var cards = []

  // ── ① 核心计数 ────────────────────────────────────────
  cards.push(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title', text: '看板' }),
      el('span', {
        class: 'card-note',
        text: '口径版本 ' + fmt_num(dashboard.stats_version)
          + ' · 数据来源 ' + (dashboard.aggregation_source === 'usage_reports' ? '聚合上报' : '本地明细'),
      }),
    ]),
    is_empty ? empty_state('暂无数据') : el('div', { class: 'grid grid-stats' }, [
      stat_block('截流总量', display['截流总量'], '命中并沉淀为线索的人数'),
      stat_block('已回复人数', display['已回复人数'], display['已回复人数口径'] || '仅平台确认送达'),
      stat_block('回复条数', display['回复条数'], display['回复条数口径'] || '仅平台确认送达'),
      stat_block('回复成功率', display['回复成功率显示'],
        '分母为 0 时显示 —，不显示 0% 也不显示 100%', display['回复成功率'] === null),
      stat_block('DOM 判据条数', display['dom_判据条数'], 'DOM 上看起来发出去了，不计费'),
      stat_block('疑似送达条数', display['疑似送达条数'], '结果未知（例如进程中断），不计费'),
      stat_block('失败条数', display['失败条数'], '平台拒绝或语义性失败'),
      stat_block('跳过条数', display['跳过条数'], '命中但未发起回复（例如已回复过该用户）'),
    ]),
  ]))

  // ── ② 分渠道表 ────────────────────────────────────────
  cards.push(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '分渠道明细' })]),
    by_source.length === 0 ? empty_state() : el('table', { class: 'table' }, [
      el('thead', null, [el('tr', null, [
        el('th', { text: '渠道' }),
        el('th', { text: '命中' }),
        el('th', { text: '回复尝试' }),
        el('th', { text: '平台确认' }),
        el('th', { text: 'DOM 判据' }),
        el('th', { text: '疑似' }),
        el('th', { text: '失败' }),
        el('th', { text: '跳过' }),
        el('th', { text: '独立用户' }),
        el('th', { text: '成功率' }),
      ])]),
      el('tbody', null, by_source.map(function (s) {
        return el('tr', null, [
          el('td', { text: source_label(s.source_type) }),
          el('td', { class: 'num', text: fmt_num(s.hits) }),
          el('td', { class: 'num', text: fmt_num(s.reply_attempts) }),
          el('td', { class: 'num', text: fmt_num(s.sent_confirmed) }),
          el('td', { class: 'num', text: fmt_num(s.sent_confirmed_dom) }),
          el('td', { class: 'num', text: fmt_num(s.sent_suspected) }),
          el('td', { class: 'num', text: fmt_num(s.failed) }),
          el('td', { class: 'num', text: fmt_num(s.skipped) }),
          el('td', { class: 'num', text: fmt_num(s.unique_users) }),
          // ⚠️ 成功率文本由 api.js 预先算好（`by_source_display`）。
          //    前端**不做**任何比率格式化：`x / y` 一旦出现在这里，
          //    就等于有了第二份口径实现。
          el('td', { class: 'num', text: (by_source_display[s.source_type] || {}).success_rate_display || '—' }),
        ])
      })),
    ]),
  ]))

  // ── ③ 失败原因分布 ────────────────────────────────────
  var reason_keys = Object.keys(failure_reasons)
  cards.push(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '失败原因分布' })]),
    reason_keys.length === 0 ? empty_state() : el('table', { class: 'table' }, [
      el('thead', null, [el('tr', null, [el('th', { text: '失败原因（契约闭集）' }), el('th', { text: '条数' })])]),
      el('tbody', null, reason_keys.map(function (k) {
        return el('tr', null, [
          el('td', { text: k }),
          el('td', { class: 'num', text: fmt_num(failure_reasons[k]) }),
        ])
      })),
    ]),
  ]))

  // ── ④ 近 7 日趋势（纯 CSS 柱状图）─────────────────────
  cards.push(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title', text: '近 ' + trend.length + ' 日趋势' }),
      el('span', { class: 'card-note', text: '按自然日（UTC+8）聚合；柱高为四类计数的等比缩放，不是比率' }),
    ]),
    trend.length === 0 ? empty_state() : render_trend(trend, dashboard.trend_display),
  ]))

  // ── ⑤ 当日额度使用率 ──────────────────────────────────
  cards.push(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title', text: '当日额度使用率' }),
      el('span', { class: 'card-note', text: '上限由服务端下发；观察期上限为 0，显示 —' }),
    ]),
    render_usage(dashboard.quota_usage_display),
  ]))

  // ── ⑥ 口径自检标记（恒等式违反必须看得见）──────────────
  var flags = Array.isArray(dashboard.audit_flags) ? dashboard.audit_flags : []
  if (flags.length > 0) {
    cards.push(el('div', { class: 'card card-danger' }, [
      el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '口径自检未通过' })]),
      el('div', { class: 'card-note', text: '下列恒等式被违反。数据**没有被自动抹平**——抹平会让真正的缺陷永远发现不了。' }),
      el('div', { class: 'log', text: flags.join('\n') }),
    ]))
  }

  fill(host, cards)
}

/** 单个指标块。⚠️ `force_null` 为真时用弱化样式，避免"0"被误读。 */
function stat_block(label, value, note, force_null) {
  var is_null = force_null === true || value === null || value === undefined || value === '—'
  return el('div', { class: 'stat' + (is_null ? ' stat-null' : '') }, [
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: 'stat-value', text: value === null || value === undefined ? '—' : String(value) }),
    note ? el('div', { class: 'stat-note', text: note }) : null,
  ])
}

/**
 * 近 N 日趋势 —— **纯 CSS 柱状图**，不引图表库。
 *
 * ⚠️ 柱高**也不在这里算**：`api.js` 的 `trend_display` 已经给出每天的
 *    `height_percent`（四类计数按同一峰值等比缩放到 0–100）。
 *    前端只把它写进 `style.height`。
 *    为什么连这个都放服务端：一旦前端自己找峰值、自己做除法，
 *    "哪一天看起来最高"就有了第二个判定点，而它与服务端报表不一致时
 *    没有任何一方能说清谁对。
 */
function render_trend(trend, trend_display) {
  var disp = trend_display || {}
  return el('div', null, [
    el('div', { class: 'trend' }, trend.map(function (t) {
      var row = disp[t.day] || {}
      function bar(kind, cls) {
        return el('div', {
          class: 'trend-bar ' + cls,
          title: VERDICT_LABEL[kind] + '：' + fmt_num(t[kind]),
          style: 'height:' + String(Number(row[kind + '_height']) || 0) + '%',
        })
      }
      return el('div', { class: 'trend-col' }, [
        el('div', { class: 'trend-bars' }, [
          bar('sent_confirmed', 'trend-bar-confirmed'),
          bar('sent_confirmed_dom', 'trend-bar-dom'),
          bar('sent_suspected', 'trend-bar-suspected'),
          bar('failed', 'trend-bar-failed'),
        ]),
        el('div', { class: 'trend-day', text: String(t.day || '').slice(5) }),
      ])
    })),
    el('div', { class: 'trend-legend' }, [
      el('span', { class: 'lg-confirmed', text: '平台确认送达' }),
      el('span', { class: 'lg-dom', text: 'DOM 判据' }),
      el('span', { class: 'lg-suspected', text: '疑似送达' }),
      el('span', { class: 'lg-failed', text: '失败' }),
    ]),
  ])
}

/**
 * 当日额度使用率。
 *
 * ⚠️ 输入是 `api.js` 的 `dashboard.quota_usage_display`（已是文本 + 宽度百分比），
 *    **不是** `daily_quota_usage` —— 后者里的 `usage_ratio` 需要格式化，
 *    而格式化就是算术。`usage_ratio === null`（观察期上限为 0）时
 *    服务端给出的 `width_percent` 是 `null`，这里就画成"无使用率"，
 *    而不是画一根 0% 的空条。
 */
function render_usage(usage_display) {
  if (!usage_display) return empty_state('暂无额度数据（尚未取得服务端策略）')
  if (usage_display.length === 0) return empty_state()
  return el('div', { class: 'usage' }, usage_display.map(function (u) {
    var known = u.width_percent !== null && u.width_percent !== undefined
    var fill_node = el('div', {
      class: 'usage-fill' + (u.high === true ? ' usage-fill-high' : ''),
      style: 'width:' + String(known ? u.width_percent : 0) + '%',
    })
    return el('div', { class: 'usage-row' }, [
      el('div', { text: source_label(u.source_type) }),
      known
        ? el('div', { class: 'usage-track' }, [fill_node])
        : el('div', { class: 'usage-unknown', text: '上限为 0（观察期），无使用率' }),
      el('div', { class: 'usage-text', text: u.text || '' }),
    ])
  }))
}

// ── 引擎 ──────────────────────────────────────────────────

function render_engine(d) {
  var host = $('panel-engine')
  if (!host) return
  var engine = d.engine || null
  var guard = d.guard || {}

  if (!engine) {
    fill(host, [el('div', { class: 'card' }, [
      el('h2', { class: 'card-title', text: '引擎' }),
      empty_state('调度器未接入（engine 为 null），无法控制引擎。急停按钮不受影响。'),
    ])])
    return
  }

  var stats = engine.stats || {}
  var cards = []

  // 急停卡片永远排第一：无论什么状态，商家最先要看到的是"机器停了没有"
  cards.push(el('div', { class: 'card' + (guard.emergency_stop ? ' card-danger' : '') }, [
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title', text: '急停' }),
      el('span', { class: 'card-note', text: '快捷键 Esc · 不受登录状态影响' }),
    ]),
    guard.emergency_stop
      ? el('div', { class: 'warn-box', text: '当前已急停。原因：' + (guard.emergency_reason || '未说明')
        + '。采集与心跳不受影响，程序不会退出。' })
      : el('div', { class: 'field-hint', text: '急停会立即停止所有发送并停止调度循环。' }),
    el('div', { class: 'field-row' }, [
      el('button', {
        class: 'btn btn-danger', type: 'button',
        text: guard.emergency_stop ? '解除急停' : '立即急停',
        onclick: function () { toggle_emergency(guard.emergency_stop); },
      }),
    ]),
    el('div', { class: 'result', id: 'engine-result', hidden: '' }),
  ]))

  cards.push(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '引擎状态' })]),
    kv_table([
      ['状态', ENGINE_LABEL[engine.state] || engine.state || '—'],
      ['叠加状态', engine.engine_state || '—'],
      ['暂停至', engine.paused_until_ms ? fmt_datetime(engine.paused_until_ms)
        + '（还有 ' + fmt_duration(engine.paused_until_ms - d.now_ms) + '）' : '—'],
      ['暂停原因', engine.pause_reason || '—'],
      ['本轮阻塞于', stats.blockedBy || '—'],
      ['已启动', stats.startedAtMs ? fmt_datetime(stats.startedAtMs) : '—'],
      ['任务循环次数', fmt_num(stats.taskCycles)],
      ['完成 / 跳过 / 失败 / 放回', fmt_num(stats.tasksDone) + ' / ' + fmt_num(stats.tasksSkipped)
        + ' / ' + fmt_num(stats.tasksFailed) + ' / ' + fmt_num(stats.tasksRequeued)],
      ['心跳次数 / 失败', fmt_num(stats.heartbeats) + ' / ' + fmt_num(stats.heartbeatFailures)],
      ['明细上报 / 聚合上报', fmt_num(stats.sendsReports) + ' / ' + fmt_num(stats.usageReports)],
      ['上次心跳', fmt_time(stats.lastHeartbeatMs)],
      ['活动定时器', Array.isArray(engine.timers) && engine.timers.length
        ? engine.timers.join('、') : '（无）'],
    ]),
    el('div', { class: 'field-row', style: 'margin-top:12px' }, [
      action_button('启动引擎', 'start'),
      action_button('停止引擎', 'stop'),
      action_button('暂缓 30 分钟', 'pause'),
      action_button('恢复', 'resume'),
    ]),
  ]))

  fill(host, cards)
}

function action_button(title, action) {
  return el('button', {
    class: 'btn', type: 'button', text: title,
    onclick: function () { engine_action(action); },
  })
}

// ── 队列 ──────────────────────────────────────────────────

function render_queue(d) {
  var host = $('panel-queue')
  if (!host) return
  var q = d.queue
  if (!q) {
    fill(host, [el('div', { class: 'card' }, [
      el('h2', { class: 'card-title', text: '队列' }), empty_state('队列未接入。'),
    ])])
    return
  }
  var s = q.stats || {}
  var items = Array.isArray(q.items) ? q.items : []

  fill(host, [
    el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { class: 'card-title', text: '队列概览' }),
        el('span', { class: 'card-note', text: '队列满了会**拒绝**新任务，不会静默淘汰最旧的' }),
      ]),
      el('div', { class: 'grid grid-stats' }, [
        stat_block('待处理', s.queued, '下一步会被取出的'),
        stat_block('处理中', s.processing, '已取出、尚未落定'),
        stat_block('已完成', s.done, null),
        stat_block('已跳过', s.skipped, null),
        stat_block('失败', s.failed, '失败任务一律保留，是排障依据'),
        stat_block('总计', s.total, null),
      ]),
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { class: 'card-title', text: '最近任务（最多 ' + items.length + ' 条）' }),
      ]),
      items.length === 0 ? empty_state() : el('table', { class: 'table' }, [
        el('thead', null, [el('tr', null, [
          el('th', { text: '任务 ID' }),
          el('th', { text: '类型' }),
          el('th', { text: '渠道' }),
          el('th', { text: '状态' }),
          el('th', { text: '尝试' }),
          el('th', { text: '入队' }),
          el('th', { text: '结束' }),
          el('th', { text: '原因' }),
        ])]),
        el('tbody', null, items.map(function (t) {
          return el('tr', null, [
            el('td', { class: 'mono', text: short_hash(t.id, 16) }),
            el('td', { text: String(t.kind || '—') }),
            el('td', { text: source_label(t.sourceType) }),
            el('td', null, [el('span', {
              class: 'chip chip-' + String(t.state || 'none'),
              text: QUEUE_STATE_LABEL[t.state] || String(t.state || '—'),
            })]),
            el('td', { class: 'num', text: fmt_num(t.attempts) }),
            el('td', { class: 'mono', text: fmt_time(t.enqueuedAtMs) }),
            el('td', { class: 'mono', text: t.finishedAtMs ? fmt_time(t.finishedAtMs) : '—' }),
            el('td', { text: t.failureReason || t.skipReason || t.lastRetryReason || '—' }),
          ])
        })),
      ]),
      el('div', { class: 'card-note', style: 'margin-top:8px',
        text: '任务 payload 里只有哈希与定位信息，没有评论原文（红线 3 的隐私边界）。' }),
    ]),
  ])
}

// ── 规则 ──────────────────────────────────────────────────

/**
 * ⚠️ 规则面板**只在结构变化时重建 DOM**。
 *    每 2 秒重建一次会把用户正在输入的关键词/文案清掉——那是一个
 *    "看起来只是有点卡"但实际会让人丢掉工作的缺陷。
 *    所以：结构渲染走 `render_rules_static`（只在首次或增删时调用），
 *    实时变化的部分（变体计数）走 `update_variant_counts`。
 */
function render_rules_static(d) {
  var host = $('panel-rules')
  if (!host || host.dataset.rendered === '1') {
    update_variant_counts()
    return
  }
  host.dataset.rendered = '1'
  state.variant_nodes = []

  var warn = el('div', { class: 'warn-box', text:
    '模板池至少 5 条**不同**变体，且不要用 {随机1-9} 这类占位符。'
    + '发送前有内容相似度关卡：与近期已发内容过像的文案会被拒绝；'
    + '占位符替换出来的是同一条文案的机械变体，会全部被拒。'
    + '请改用语言变体——「这个 / 这款 / 它」「多少钱 / 什么价」。' })

  var list = el('div', { id: 'rules-list' })
  var status = el('div', { class: 'result', id: 'rules-result', hidden: '' })

  fill(host, [
    el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { class: 'card-title', text: '关键词 → 回复模板池' }),
        el('span', { class: 'card-note', text: '关键词与文案只存本机，上报的只有哈希' }),
      ]),
      warn,
      list,
      el('div', { class: 'field-row' }, [
        el('button', { class: 'btn', type: 'button', text: '新增一条规则', onclick: add_rule_card }),
        el('button', { class: 'btn btn-primary', type: 'button', text: '保存规则', onclick: save_rules }),
      ]),
      status,
    ]),
  ])

  var rules = state.data && state.data.rules
  if (!Array.isArray(rules) || rules.length === 0) load_rules_then_render()
  else rules.forEach(add_rule_card)
}

async function load_rules_then_render() {
  try {
    var r = await api('/api/rules')
    if (r.ok && r.body.ok && Array.isArray(r.body.rules) && r.body.rules.length > 0) {
      r.body.rules.forEach(add_rule_card)
    } else {
      add_rule_card()
    }
  } catch (e) {
    // ⚠️ 不吞异常：读不到规则要让商家看见，而不是给一张空表单。
    set_result('rules-result', 'error', '读取规则失败：' + (e && e.message ? e.message : String(e)))
    add_rule_card()
  }
}

/** 新增一张规则卡（新建或回填已有规则）。 */
function add_rule_card(rule) {
  var list = $('rules-list')
  if (!list) return
  var r = rule || { keywords: [], templates: [], source_type: 'comment', enabled: true, id: '' }

  var keywords_input = el('input', {
    type: 'text', class: 'rule-keywords',
    placeholder: '关键词，用逗号分隔，例如：多少钱,怎么卖,价格',
    value: (r.keywords || []).join(','),
  })
  var templates_input = el('textarea', {
    class: 'rule-templates',
    placeholder: '一行一条回复文案，至少 5 条不同变体',
    value: (r.templates || []).join('\n'),
  })
  var source_select = el('select', { class: 'rule-source' }, [
    el('option', { value: 'comment', text: '评论区' }),
    el('option', { value: 'live_danmaku', text: '直播间弹幕' }),
    el('option', { value: 'dm', text: '私信' }),
  ])
  source_select.value = r.source_type || 'comment'

  var variant_node = el('span', { class: 'variant-count variant-bad', text: '变体：0 / 至少 5' })
  var id_node = el('span', { class: 'rule-id', text: r.id ? ('规则 ID ' + r.id) : '新规则（保存后生成 ID）' })

  templates_input.addEventListener('input', update_variant_counts)
  keywords_input.addEventListener('input', update_variant_counts)

  var card = el('div', { class: 'rule' }, [
    el('div', { class: 'rule-head' }, [id_node, variant_node]),
    el('div', { class: 'field' }, [
      el('span', { class: 'field-label', text: '渠道' }), source_select,
    ]),
    el('div', { class: 'field' }, [
      el('span', { class: 'field-label', text: '关键词（命中任一即触发）' }), keywords_input,
    ]),
    el('div', { class: 'field' }, [
      el('span', { class: 'field-label', text: '回复模板池（一行一条）' }), templates_input,
    ]),
    el('div', { class: 'field-row' }, [
      el('button', {
        class: 'btn btn-sm', type: 'button', text: '删除这条',
        onclick: function () { card.remove(); update_variant_counts() },
      }),
    ]),
  ])

  state.variant_nodes.push({
    card: card,
    templates: templates_input,
    keywords: keywords_input,
    source: source_select,
    node: variant_node,
    id_node: id_node,
  })
  list.appendChild(card)
  update_variant_counts()
}

/** 把 textarea 里的模板拆成数组（去空行、去首尾空白）。 */
function read_templates(textarea) {
  return String(textarea.value || '').split('\n')
    .map(function (s) { return s.trim() })
    .filter(function (s) { return s !== '' })
}

/** 去重后的变体数（与 `client/safety/similarity.js` 的 templateVariantsOk 同口径）。 */
function count_variants(texts) {
  var seen = {}
  texts.forEach(function (t) {
    var key = String(t).replace(/\s+/g, '')
    if (key !== '') seen[key] = true
  })
  return Object.keys(seen).length
}

/**
 * 实时更新"变体：N / 至少 5"。
 * ⚠️ 这里的 5 是**界面提示**，真正的判定在服务端（`POST /api/rules`）
 *    与 `client/safety/similarity.js`。前端不"放行"任何规则——
 *    它只让商家在点保存之前就看到问题。
 */
function update_variant_counts() {
  state.variant_nodes = state.variant_nodes.filter(function (v) { return v.card.isConnected })
  state.variant_nodes.forEach(function (v) {
    var n = count_variants(read_templates(v.templates))
    var ok = n >= 5
    v.node.className = 'variant-count ' + (ok ? 'variant-ok' : 'variant-bad')
    v.node.textContent = '变体：' + n + ' / 至少 5' + (ok ? ' ✓' : '（不足会被服务端拒绝）')
  })
}

async function save_rules() {
  var rules = state.variant_nodes.map(function (v) {
    return {
      id: (v.id_node.textContent.match(/规则 ID (\S+)/) || [])[1] || undefined,
      source_type: v.source.value,
      keywords: String(v.keywords.value || '').split(/[,，]/).map(function (s) { return s.trim() })
        .filter(function (s) { return s !== '' }),
      templates: read_templates(v.templates),
      enabled: true,
    }
  })
  if (rules.length === 0) {
    set_result('rules-result', 'warn', '没有规则可保存。')
    return
  }
  try {
    var r = await api('/api/rules', { method: 'POST', body: { rules: rules } })
    if (!r.ok || r.body.ok !== true) {
      // ⚠️ 服务端的拒绝原因**原样**显示（例如"只有 3 条不同变体"）。
      set_result('rules-result', 'error', api_error_text(r))
      return
    }
    set_result('rules-result', 'ok', r.body.message || '已保存')
    var list = $('rules-list')
    var list = $('rules-list')
    if (list) list.replaceChildren()
    state.variant_nodes = []
    var saved = Array.isArray(r.body.rules) ? r.body.rules : []
    for (var i = 0; i < saved.length; i++) add_rule_card(saved[i])
  } catch (e) {
    set_result('rules-result', 'error', '保存失败：' + (e && e.message ? e.message : String(e)))
  }
}

// ── 限额 ──────────────────────────────────────────────────

function render_limits(d) {
  var host = $('panel-limits')
  if (!host) return
  var guard = d.guard || {}
  var limits = guard.limits || {}
  var used = guard.used || {}
  var policy = d.license && d.license.policy_version !== undefined ? d.license.policy_version : null

  var cards = []
  cards.push(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title', text: '限额（只能更保守）' }),
      el('span', { class: 'card-note', text: '策略版本 ' + fmt_num(policy) + ' · 上限由服务端下发' }),
    ]),
    el('div', { class: 'warn-box', text:
      '左侧「服务端」是服务端下发的上限，**不可调高**。'
      + '输入框只能填更保守的值：日上限调低、最小间隔调高、相似度上限调低。'
      + '调高会被拒绝，并且这次尝试会被写进审计留痕。' }),
    el('div', { id: 'limits-body' }),
    el('div', { class: 'result', id: 'limits-result', hidden: '' }),
  ]))

  fill(host, cards)

  var body = $('limits-body')
  if (!body) return
  var sources = Object.keys(limits)
  if (sources.length === 0) {
    fill(body, [empty_state('尚未取得服务端策略，因此没有可调的上限（此时发送也已被拒绝）。')])
    return
  }

  var rows = []
  sources.forEach(function (src) {
    rows.push(el('h3', { style: 'margin:12px 0 4px', text: source_label(src) }))
    rows.push(limit_row(src, 'daily_max', '每日上限（条）', limits[src].daily_max, used[src]))
    rows.push(limit_row(src, 'min_interval_ms', '最小间隔（毫秒）', limits[src].min_interval_ms, null))
    rows.push(limit_row(src, 'content_similarity_max', '相似度上限（0~1，越低越严）',
      limits[src].content_similarity_max, null))
  })
  fill(body, rows)
}

/**
 * 一行限额。
 * ⚠️ 服务端值**紧挨**输入框显示（需求要求"each showing the server's value
 *    next to the input"）。分开显示会让商家在改的时候看不到基准。
 */
function limit_row(src, field, label, server_value, used) {
  var key = src + '.' + field
  var input = el('input', {
    type: 'number', step: field === 'content_similarity_max' ? '0.01' : '1',
    value: server_value === undefined || server_value === null ? '' : String(server_value),
    'data-key': key,
  })
  input.addEventListener('input', function () { state.limit_dirty[key] = true })
  var save_btn = el('button', {
    class: 'btn btn-sm', type: 'button', text: '应用',
    onclick: function () { apply_limit(src, field, input); },
  })
  return el('div', { class: 'limit-row' }, [
    el('div', { class: 'limit-name', text: label
      + (used !== null && used !== undefined ? '（今日已用 ' + fmt_num(used) + '）' : '') }),
    el('div', { class: 'limit-server', text: '服务端 ' + fmt_num(server_value) }),
    el('div', { class: 'limit-controls' }, [
      input,
      save_btn,
      el('span', { class: 'badge-conservative', text: '只能更保守' }),
    ]),
  ])
}

async function apply_limit(src, field, input) {
  var value = Number(input.value)
  if (!Number.isFinite(value)) {
    set_result('limits-result', 'error', '请输入一个数字。')
    return
  }
  try {
    var r = await api('/api/limits', {
      method: 'POST', body: { source_type: src, field: field, value: value },
    })
    if (!r.ok || r.body.ok !== true) {
      set_result('limits-result', 'error', api_error_text(r))
      return
    }
    var b = r.body
    if (b.applied === false) {
      // ⚠️ 护栏拒绝的原因**原样**显示。这句话就是产品要传达的核心：
      //    "客户端只能调得更保守——这是为了保护你的账号"。
      set_result('limits-result', 'error',
        '已被拒绝（' + (b.reject_code || 'POLICY_VIOLATION') + '）：\n' + (b.message || '')
        + '\n本次尝试已写入审计（applied=false），用于日后举证。'
        + '\n服务端值：' + fmt_num(b.server_value) + '　当前生效值：' + fmt_num(b.effective_value))
      return
    }
    state.limit_dirty[src + '.' + field] = false
    set_result('limits-result', 'ok', (b.message || '已生效')
      + '（服务端 ' + fmt_num(b.server_value) + '，生效 ' + fmt_num(b.effective_value) + '）')
    poll_once()
  } catch (e) {
    set_result('limits-result', 'error', '设置失败：' + (e && e.message ? e.message : String(e)))
  }
}

// ── 可观测 ────────────────────────────────────────────────

function render_observe(d) {
  var host = $('panel-observe')
  if (!host) return
  var sends = Array.isArray(d.recent_sends) ? d.recent_sends : []
  var last_error = d.last_error
  var audit_stats = d.audit_stats

  var cards = []

  // 上次错误（必须带归因码）
  cards.push(el('div', { class: 'card' + (last_error ? ' card-danger' : '') }, [
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title', text: '上次错误' }),
      el('span', { class: 'card-note', text: '归因码是排障的第一入口' }),
    ]),
    last_error
      ? kv_table([
        ['归因码', last_error.code || '—', 'mono'],
        ['来源', last_error.from || '—'],
        ['时间', fmt_datetime(last_error.at_ms)],
        ['说明', last_error.message || '—'],
      ])
      : empty_state('暂无错误记录'),
  ]))

  // 最近发送（四个判定各自显示，绝不合并）
  cards.push(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title', text: '最近发送（最多 ' + sends.length + ' 条）' }),
      el('span', { class: 'card-note', text: '只有哈希与判定，没有评论原文' }),
    ]),
    sends.length === 0 ? empty_state() : el('table', { class: 'table' }, [
      el('thead', null, [el('tr', null, [
        el('th', { text: '时间' }),
        el('th', { text: '渠道' }),
        el('th', { text: '判定' }),
        el('th', { text: '确认信号' }),
        el('th', { text: '平台状态码' }),
        el('th', { text: '失败原因' }),
        el('th', { text: '风控信号' }),
        el('th', { text: '发送 ID' }),
        el('th', { text: '用户哈希' }),
      ])]),
      el('tbody', null, sends.map(function (s) {
        return el('tr', null, [
          el('td', { class: 'mono', text: fmt_time(s.at_ms) }),
          el('td', { text: source_label(s.source_type) }),
          el('td', null, [verdict_chip(s.verdict)]),
          el('td', { class: 'mono', text: s.confirm_signal || '—' }),
          el('td', { class: 'num', text: s.platform_status_code === null
            || s.platform_status_code === undefined ? '—' : String(s.platform_status_code) }),
          el('td', { text: s.failure_reason || '—' }),
          el('td', { text: s.risk_control_signal || '—' }),
          el('td', { class: 'mono', text: short_hash(s.send_id, 18) }),
          el('td', { class: 'mono', text: short_hash(s.user_key_hash, 12) }),
        ])
      })),
    ]),
    el('div', { class: 'card-note', style: 'margin-top:8px', text:
      '判定闭集四个值，语义不同、**绝不合并**：平台确认送达（计费）、'
      + 'DOM 判据（不计费）、疑似送达（结果未知、不计费）、失败。' }),
  ]))

  // 选择器漂移
  var drift = (d.alerts || []).filter(function (a) { return a.code === 'selector_drift' })
  cards.push(el('div', { class: 'card' + (drift.length ? ' card-danger' : '') }, [
    el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '选择器漂移' })]),
    drift.length === 0
      ? empty_state('近 1 小时没有选择器未命中的记录')
      : el('div', null, drift.map(function (a) {
        return el('div', { class: 'warn-box', text: (a.title || '') + '——' + (a.detail || '') })
      })),
  ]))

  // 审计尾部
  cards.push(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title', text: '审计日志' }),
      el('span', { class: 'card-note', text: audit_stats
        ? ('共 ' + fmt_num(audit_stats.total) + ' 条 · 损坏行 ' + fmt_num(audit_stats.corruptLines)
           + ' · 轮转 ' + fmt_num(audit_stats.rotations) + ' 次')
        : '审计未接入' }),
    ]),
    el('div', { class: 'field-row', style: 'margin-bottom:8px' }, [
      el('button', { class: 'btn btn-sm', type: 'button', text: '刷新审计尾部',
        onclick: function () { load_audit_tail() } }),
      el('button', { class: 'btn btn-sm', type: 'button', text: '立即上报',
        onclick: function () { report_now() } }),
    ]),
    el('pre', { class: 'log', id: 'audit-tail', text: '（点击「刷新审计尾部」加载）' }),
    el('div', { class: 'result', id: 'observe-result', hidden: '' }),
  ]))

  fill(host, cards)
}

async function load_audit_tail() {
  try {
    var r = await api('/api/audit?limit=60')
    if (!r.ok || r.body.ok !== true) {
      set_result('observe-result', 'error', api_error_text(r))
      return
    }
    var entries = r.body.entries || []
    var node = $('audit-tail')
    if (!node) return
    if (entries.length === 0) {
      node.textContent = '（暂无审计条目）'
    } else {
      // ⚠️ textContent：审计内容里可能有中文说明（属于外部输入路径），
      //    拼 HTML 就是一条真实的 XSS 路径。
      node.textContent = entries.map(function (e) {
        return fmt_datetime(e.tsMs) + '  ' + String(e.kind || '?')
          + (e.code ? ('  code=' + e.code) : '')
          + (e.fieldKey ? ('  ' + e.fieldKey + ': ' + fmt_num(e.oldValue) + ' → ' + fmt_num(e.newValue)) : '')
          + (e.applied === false ? ('  applied=false reject=' + (e.rejectCode || '—')) : '')
          + (e.verdict ? ('  verdict=' + e.verdict) : '')
          + (e.sendId ? ('  send=' + short_hash(e.sendId, 14)) : '')
      }).join('\n')
    }
    if (Number(r.body.corrupt_lines) > 0) {
      set_result('observe-result', 'warn',
        '审计文件里有 ' + r.body.corrupt_lines + ' 行无法解析（上次写入可能被中断）。'
        + '这些行没有被静默跳过，请人工检查。')
    }
  } catch (e) {
    set_result('observe-result', 'error', '读取审计失败：' + (e && e.message ? e.message : String(e)))
  }
}

async function report_now() {
  try {
    var r = await api('/api/report/now', { method: 'POST', body: {} })
    if (!r.ok || r.body.ok !== true) {
      set_result('observe-result', 'error', api_error_text(r))
      return
    }
    set_result('observe-result', r.body.sends && r.body.sends.sent ? 'ok' : 'warn',
      (r.body.message || '已触发上报')
      + (r.body.sends && r.body.sends.error ? ('\n错误码：' + r.body.sends.error) : '')
      + (r.body.sends && r.body.sends.quarantined ? '\n该批次已进隔离区（继续重试不会成功）。' : ''))
    poll_once()
  } catch (e) {
    set_result('observe-result', 'error', '上报失败：' + (e && e.message ? e.message : String(e)))
  }
}

// ── 凭据 ──────────────────────────────────────────────────

function render_credential(d) {
  var host = $('panel-credential')
  if (!host) return
  var license = d.license
  var notice = d.quota_notice || null
  var credit = d.credit || null

  var cards = []

  // 额度文案：headline + detail **逐字**（红线 1）
  cards.push(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title', text: '额度说明（服务端原文）' }),
      el('span', { class: 'card-note', text: '原文展示，不改写、不折叠' }),
    ]),
    notice
      ? el('div', null, [
        el('div', { class: 'warn-box', text: notice.headline || '（服务端未提供 headline）' }),
        el('div', { style: 'white-space:pre-wrap;color:var(--c-text-dim)',
          text: notice.detail || '（服务端未提供 detail）' }),
        el('div', { style: 'margin-top:12px' }, [kv_table([
          ['剩余可发条数', notice.replies_affordable === undefined ? '—' : String(notice.replies_affordable)],
          ['当前等级', notice.tier || '—'],
          ['账号第几天', notice.account_day_index === undefined ? '—' : String(notice.account_day_index)],
          ['发出状态', notice.sending_enabled === false ? '禁发（观察期/停用）' : '允许发送'],
          ['今日上限合计', notice.daily_cap_total === undefined ? '—' : String(notice.daily_cap_total)],
          ['套餐积分', notice.credits === undefined ? '—' : String(notice.credits)],
          ['套餐天数', notice.valid_days === undefined ? '—' : String(notice.valid_days)],
          ['按上限可用天数', notice.estimated_days_at_cap === null
            || notice.estimated_days_at_cap === undefined ? '—' : String(notice.estimated_days_at_cap)],
        ])]),
      ])
      : empty_state('尚未取得服务端额度文案（未登录或未收到策略）。'),
  ]))

  // 余额 —— ⚠️ 只显示服务端给的毫积分原值，**不在前端换算成积分**。
  // 换算（÷1000）看着无害，但它会让"界面显示 12 积分、服务端扣了 13 积分"
  // 变成一个没有唯一判定点的差异。要显示积分就给 api.js 加一个 display 字段。
  cards.push(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '余额' })]),
    kv_table([
      ['余额（毫积分，服务端原值）', credit && credit.balance_milli !== undefined
        ? String(credit.balance_milli) : '—', 'mono'],
      ['单条单价（毫积分）', credit && credit.credit_per_reply_milli !== undefined
        ? String(credit.credit_per_reply_milli) : '—'],
      ['可发条数', notice && notice.replies_affordable !== undefined
        ? String(notice.replies_affordable) : '—'],
      ['计费口径', '仅平台确认送达（platform_response + status_code=0）'],
    ]),
  ]))

  // 会话
  cards.push(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title', text: '会话' }),
      el('span', { class: 'card-note', text: '凭据原文（token / sign_key）不会出现在任何接口响应里' }),
    ]),
    license
      ? kv_table([
        ['登录状态', license.logged_in ? '已登录' : '未登录'],
        ['账号 ID', license.account_id === null || license.account_id === undefined
          ? '—' : String(license.account_id)],
        ['设备指纹', short_hash(license.device_id, 16), 'mono'],
        ['安装 ID', license.install_id ? short_hash(license.install_id, 18) : '—', 'mono'],
        ['令牌到期', fmt_datetime(license.token_expires_at_ms)],
        ['时钟偏差', license.clock_skew_ms === undefined ? '—'
          : (String(license.clock_skew_ms) + ' 毫秒')],
        ['策略版本', fmt_num(license.policy_version)],
        ['策略已确认版本', fmt_num(license.policy_acked_version)],
        ['密钥摘要', license.key || '—', 'mono'],
        ['凭据失效', license.credential_invalid
          ? (license.credential_invalid.code + ' @ ' + fmt_datetime(license.credential_invalid.at_ms))
          : '—'],
      ])
      : empty_state('授权层未接入。'),
    el('div', { class: 'field-row', style: 'margin-top:12px' }, [
      el('button', { class: 'btn btn-danger', type: 'button', text: '登出并停止引擎',
        onclick: function () { do_logout() } }),
    ]),
  ]))

  // 登录表单
  cards.push(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title', text: '登录工作台账号' }),
      el('span', { class: 'card-note', text: '⚠️ 与抖音账号无关：抖音登录态在专用 Chrome 里' }),
    ]),
    el('div', { class: 'field' }, [
      el('span', { class: 'field-label', text: '账号' }),
      el('input', { type: 'text', id: 'login-account', autocomplete: 'off', placeholder: '厂商下发的工作台账号' }),
    ]),
    el('div', { class: 'field' }, [
      el('span', { class: 'field-label', text: '密码' }),
      el('input', { type: 'password', id: 'login-password', autocomplete: 'new-password',
        placeholder: '只在本次登录请求内使用，不写入磁盘' }),
    ]),
    el('div', { class: 'field-row' }, [
      el('button', { class: 'btn btn-primary', type: 'button', text: '登录', onclick: function () { do_login() } }),
      el('span', { class: 'field-hint', text: '密码不会被记录：既不入日志，也不入审计，更不落盘。' }),
    ]),
    el('div', { class: 'result', id: 'login-result', hidden: '' }),
  ]))

  // 兑换码
  // ⚠️ 本地控制台**没有**实现 `/api/redeem`（兑换要走授权中心的
  //    `credit/redeem` 接口与它自己的幂等/并发控制）。这里如实说明，
  //    而不是做一个"点下去静默成功"的假按钮——那正是 D-14 的形态。
  cards.push(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '兑换码' })]),
    el('div', { class: 'warn-box', text:
      '本地控制台尚未实现兑换接口（POST /api/redeem 返回 501）。'
      + '兑换必须走授权中心的 credit/redeem 接口，由服务端做幂等与并发控制；'
      + '客户端自己实现一份会让"同一个兑换码被兑换两次"变成可能。'
      + '请在本版本的兑换入口（或联系厂商）完成充值。' }),
  ]))

  fill(host, cards)
}

async function do_login() {
  var account_node = $('login-account')
  var password_node = $('login-password')
  if (!account_node || !password_node) return
  var account = account_node.value.trim()
  var password = password_node.value
  if (!account || !password) {
    set_result('login-result', 'error', '请填写账号与密码。')
    return
  }
  try {
    var r = await api('/api/login', { method: 'POST', body: { account: account, password: password } })
    // ⚠️ 无论成败，立刻清掉输入框里的密码。
    password_node.value = ''
    if (!r.ok || r.body.ok !== true) {
      set_result('login-result', 'error', api_error_text(r))
      return
    }
    var lines = [r.body.message || '登录成功']
    var warnings = Array.isArray(r.body.warnings) ? r.body.warnings : []
    for (var i = 0; i < warnings.length; i++) lines.push('· ' + warnings[i])
    if (r.body.quota_notice && r.body.quota_notice.headline) {
      lines.push('额度说明：' + r.body.quota_notice.headline)
    }
    set_result('login-result', warnings.length ? 'warn' : 'ok', lines.join('\n'))
    poll_once()
  } catch (e) {
    password_node.value = ''
    set_result('login-result', 'error', '登录失败：' + (e && e.message ? e.message : String(e)))
  }
}

async function do_logout() {
  var ok = await confirm_modal('登出并停止引擎',
    '将清除本机凭据并停止引擎。\n本地队列与审计数据会保留（它们是举证依据）。\n\n确认登出？')
  if (!ok) return
  try {
    var r = await api('/api/logout', { method: 'POST', body: {} })
    if (!r.ok || r.body.ok !== true) {
      set_result('login-result', 'error', api_error_text(r))
      return
    }
    set_result('login-result', 'ok', r.body.message || '已登出')
    poll_once()
  } catch (e) {
    set_result('login-result', 'error', '登出失败：' + (e && e.message ? e.message : String(e)))
  }
}

// ═══════════════════════════════════════════════════════════
// 熔断
// ═══════════════════════════════════════════════════════════

function render_circuit(d) {
  var host = $('panel-circuit')
  if (!host) return
  var c = d.circuit
  if (!c) {
    fill(host, [el('div', { class: 'card' }, [
      el('h2', { class: 'card-title', text: '熔断' }),
      empty_state('熔断状态机未接入。'),
    ])])
    return
  }
  var level = c.level || 'none'
  var remaining = Number(c.remainingMs) || 0

  fill(host, [
    el('div', { class: 'card' + (c.open ? ' card-danger' : '') }, [
      el('div', { class: 'card-head' }, [
        el('h2', { class: 'card-title', text: '熔断状态' }),
        el('span', { class: 'card-note', text: '递进三级 L1 → L2 → L3' }),
      ]),
      el('div', { class: 'grid grid-stats' }, [
        stat_block('当前级别', CIRCUIT_LABEL[level] || level, c.open ? '生效中' : '未生效'),
        stat_block('何时恢复', c.open ? fmt_duration(remaining) : '—',
          c.untilMs ? fmt_datetime(c.untilMs) : '无冷却'),
        stat_block('触发原因', c.reason || '—', '归因码'),
      ]),
      el('div', { class: 'card-note', style: 'margin-top:8px', text: c.hint || '' }),
      c.open
        ? el('div', { class: 'warn-box', style: 'margin-top:12px', text:
          '熔断期间不会发送任何内容。**不要**通过重启程序来绕过它：'
          + '熔断状态已落盘，重启后依然生效，而且绕过会让账号在风控触发后继续满速发送。' })
        : null,
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '触发阈值与窗口' })]),
      kv_table([
        ['连续失败', fmt_num(c.consecutiveFailures) + ' / 阈值 ' + fmt_num(c.consecutiveFailureThreshold)],
        ['平台风控拒绝计数', fmt_num(c.platformRejectCount) + ' / 阈值 ' + fmt_num(c.platformRejectThreshold)],
        // ⚠️ 失败率文本由服务端给出（`failureRateDisplay`）：前端不做比率换算。
        ['失败率', (c.failureRateDisplay || '—') + ' / 阈值 ' + (c.failureRateThresholdDisplay || '—')],
        ['失败率窗口样本数', fmt_num(c.failureRateWindow)],
        ['来源', c.source || '—'],
        ['与服务端冷却的关系', '服务端冷却时长是**下限**，本地级别只会更长，绝不会被削短'],
      ]),
      el('div', { class: 'field-row', style: 'margin-top:12px' }, [
        el('button', { class: 'btn', type: 'button', text: '刷新', onclick: function () { poll_once() } }),
        el('span', { class: 'field-hint', text:
          '解除熔断只有一个路径：`CircuitBreaker.clear()` 的显式人工动作，且必须记审计。'
          + '本页面**不提供**任何"关闭熔断"的开关。' }),
      ]),
    ]),
  ])
}

// ── 说明 ──────────────────────────────────────────────────

function render_about() {
  var host = $('panel-about')
  if (!host || host.dataset.rendered === '1') return
  host.dataset.rendered = '1'
  fill(host, [el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '这个面板的边界' })]),
    el('div', null, ABOUT_TEXT.map(function (p) {
      return el('p', { style: 'color:var(--c-text-dim);margin:0 0 8px', text: p })
    })),
  ])])
}

// ═══════════════════════════════════════════════════════════
// 动作
// ═══════════════════════════════════════════════════════════

function set_result(id, kind, text) {
  var node = $(id)
  if (!node) return
  node.hidden = false
  node.className = 'result result-' + (kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : 'err')
  node.textContent = String(text || '')
}

/**
 * 急停开关。
 * ⚠️ 急停**不需要**先登录：`POST /api/emergency-stop` 在服务端同样不受
 *    license 状态门控。这是商家"一键停机"的唯一保证。
 */
async function toggle_emergency(currently_on) {
  try {
    var r = await api('/api/emergency-stop', {
      method: 'POST', body: { on: !currently_on, reason: currently_on ? '用户手动解除' : '用户手动急停' },
    })
    if (!r.ok || r.body.ok !== true) {
      set_result('engine-result', 'error', api_error_text(r))
      return
    }
    set_result('engine-result', r.body.on ? 'warn' : 'ok', r.body.message || '已更新急停状态')
    poll_once()
  } catch (e) {
    set_result('engine-result', 'error', '急停操作失败：' + (e && e.message ? e.message : String(e)))
  }
}

async function engine_action(action) {
  try {
    var r = await api('/api/engine', { method: 'POST', body: { action: action } })
    if (!r.ok || r.body.ok !== true) {
      set_result('engine-result', 'error', api_error_text(r))
      return
    }
    set_result('engine-result', r.body.applied === false ? 'warn' : 'ok',
      (r.body.message || ('已执行 ' + action))
      + (r.body.denied_by_guard ? ('\n护栏拒绝原因：' + r.body.denied_by_guard) : ''))
    poll_once()
  } catch (e) {
    set_result('engine-result', 'error', '引擎操作失败：' + (e && e.message ? e.message : String(e)))
  }
}

// ═══════════════════════════════════════════════════════════
// 面板切换 / 命令面板 / 快捷键
// ═══════════════════════════════════════════════════════════

function build_tabs() {
  var host = $('tabs')
  if (!host) return
  fill(host, PANELS.map(function (p) {
    return el('button', {
      class: 'tab', type: 'button', role: 'tab', 'data-panel': p.id,
      'aria-selected': p.id === state.active_panel ? 'true' : 'false',
      onclick: function () { activate_panel(p.id) },
    }, [
      el('span', { class: 'tab-key', text: p.key }),
      el('span', { text: p.title }),
    ])
  }))
}

function activate_panel(id) {
  state.active_panel = id
  PANELS.forEach(function (p) {
    var sec = $('panel-' + p.id)
    if (sec) sec.hidden = p.id !== id
  })
  var tabs = document.querySelectorAll('.tab')
  Array.prototype.forEach.call(tabs, function (t) {
    t.setAttribute('aria-selected', t.dataset.panel === id ? 'true' : 'false')
  })
  // 切到审计面板时顺手加载一次尾部
  if (id === 'observe') load_audit_tail()
}

/** 命令面板的动作清单（全部是已有能力的入口，不引入新能力）。 */
function palette_actions() {
  var actions = PANELS.map(function (p) {
    return {
      title: '切换到「' + p.title + '」',
      note: '快捷键 ' + p.key,
      run: function () { activate_panel(p.id) },
    }
  })
  actions.push({
    title: '立即急停',
    note: 'Esc',
    run: function () { toggle_emergency(false) },
  })
  actions.push({
    title: '解除急停',
    note: '需要先确认账号状态',
    run: function () { toggle_emergency(true) },
  })
  actions.push({ title: '启动引擎', note: 'POST /api/engine', run: function () { engine_action('start') } })
  actions.push({ title: '停止引擎', note: 'POST /api/engine', run: function () { engine_action('stop') } })
  actions.push({ title: '暂缓 30 分钟', note: 'POST /api/engine', run: function () { engine_action('pause') } })
  actions.push({ title: '恢复引擎', note: '仍需护栏放行', run: function () { engine_action('resume') } })
  actions.push({ title: '立即上报明细与聚合', note: 'POST /api/report/now', run: function () { report_now() } })
  actions.push({ title: '刷新界面状态', note: 'GET /api/state', run: function () { poll_once() } })
  actions.push({ title: '刷新审计尾部', note: 'GET /api/audit', run: function () { activate_panel('observe'); load_audit_tail() } })
  actions.push({ title: '登出并停止引擎', note: 'POST /api/logout', run: function () { do_logout() } })
  return actions
}

function open_palette() {
  var overlay = $('palette')
  if (!overlay) return
  overlay.hidden = false
  var input = $('palette-input')
  if (input) { input.value = ''; input.focus() }
  render_palette('')
}

function close_palette() {
  var overlay = $('palette')
  if (overlay) overlay.hidden = true
}

function render_palette(filter) {
  var list = $('palette-list')
  if (!list) return
  var needle = String(filter || '').toLowerCase()
  state.palette_items = palette_actions().filter(function (a) {
    return needle === '' || a.title.toLowerCase().indexOf(needle) >= 0
      || String(a.note || '').toLowerCase().indexOf(needle) >= 0
  })
  if (state.palette_index >= state.palette_items.length) state.palette_index = 0
  if (state.palette_items.length === 0) {
    fill(list, [el('li', { class: 'palette-item', text: '没有匹配的动作' })])
    return
  }
  fill(list, state.palette_items.map(function (a, i) {
    return el('li', {
      class: 'palette-item', role: 'option',
      'aria-selected': i === state.palette_index ? 'true' : 'false',
      onclick: function () { run_palette_item(i) },
    }, [
      el('span', { text: a.title }),
      el('span', { class: 'palette-item-note', text: a.note || '' }),
    ])
  }))
}

function run_palette_item(i) {
  var a = state.palette_items[i]
  close_palette()
  if (a && typeof a.run === 'function') a.run()
}

/** 通用确认对话框（Promise<boolean>）。 */
function confirm_modal(title, body) {
  return new Promise(function (resolve) {
    var overlay = $('modal')
    var title_node = $('modal-title')
    var body_node = $('modal-body')
    var actions = $('modal-actions')
    if (!overlay || !actions) { resolve(false); return }
    if (title_node) title_node.textContent = title
    if (body_node) body_node.textContent = body
    function done(v) { overlay.hidden = true; resolve(v) }
    fill(actions, [
      el('button', { class: 'btn', type: 'button', text: '取消', onclick: function () { done(false) } }),
      el('button', { class: 'btn btn-danger', type: 'button', text: '确认', onclick: function () { done(true) } }),
    ])
    overlay.hidden = false
  })
}

/** 全局快捷键。 */
function bind_keys() {
  document.addEventListener('keydown', function (ev) {
    // ── Esc：优先关浮层，其次急停 ────────────────────────
    if (ev.key === 'Escape') {
      var palette = $('palette')
      var modal = $('modal')
      if (palette && !palette.hidden) { close_palette(); ev.preventDefault(); return }
      if (modal && !modal.hidden) return // 对话框自己处理
      // ⚠️ 输入框里按 Esc 不触发急停：商家在填表时误按一下就停机，代价太大。
      if (is_typing_target(ev.target)) return
      var on = Boolean(state.data && state.data.guard && state.data.guard.emergency_stop)
      toggle_emergency(on)
      ev.preventDefault()
      return
    }

    // ── Ctrl+K：命令面板 ─────────────────────────────────
    if ((ev.ctrlKey || ev.metaKey) && String(ev.key).toLowerCase() === 'k') {
      ev.preventDefault()
      open_palette()
      return
    }

    if (is_typing_target(ev.target)) return

    // ── 1–9：切换面板 ────────────────────────────────────
    if (/^[1-9]$/.test(ev.key)) {
      var p = PANELS[Number(ev.key) - 1]
      if (p) { activate_panel(p.id); ev.preventDefault() }
    }
  })

  // 命令面板的输入与键盘导航
  var input = $('palette-input')
  if (input) {
    input.addEventListener('input', function () {
      state.palette_index = 0
      render_palette(input.value)
    })
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') {
        state.palette_index = Math.min(state.palette_index + 1, state.palette_items.length - 1)
        render_palette(input.value)
        ev.preventDefault()
      } else if (ev.key === 'ArrowUp') {
        state.palette_index = Math.max(state.palette_index - 1, 0)
        render_palette(input.value)
        ev.preventDefault()
      } else if (ev.key === 'Enter') {
        run_palette_item(state.palette_index)
        ev.preventDefault()
      }
    })
  }
}

/** 焦点是否在输入控件里（决定快捷键要不要让路）。 */
function is_typing_target(target) {
  if (!target || !target.tagName) return false
  var tag = String(target.tagName).toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
}

// ═══════════════════════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════════════════════

function boot() {
  init_token()
  build_tabs()
  bind_keys()
  activate_panel('dashboard')
  start_polling()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}
