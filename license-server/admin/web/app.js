'use strict'

/* license-server/admin/web/app.js
 *
 * 厂商管理后台的前端 —— 原生 DOM，无框架、无构建、无 CDN。
 *
 * ⚠️⚠️ 四条不可动摇的约束（与 client/ui/app.js 同一立场）：
 *
 *   1. **零算术**。所有计数、成功率、百分比、条宽全部由服务端算好：
 *      `/api/*` → `license-server/admin/api.js` → `shared/lib/stats.js`。
 *      本文件**不做**百分比换算、不做单位换算、不自己算成功率——
 *      厂商看板与商家看板对同一个口径必须给出同一个答案，
 *      一旦这里自己算一次，两边迟早漂移，而漂移的表现就是纠纷。
 *      `null` 一律渲染成 `—`（**不是 0%，不是 100%**）。
 *
 *   2. **零硬编码样例数字**。没有数据就写"暂无数据"。
 *      旧代码 D-14 的缺陷就是看板挂着演示假数据，比显示 0 更误导。
 *
 *   3. **所有插值必须转义**。商家备注（`account.note`）、失败原因、
 *      拒绝码都可能含用户输入。统一走 `esc()`。
 *
 *   4. **不缓存任何数据到 localStorage**。后台会话在 HttpOnly cookie 里，
 *      JS 拿不到令牌；但把看板数据留在磁盘上同样是泄漏面。
 *
 * ⚠️ 发请求一律 `credentials: 'same-origin'`（浏览器默认值，但显式写出来，
 *    因为"cookie 会不会被带上"正是这个后台能否工作的关键）。
 * ⚠️ 写操作一律 `Content-Type: application/json` —— 服务端的 CSRF 校验
 *    要求它；表单编码的请求会被直接 403。
 */

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

var ADMIN_BASE = location.pathname.replace(/\/[^/]*$/, '') || ''

var SOURCE_LABELS = { comment: '评论', live_danmaku: '弹幕', dm: '私信' }
var VERDICT_LABELS = {
  sent_confirmed: '平台确认',
  sent_confirmed_dom: 'DOM 判据',
  sent_suspected: '疑似',
  failed: '失败',
}
var VERDICT_TAG = {
  sent_confirmed: 'tag-ok',
  sent_confirmed_dom: 'tag-info',
  sent_suspected: 'tag-warn',
  failed: 'tag-danger',
}
var STATUS_LABELS = { active: '正常', disabled: '已停用', expired: '已到期' }
var STATUS_TAG = { active: 'tag-ok', disabled: 'tag-danger', expired: 'tag-warn' }
var TIER_LABELS = { observation: '观察期', warm_up: '预热期', ramp_up: '爬坡期', stable: '稳定期' }
var BILLING_LABELS = {
  billed: '已计费',
  unbilled_failed: '未计费（失败）',
  unbilled_risk_control: '未计费（风控）',
  unbilled_over_limit: '未计费（超上限）',
  unbilled_insufficient_credit: '未计费（余额不足）',
  unbilled_dom_only: '未计费（仅 DOM）',
  policy_exceeded: '超策略上限',
  not_billable: '不计费',
}
var ALERT_LABELS = {
  balance_low: '余额偏低',
  heartbeat_stale: '心跳陈旧',
  plan_expired: '套餐到期',
  account_disabled: '账号停用',
  sending_disabled_observation: '观察期停发',
}
var FAILURE_LABELS = {
  rate_limited: '平台限流',
  login_expired: '登录态失效',
  element_timeout: '元素未出现',
  network_error: '网络错误',
  risk_control_rejected: '风控拒绝',
  content_rejected: '内容被拒',
  blocked_by_target: '被拒收/拉黑',
  account_risk: '账号风控',
  unknown: '未知',
}

var PANELS = [
  { id: 'overview', label: '总览' },
  { id: 'merchants', label: '商家列表' },
  { id: 'merchant', label: '商家详情' },
  { id: 'forensics', label: '取证' },
  { id: 'reconcile', label: '对账' },
  { id: 'system', label: '系统' },
]

// ═══════════════════════════════════════════════════════════
// 状态（全部在内存里；退出即清空）
// ═══════════════════════════════════════════════════════════

var State = {
  session: null,
  overview: null,
  trendDays: 7,
  merchants: null,
  merchantQuery: { status: '', q: '' },
  sort: { key: 'account_id', dir: 1 },
  currentAccount: null,
  detail: null,
  detailTab: 'policy',
  ledger: null,
  sends: null,
  forensics: null,
  reconcile: null,
  adminActions: null,
  forensicsInput: { account: '', at: '', hours: 24 },
  busy: false,
}

// ═══════════════════════════════════════════════════════════
// DOM 工具（全部经 esc 转义）
// ═══════════════════════════════════════════════════════════

function esc(v) {
  if (v === null || v === undefined) return ''
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function $(id) { return document.getElementById(id) }

function el(tag, attrs, children) {
  var node = document.createElement(tag)
  if (attrs) {
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k]
      if (v === null || v === undefined || v === false) return
      if (k === 'class') node.className = v
      else if (k === 'text') node.textContent = v
      else if (k === 'html') node.innerHTML = v
      else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v)
      else node.setAttribute(k, v === true ? '' : String(v))
    })
  }
  ;(children || []).forEach(function (c) {
    if (c === null || c === undefined || c === false) return
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
  })
  return node
}

/**
 * 数值展示。
 * ⚠️ `null`/`undefined` → `—`，**绝不**回退成 0。
 *    "没有数据"与"数据是 0"是两件事，混起来就是误导。
 */
function show(v) {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'number' && !isFinite(v)) return '—'
  if (typeof v === 'boolean') return v ? '是' : '否'
  return String(v)
}

function showCount(v) {
  if (v === null || v === undefined) return '—'
  return String(v)
}

/** 时间戳（毫秒）→ 本地时间。⚠️ 纯格式化，不含任何换算。 */
function fmtTime(ms) {
  if (ms === null || ms === undefined || ms === '') return '—'
  var n = Number(ms)
  if (!isFinite(n) || n <= 0) return '—'
  var d = new Date(n)
  var p = function (x) { return String(x).padStart(2, '0') }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/** 相对时间。⚠️ 只做"多久以前"的人话，不参与任何口径计算。 */
function fmtAgo(ms, nowMs) {
  if (ms === null || ms === undefined) return '从未'
  var n = Number(ms)
  if (!isFinite(n) || n <= 0) return '从未'
  var diff = (nowMs === undefined ? Date.now() : nowMs) - n
  if (diff < 0) return '刚刚'
  var min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return min + ' 分钟前'
  var hr = Math.floor(min / 60)
  if (hr < 24) return hr + ' 小时前'
  return Math.floor(hr / 24) + ' 天前'
}

function tag(text, cls) { return el('span', { class: 'tag ' + (cls || ''), text: text }) }

/**
 * 条宽百分比 → CSS 宽度。
 * ⚠️ 值由服务端算（`sent_confirmed_pct` 等字段）。这里**不做**任何算术，
 *    只把它拼成 CSS 值。`null` 表示"没有可比的基准"，画 0 宽度。
 */
function barStyle(pct, cls) {
  var w = (pct === null || pct === undefined) ? 0 : Number(pct)
  if (!isFinite(w) || w < 0) w = 0
  if (w > 100) w = 100
  return 'height:' + (w < 1 && w > 0 ? 1 : w) + '%;'
}

function bar(pct, cls) {
  return el('div', { class: 'trend-bar ' + cls, style: barStyle(pct) })
}

function emptyRow(cols, text) {
  return el('tr', {}, [el('td', { colspan: String(cols), class: 'empty', text: text || '暂无数据' })])
}

// ═══════════════════════════════════════════════════════════
// HTTP
// ═══════════════════════════════════════════════════════════

function apiUrl(path) { return ADMIN_BASE + path }

function setConn(state, text) {
  var c = $('conn')
  if (!c) return
  c.setAttribute('data-state', state)
  c.textContent = text
}

function showError(title, detail) {
  var b = $('banner-error')
  if (!b) return
  $('banner-error-title').textContent = title
  $('banner-error-detail').textContent = detail || ''
  b.hidden = false
}

function clearError() {
  var b = $('banner-error')
  if (b) b.hidden = true
}

/**
 * 发一个请求。
 *
 * ⚠️ 两类失败必须分开处理：
 *   · 网络失败 / 非 JSON 响应 → 明确横幅告警，**绝不让数字静静停在旧值上**
 *     （旧代码 D-14 的形态）。
 *   · 401 → 立刻回到登录页（会话过期或被踢）。
 */
function request(method, path, body) {
  var opts = {
    method: method,
    // ⚠️ 显式写出：后台会话就在 cookie 里，漏掉它整个面板都不工作
    credentials: 'same-origin',
    headers: {},
  }
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  return fetch(apiUrl(path), opts).then(function (res) {
    return res.text().then(function (text) {
      var json = null
      try {
        json = text ? JSON.parse(text) : null
      } catch (e) {
        // ⚠️ 不吞异常：非 JSON 响应本身就是被测出来的缺陷
        throw new Error('服务端返回了非 JSON 响应（HTTP ' + res.status + '）：' + text.slice(0, 200))
      }
      if (res.status === 401) {
        var err = new Error((json && json.message) || '会话已失效')
        err.code = (json && json.code) || 'ADMIN_SESSION_INVALID'
        err.status = 401
        throw err
      }
      if (!res.ok || (json && json.ok === false)) {
        var e2 = new Error((json && json.message) || ('HTTP ' + res.status))
        e2.code = (json && json.code) || 'HTTP_' + res.status
        e2.status = res.status
        e2.detail = json && json.detail
        throw e2
      }
      return json
    })
  })
}

function get(path) { return request('GET', path, null) }
function post(path, body) { return request('POST', path, body || {}) }

/** 统一的"拉数据 → 渲染"，带登录失效与错误横幅。 */
function load(path, onOk, label) {
  clearError()
  setConn('unknown', '加载中…')
  return get(path).then(function (json) {
    setConn('ok', '已同步')
    if (onOk) onOk(json)
  }).catch(function (e) {
    if (e.status === 401) {
      onUnauthorized()
      return
    }
    setConn('error', '请求失败')
    showError((label || '请求失败') + '：' + e.message, e.detail ? JSON.stringify(e.detail) : '')
  })
}

function onUnauthorized() {
  State.session = null
  renderAuth()
  var msg = $('login-msg')
  if (msg) msg.textContent = '会话已失效或已过期，请重新登录。'
}

// ═══════════════════════════════════════════════════════════
// 登录 / 退出
// ═══════════════════════════════════════════════════════════

function renderAuth() {
  var loggedIn = Boolean(State.session)
  $('login-view').hidden = loggedIn
  $('app-view').hidden = !loggedIn
  if (loggedIn) {
    $('who').textContent = State.session.admin.username +
      '（' + State.session.session_ttl_hours + ' 小时会话）'
    renderExposure()
  } else {
    var p = $('login-pass')
    if (p) p.value = ''
  }
}

function renderExposure() {
  var s = State.session
  if (!s) return
  var box = $('exposure')
  var parts = []
  parts.push('挂载路径 ')
  parts.push(el('b', { text: s.admin_path }))
  parts.push(' · IP 白名单：' + s.ip_allow.join(', '))
  if (!s.cookie_secure) parts.push(' · ⚠️ cookie 未带 Secure')
  if (s.trust_proxy) parts.push(' · TRUST_PROXY=1（真实 IP 取自 X-Forwarded-For）')
  box.textContent = ''
  parts.forEach(function (p) { box.appendChild(typeof p === 'string' ? document.createTextNode(p) : p) })
  box.hidden = false
}

function doLogin(ev) {
  ev.preventDefault()
  var user = $('login-user').value.trim()
  var pass = $('login-pass').value
  var msg = $('login-msg')
  msg.textContent = ''
  $('login-submit').disabled = true
  post('/api/login', { user: user, password: pass }).then(function () {
    return get('/api/session')
  }).then(function (s) {
    State.session = s
    renderAuth()
    switchPanel('overview')
  }).catch(function (e) {
    // ⚠️ 服务端对"用户不存在/密码错/已停用"返回**同一个**错误文案，
    //    这里原样展示，绝不自己区分（那会把后台变成用户名枚举器）。
    msg.textContent = e.message || '登录失败'
  }).then(function () {
    $('login-submit').disabled = false
  })
}

function doLogout() {
  post('/api/logout', {}).then(function () {
    State.session = null
    State.overview = null
    State.merchants = null
    State.detail = null
    renderAuth()
  }).catch(function (e) {
    // 退出失败也要回到登录页（本地状态必须清），但要让运维看见原因
    State.session = null
    renderAuth()
    var msg = $('login-msg')
    if (msg) msg.textContent = '退出请求失败：' + e.message + '（本地会话已清除，请确认服务端状态）'
  })
}

// ═══════════════════════════════════════════════════════════
// 面板导航
// ═══════════════════════════════════════════════════════════

function renderTabs() {
  var nav = $('tabs')
  nav.textContent = ''
  PANELS.forEach(function (p) {
    nav.appendChild(el('button', {
      type: 'button', class: 'tab', role: 'tab', 'data-panel': p.id,
      'aria-selected': State.activePanel === p.id ? 'true' : 'false',
      text: p.label,
      onclick: function () { switchPanel(p.id) },
    }))
  })
}

function switchPanel(id) {
  State.activePanel = id
  PANELS.forEach(function (p) {
    var sec = $('panel-' + p.id)
    if (sec) sec.hidden = p.id !== id
  })
  renderTabs()
  if (id === 'overview') loadOverview()
  else if (id === 'merchants') loadMerchants()
  else if (id === 'merchant') renderMerchant()
  else if (id === 'forensics') renderForensics()
  else if (id === 'reconcile') loadReconcile()
  else if (id === 'system') loadSystem()
}

// ═══════════════════════════════════════════════════════════
// 总览
// ═══════════════════════════════════════════════════════════

function loadOverview() {
  return load('/api/overview?days=' + State.trendDays, function (json) {
    State.overview = json
    renderOverview()
  }, '总览加载失败')
}

function metric(label, value, sub, cls) {
  return el('div', { class: 'metric' }, [
    el('span', { class: 'metric-label', text: label }),
    el('span', { class: 'metric-value' + (cls ? ' ' + cls : ''), text: show(value) }),
    sub ? el('span', { class: 'metric-sub', text: sub }) : null,
  ])
}

function renderOverview() {
  var o = State.overview
  var root = $('panel-overview')
  root.textContent = ''
  if (!o) return

  // ── 窗口切换 ─────────────────────────────────────────────
  var daysRow = el('div', { class: 'row' }, [
    el('span', { class: 'faint small', text: '统计窗口：' }),
  ])
  ;[1, 7, 30].forEach(function (d) {
    daysRow.appendChild(el('button', {
      type: 'button',
      class: 'btn btn-sm' + (State.trendDays === d ? '' : ' btn-ghost'),
      text: d + ' 天',
      onclick: function () { State.trendDays = d; loadOverview() },
    }))
  })
  daysRow.appendChild(el('span', {
    class: 'faint small',
    text: '（' + o.window.from + ' ~ ' + o.window.to + '，UTC+8 自然日）',
  }))
  root.appendChild(el('div', { class: 'card' }, [daysRow]))

  // ── 商家 ─────────────────────────────────────────────────
  root.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title', text: '商家' }),
    el('div', { class: 'grid grid-4' }, [
      metric('商家总数', o.merchants.total),
      metric('正常', o.merchants.active, null, 'is-ok'),
      metric('在线（有会话）', o.merchants.online, null, o.merchants.online > 0 ? 'is-ok' : null),
      metric('离线', o.merchants.offline, '心跳超过 ' + show(o.merchants.heartbeat_stale_ms) + ' 毫秒即视为陈旧'),
      metric('已停用', o.merchants.disabled, null, o.merchants.disabled > 0 ? 'is-danger' : null),
      metric('已到期', o.merchants.expired, null, o.merchants.expired > 0 ? 'is-warn' : null),
    ]),
  ]))

  // ── 今日 ─────────────────────────────────────────────────
  var t = o.today
  root.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title' }, [
      document.createTextNode('今日（' + t.day + '）'),
      el('span', { class: 'faint small', text: '口径与商家端一致' }),
    ]),
    el('div', { class: 'grid grid-4' }, [
      metric('发送尝试', t.reply_attempts),
      metric('平台确认成功', t.sent_confirmed, null, 'is-ok'),
      metric('积分消耗', t.credits_consumed),
      metric('回复成功率', o.success_rate_display,
        o.success_rate === null ? '当日尚无发送尝试，因此不给出比率（不是 0% 也不是 100%）' : null),
    ]),
  ]))

  // ── 窗口内明细（四个判决必须分开列出）─────────────────────
  var r = o.range
  root.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title' }, [
      document.createTextNode('窗口内明细'),
      el('span', { class: 'faint small', text: '四级判定分别统计，不合并（protocol.md §7.2）' }),
    ]),
    el('div', { class: 'grid grid-4' }, [
      metric('发送尝试', r.reply_attempts),
      metric('① 平台确认成功', r.sent_confirmed, 'sent_confirmed：平台响应 status_code=0', 'is-ok'),
      metric('② 仅 DOM 判据', r.sent_confirmed_dom, 'sent_confirmed_dom：不计费、不计入已回复人数'),
      metric('③ 疑似送达', r.sent_suspected, 'sent_suspected：无明确成功也无明确失败'),
      metric('④ 失败', r.failed, null, r.failed > 0 ? 'is-danger' : null),
      metric('跳过', r.skipped, '命中但未发起回复'),
      metric('截流总量', r.leads_new, '来自聚合上报 usage_report'),
      metric('已回复人数', r.unique_users, '仅平台确认送达（去重 user_key_hash）'),
    ]),
    el('div', { class: 'row', style: 'margin-top:12px' }, [
      el('span', { class: 'small muted', text: '回复成功率：' }),
      el('span', { class: 'mono', text: show(o.success_rate_display) }),
      el('span', {
        class: 'faint small',
        text: o.success_rate === null
          ? '（分母为 0 → 不给出比率；显示 — 而不是 100%）'
          : '（= 平台确认成功 ÷ 发送尝试，由 shared/lib/stats.js 计算）',
      }),
    ]),
    el('div', { class: 'row', style: 'margin-top:8px' }, [
      el('span', { class: 'small muted', text: '积分消耗：' }),
      el('span', { class: 'mono', text: show(r.credits_consumed) }),
      el('span', { class: 'faint small', text: '（来自 credit_ledger 的 consume 分录，按 settled_at_ms 切日）' }),
    ]),
  ]))

  // ── 近 N 日趋势 ──────────────────────────────────────────
  var trendCard = el('div', { class: 'card' }, [
    el('h2', { class: 'card-title', text: '近 ' + o.window.days + ' 日趋势' }),
    el('p', { class: 'card-note', text: '柱高以窗口内单日最大值为基准（不是日上限——日上限随等级变，用它会看不出趋势）。' }),
  ])
  var legend = el('div', { class: 'legend' }, [
    el('span', {}, [el('i', { class: 'bar-confirmed' }), document.createTextNode('平台确认')]),
    el('span', {}, [el('i', { class: 'bar-dom' }), document.createTextNode('DOM 判据')]),
    el('span', {}, [el('i', { class: 'bar-suspected' }), document.createTextNode('疑似')]),
    el('span', {}, [el('i', { class: 'bar-failed' }), document.createTextNode('失败')]),
  ])
  trendCard.appendChild(legend)

  var trendBox = el('div', { class: 'trend' })
  var peak = 0
  o.trend.forEach(function (b) { peak = Math.max(peak, Number(b.bar_peak) || 0) })
  o.trend.forEach(function (b) {
    trendBox.appendChild(el('div', { class: 'trend-day' }, [
      el('div', { class: 'trend-bars' }, [
        bar(b.sent_confirmed_pct, 'bar-confirmed'),
        bar(b.sent_confirmed_dom_pct, 'bar-dom'),
        bar(b.sent_suspected_pct, 'bar-suspected'),
        bar(b.failed_pct, 'bar-failed'),
      ]),
      el('div', { class: 'trend-label', text: b.day.slice(5) }),
      el('div', {
        class: 'trend-nums',
        text: '确 ' + showCount(b.sent_confirmed) + ' / 败 ' + showCount(b.failed),
      }),
      el('div', { class: 'trend-nums', text: '耗 ' + showCount(b.usage_milli) + ' 毫' }),
    ]))
  })
  trendCard.appendChild(trendBox)
  if (peak === 0) {
    trendCard.appendChild(el('div', { class: 'empty', text: '暂无数据' }))
  }
  root.appendChild(trendCard)

  // ── 对账（醒目）───────────────────────────────────────────
  var rec = o.reconcile
  var recOk = rec.mismatched_accounts === 0
  var recCard = el('div', { class: 'card', style: recOk ? '' : 'border-color:var(--c-danger)' }, [
    el('h2', { class: 'card-title' }, [
      document.createTextNode('对账（send_log ↔ credit_ledger）'),
      tag(recOk ? '一致' : '不一致', recOk ? 'tag-ok' : 'tag-danger'),
    ]),
    el('p', { class: 'card-note', text: rec.note }),
    el('div', { class: 'grid grid-4' }, [
      metric('已核对账号', rec.checked_accounts),
      metric('一致', rec.matched_accounts, null, 'is-ok'),
      metric('不一致', rec.mismatched_accounts, null, recOk ? null : 'is-danger'),
    ]),
  ])
  if (!recOk) {
    var tbl = el('table', { class: 'tbl' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '账号' }), el('th', { text: '明细条数' }), el('th', { text: '明细毫单位' }),
        el('th', { text: '台账条数' }), el('th', { text: '台账毫单位' }),
      ])]),
      el('tbody', {}, rec.mismatches.map(function (m) {
        return el('tr', { class: 'row-danger' }, [
          el('td', { text: show(m.account) }),
          el('td', { class: 'num', text: showCount(m.detail_count) }),
          el('td', { class: 'num', text: showCount(m.detail_milli) }),
          el('td', { class: 'num', text: showCount(m.ledger_count) }),
          el('td', { class: 'num', text: showCount(m.ledger_milli) }),
        ])
      })),
    ])
    recCard.appendChild(el('div', { class: 'table-wrap', style: 'margin-top:12px' }, [tbl]))
  }
  root.appendChild(recCard)

  // ── 口径核对 / 失败原因 ──────────────────────────────────
  var dr = o.detail_vs_report
  root.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title' }, [
      document.createTextNode('明细 ↔ 聚合上报 口径核对'),
      tag(dr.match ? '一致' : '不一致', dr.match ? 'tag-ok' : 'tag-warn'),
    ]),
    el('p', { class: 'card-note', text: '以明细为准（protocol.md §4.7）。不一致说明聚合窗口有丢失，看板仍按明细显示。' }),
    el('div', { class: 'grid grid-4' }, [
      metric('明细（权威）', dr.detail_confirmed, 'sent_confirmed'),
      metric('聚合上报', dr.reported_confirmed, 'usage_report 汇总'),
      metric('差值', dr.delta, '聚合 − 明细'),
    ]),
  ]))

  var frCard = el('div', { class: 'card' }, [el('h2', { class: 'card-title', text: '失败原因分布' })])
  var frKeys = Object.keys(o.failure_reasons || {})
  if (!frKeys.length) {
    frCard.appendChild(el('div', { class: 'empty', text: '暂无数据' }))
  } else {
    frCard.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'tbl' }, [
      el('thead', {}, [el('tr', {}, [el('th', { text: '原因' }), el('th', { text: '码' }), el('th', { text: '条数' })])]),
      el('tbody', {}, frKeys.map(function (k) {
        return el('tr', {}, [
          el('td', { text: FAILURE_LABELS[k] || k }),
          el('td', { class: 'mono faint', text: k }),
          el('td', { class: 'num', text: showCount(o.failure_reasons[k]) }),
        ])
      })),
    ])]))
  }
  root.appendChild(frCard)

  // ── 审计标记 ─────────────────────────────────────────────
  var flags = o.audit_flags || []
  root.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title', text: '审计标记' }),
    flags.length
      ? el('div', { class: 'row' }, flags.map(function (f) { return tag(f, 'tag-warn') }))
      : el('div', { class: 'empty', text: '暂无数据' }),
  ]))
}

// ═══════════════════════════════════════════════════════════
// 商家列表
// ═══════════════════════════════════════════════════════════

function merchantsPath() {
  var p = '/api/merchants?limit=500'
  if (State.merchantQuery.status) p += '&status=' + encodeURIComponent(State.merchantQuery.status)
  if (State.merchantQuery.q) p += '&q=' + encodeURIComponent(State.merchantQuery.q)
  return p
}

function loadMerchants() {
  return load(merchantsPath(), function (json) {
    State.merchants = json
    renderMerchants()
  }, '商家列表加载失败')
}

var MERCHANT_COLUMNS = [
  { key: 'account', label: '账号' },
  { key: 'status', label: '状态' },
  { key: 'plan_name', label: '套餐' },
  { key: 'balance_credits', label: '余额（积分）' },
  { key: 'replies_affordable', label: '可发条数' },
  { key: 'account_tier', label: '等级' },
  { key: 'account_day_index', label: '第N天' },
  { key: 'today_total', label: '今日发送' },
  { key: 'today_cap', label: '今日上限' },
  { key: 'live_sessions', label: '在线会话' },
  { key: 'last_heartbeat_ms', label: '最后心跳' },
  { key: 'alerts', label: '告警' },
]

function sortValue(item, key) {
  if (key === 'today_total') return item.today_sends ? item.today_sends.total : null
  if (key === 'today_cap') return item.today_cap ? item.today_cap.total : null
  if (key === 'alerts') return item.alerts ? item.alerts.length : 0
  return item[key]
}

function renderMerchants() {
  var root = $('panel-merchants')
  root.textContent = ''
  var m = State.merchants
  if (!m) return

  // ── 筛选 ─────────────────────────────────────────────────
  var qInput = el('input', {
    type: 'text', class: 'ctrl', style: 'max-width:220px',
    placeholder: '账号 / 名称 / 备注', value: State.merchantQuery.q,
  })
  var statusSel = el('select', { class: 'ctrl', style: 'max-width:140px' }, [
    el('option', { value: '', text: '全部状态' }),
    el('option', { value: 'active', text: '正常' }),
    el('option', { value: 'disabled', text: '已停用' }),
    el('option', { value: 'expired', text: '已到期' }),
  ])
  statusSel.value = State.merchantQuery.status

  var applyFilters = function () {
    State.merchantQuery.q = qInput.value.trim()
    State.merchantQuery.status = statusSel.value
    loadMerchants()
  }
  qInput.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') applyFilters() })
  statusSel.addEventListener('change', applyFilters)

  root.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title', text: '商家列表' }),
      el('span', { class: 'faint small', text: '共 ' + showCount(m.total) + ' 条' }),
    ]),
    el('div', { class: 'row' }, [
      qInput, statusSel,
      el('button', { type: 'button', class: 'btn btn-sm', text: '查询', onclick: applyFilters }),
      el('button', {
        type: 'button', class: 'btn btn-sm btn-ghost', text: '重置',
        onclick: function () {
          State.merchantQuery = { status: '', q: '' }
          loadMerchants()
        },
      }),
      el('span', { class: 'faint small', text: '点击表头排序；带底色的行表示有告警' }),
    ]),
  ]))

  // ── 表格 ─────────────────────────────────────────────────
  var items = (m.items || []).slice()
  var sk = State.sort.key
  var dir = State.sort.dir
  items.sort(function (a, b) {
    var x = sortValue(a, sk)
    var y = sortValue(b, sk)
    if (x === null || x === undefined) return 1
    if (y === null || y === undefined) return -1
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir
    return String(x).localeCompare(String(y)) * dir
  })

  var headCells = MERCHANT_COLUMNS.map(function (c) {
    var mark = State.sort.key === c.key ? (State.sort.dir === 1 ? ' ▲' : ' ▼') : ''
    var th = el('th', { class: 'sortable' }, [
      document.createTextNode(c.label),
      mark ? el('span', { class: 'sort-mark', text: mark }) : null,
    ])
    th.addEventListener('click', function () {
      if (State.sort.key === c.key) State.sort.dir = -State.sort.dir
      else { State.sort.key = c.key; State.sort.dir = 1 }
      renderMerchants()
    })
    return th
  })

  var tbody = el('tbody')
  if (!items.length) {
    tbody.appendChild(emptyRow(MERCHANT_COLUMNS.length, m.empty ? '暂无数据' : '没有匹配的商家'))
  }
  items.forEach(function (it) {
    var danger = it.status === 'disabled' || it.status === 'expired'
    var tr = el('tr', {
      class: danger ? 'row-danger' : (it.alerts && it.alerts.length ? 'row-alert' : ''),
    }, [
      el('td', {}, [el('button', {
        type: 'button', class: 'linklike mono', text: it.account,
        onclick: function () { openMerchant(it.account) },
      })]),
      el('td', {}, [tag(STATUS_LABELS[it.status] || it.status, STATUS_TAG[it.status])]),
      el('td', { text: show(it.plan_name) }),
      el('td', { class: 'num', text: show(it.balance_credits) }),
      el('td', { class: 'num', text: showCount(it.replies_affordable) }),
      el('td', { text: (TIER_LABELS[it.account_tier] || show(it.account_tier)) + (it.sending_enabled ? '' : '（停发）') }),
      el('td', { class: 'num', text: showCount(it.account_day_index) }),
      el('td', { class: 'num', text: showCount(it.today_sends ? it.today_sends.total : null) }),
      el('td', { class: 'num', text: showCount(it.today_cap ? it.today_cap.total : null) }),
      el('td', { class: 'num', text: showCount(it.live_sessions) }),
      el('td', { text: fmtAgo(it.last_heartbeat_ms, m.server_time_ms) }),
      el('td', {}, (it.alerts || []).map(function (a) {
        return tag(ALERT_LABELS[a] || a, a === 'balance_low' || a === 'heartbeat_stale' ? 'tag-warn' : 'tag-info')
      })),
    ])
    tbody.appendChild(tr)
  })

  root.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'table-wrap' }, [
      el('table', { class: 'tbl' }, [el('thead', {}, [el('tr', {}, headCells)]), tbody]),
    ]),
  ]))

  // ── 快捷操作 ─────────────────────────────────────────────
  root.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title', text: '批量操作' }),
    el('p', { class: 'card-note', text: '吊销会话会让客户端立刻收到 401 并重新登录。停用账号会同时吊销该账号全部会话。' }),
    el('div', { class: 'row' }, [
      el('button', {
        type: 'button', class: 'btn btn-danger btn-sm', text: '吊销全平台会话',
        onclick: function () { openRevokeAll() },
      }),
    ]),
  ]))
}

// ═══════════════════════════════════════════════════════════
// 商家详情
// ═══════════════════════════════════════════════════════════

function openMerchant(account) {
  State.currentAccount = account
  State.detail = null
  State.ledger = null
  State.sends = null
  State.detailTab = 'policy'
  switchPanel('merchant')
}

var DETAIL_TABS = [
  { id: 'policy', label: '策略与生效值' },
  { id: 'quota', label: '额度与台账' },
  { id: 'sends', label: '发送明细' },
  { id: 'changes', label: '配置变更' },
  { id: 'sessions', label: '会话' },
]

function renderMerchant() {
  var root = $('panel-merchant')
  root.textContent = ''
  if (!State.currentAccount) {
    root.appendChild(el('div', { class: 'card' }, [el('div', { class: 'empty', text: '请先在「商家列表」里选择一个账号' })]))
    return
  }

  load('/api/merchant/' + encodeURIComponent(State.currentAccount), function (json) {
    State.detail = json
    renderMerchantDetail()
  }, '商家详情加载失败')
}

function renderMerchantDetail() {
  var d = State.detail
  var root = $('panel-merchant')
  root.textContent = ''
  if (!d) return
  var a = d.account

  // ── 头部 ─────────────────────────────────────────────────
  root.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title' }, [
        document.createTextNode(a.account),
        tag(STATUS_LABELS[a.status] || a.status, STATUS_TAG[a.status]),
        a.display_name ? el('span', { class: 'faint small', text: a.display_name }) : null,
      ]),
      el('div', { class: 'row' }, [
        el('button', {
          type: 'button', class: 'btn btn-sm', text: '查看取证',
          onclick: function () {
            State.forensicsInput.account = a.account
            State.forensics = null
            switchPanel('forensics')
          },
        }),
        el('button', {
          type: 'button', class: 'btn btn-sm', text: '发放/扣减积分',
          onclick: function () { openCreditModal(a.account) },
        }),
        el('button', {
          type: 'button',
          class: 'btn btn-sm ' + (a.status === 'disabled' ? '' : 'btn-danger'),
          text: a.status === 'disabled' ? '启用账号' : '停用账号',
          onclick: function () { openStatusModal(a.account, a.status) },
        }),
        el('button', {
          type: 'button', class: 'btn btn-sm', text: '吊销会话',
          onclick: function () { openRevokeModal(a.account) },
        }),
      ]),
    ]),
    el('div', { class: 'grid grid-4' }, [
      metric('余额（积分）', d.credit.balance_credits, d.credit.balance_milli + ' 毫单位'),
      metric('可发条数', d.credit.replies_affordable, '按单价 ' + d.credit.credit_per_reply_milli + ' 毫单位/条'),
      metric('台账条数', d.credit.ledger_entries, 'append-only，永不修改'),
      metric('套餐', a.plan_name, a.plan_expires_ms ? '到期 ' + fmtTime(a.plan_expires_ms) : '不限期'),
      metric('第 N 天', d.policy.current_account_day_index, TIER_LABELS[d.policy.current_account_tier] || ''),
      metric('设备上限', a.device_limit),
      metric('备注', a.note || '—'),
    ]),
  ]))

  // ── 页签 ─────────────────────────────────────────────────
  var tabsBox = el('div', { class: 'subtabs' })
  DETAIL_TABS.forEach(function (t) {
    tabsBox.appendChild(el('button', {
      type: 'button', class: 'subtab', 'aria-selected': State.detailTab === t.id ? 'true' : 'false',
      text: t.label,
      onclick: function () { State.detailTab = t.id; renderMerchantDetail() },
    }))
  })
  root.appendChild(tabsBox)

  var body = el('div')
  root.appendChild(body)
  if (State.detailTab === 'policy') renderDetailPolicy(body)
  else if (State.detailTab === 'quota') renderDetailQuota(body)
  else if (State.detailTab === 'sends') renderDetailSends(body)
  else if (State.detailTab === 'changes') renderDetailChanges(body)
  else if (State.detailTab === 'sessions') renderDetailSessions(body)
}

/** 策略与生效值 —— 红线 3 最直接的展示面。 */
function renderDetailPolicy(box) {
  var p = State.detail.policy
  var card = el('div', { class: 'card' }, [
    el('h2', { class: 'card-title' }, [
      document.createTextNode('实际生效的策略值'),
      el('span', { class: 'faint small', text: '来源：' + p.source_table }),
    ]),
    el('p', {
      class: 'card-note',
      text: '这一栏**不是**"现在下发的策略"，而是客户端在心跳里确认应用过的那一版的实际生效值。'
        + '纠纷时要回答的是"当时是什么"，而"现在是什么"回答不了那个问题。',
    }),
  ])

  if (!p.ack_present) {
    card.appendChild(el('div', { class: 'empty', text: '暂无数据（该账号没有任何策略确认记录）' }))
  } else {
    card.appendChild(el('div', { class: 'grid grid-4' }, [
      metric('生效策略版本', p.policy_version, 'v' + p.current_policy_version + ' 为当前全局版本'),
      metric('策略哈希', p.policy_hash, '客户端 ack 时上报'),
      metric('等级（生效时）', TIER_LABELS[p.account_tier] || show(p.account_tier), '第 ' + show(p.account_day_index) + ' 天'),
      metric('确认实例', p.instance_id),
      metric('首次确认', fmtTime(p.first_ack_at_ms)),
      metric('最后在线', fmtTime(p.last_seen_at_ms)),
    ]))

    var rows = []
    Object.keys(SOURCE_LABELS).forEach(function (src) {
      var eff = (p.effective_limits && p.effective_limits[src]) || null
      var cur = (p.current_limits && p.current_limits[src]) || null
      rows.push([
        SOURCE_LABELS[src] + '（' + src + '）',
        eff && eff.daily_max !== undefined ? eff.daily_max : '—',
        cur ? cur.daily_max : '—',
        eff && eff.min_interval_ms !== undefined ? eff.min_interval_ms : '—',
        cur ? cur.min_interval_ms : '—',
        eff && eff.content_similarity_max !== undefined ? eff.content_similarity_max : '—',
        cur ? cur.content_similarity_max : '—',
      ])
    })
    card.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'tbl' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '渠道' }),
        el('th', { text: '生效 日上限' }), el('th', { text: '当前 日上限' }),
        el('th', { text: '生效 最小间隔ms' }), el('th', { text: '当前 最小间隔ms' }),
        el('th', { text: '生效 相似度上限' }), el('th', { text: '当前 相似度上限' }),
      ])]),
      el('tbody', {}, rows.map(function (r) {
        return el('tr', {}, r.map(function (c, i) {
          return el('td', { class: i === 0 ? '' : 'num', text: show(c) })
        }))
      })),
    ])]))

    card.appendChild(el('div', { class: 'row', style: 'margin-top:12px' }, [
      p.limits_differ === true
        ? tag('生效值与当前值不同（用户调低过，或策略版本变过）', 'tag-warn')
        : (p.limits_differ === false ? tag('生效值与当前值一致', 'tag-ok') : tag('无法比较（缺少生效值）', 'tag-info')),
    ]))
    card.appendChild(el('p', { class: 'card-note', style: 'margin-top:8px' }, [
      document.createTextNode('客户端上报的原始生效值：'),
      el('code', { class: 'break', text: show(p.effective_limits_raw) }),
    ]))
  }
  box.appendChild(card)

  // ── 当前策略（下发的）─────────────────────────────────────
  box.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title', text: '当前下发的策略' }),
    el('div', { class: 'grid grid-4' }, [
      metric('策略版本', p.current_policy_version),
      metric('等级', TIER_LABELS[p.current_account_tier] || show(p.current_account_tier)),
      metric('第 N 天', p.current_account_day_index),
      metric('发送开关', p.sending_enabled ? '已启用' : '已停用',
        p.sending_enabled ? null : '观察期只采集不发送（红线 1）', p.sending_enabled ? 'is-ok' : 'is-warn'),
      metric('账号级策略覆盖', p.policy_override_version, p.policy_override_version ? 'policy 表有该账号的行' : '无（走全局行）'),
      metric('活跃时段', p.active_hours && p.active_hours.windows
        ? p.active_hours.windows.map(function (w) { return w[0] + '–' + w[1] }).join('、')
        : '—'),
    ]),
  ]))
}

function renderDetailQuota(box) {
  var d = State.detail
  var q = d.quota
  box.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title', text: '今日额度' }),
    el('p', { class: 'card-note', text: '已用来自 send_log（verdict=sent_confirmed 且 billing_status=billed），上限来自 tier_table。' }),
    el('div', { class: 'grid grid-4' }, [
      metric('总已用 / 上限', q.today_sends.total + ' / ' + q.today_cap.total, '使用率 ' + show(q.today_usage_pct) + '%'),
    ]),
    el('div', { class: 'table-wrap', style: 'margin-top:12px' }, [el('table', { class: 'tbl' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '渠道' }), el('th', { text: '今日已用' }), el('th', { text: '日上限' }),
      ])]),
      el('tbody', {}, Object.keys(SOURCE_LABELS).map(function (src) {
        return el('tr', {}, [
          el('td', { text: SOURCE_LABELS[src] + '（' + src + '）' }),
          el('td', { class: 'num', text: showCount(q.today_sends.by_source[src]) }),
          el('td', { class: 'num', text: showCount(q.today_cap.by_source[src]) }),
        ])
      })),
    ])]),
  ]))

  // ── 台账 ─────────────────────────────────────────────────
  var card = el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title', text: '积分台账（最近 50 条）' }),
      el('span', { class: 'faint small', text: '只增不改：后台不提供任何修改/删除台账的入口' }),
    ]),
  ])
  box.appendChild(card)
  load('/api/merchant/' + encodeURIComponent(State.currentAccount) + '/ledger?limit=50', function (json) {
    State.ledger = json
    card.appendChild(el('div', { class: 'grid grid-4' }, [
      metric('余额（积分）', json.balance_credits, json.balance_milli + ' 毫单位'),
      metric('分录总数', json.total_entries),
    ]))
    if (!json.items.length) {
      card.appendChild(el('div', { class: 'empty', text: '暂无数据' }))
      return
    }
    card.appendChild(el('div', { class: 'table-wrap', style: 'margin-top:12px' }, [el('table', { class: 'tbl' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'ID' }), el('th', { text: '类型' }), el('th', { text: '变动（积分）' }),
        el('th', { text: '落账后余额' }), el('th', { text: '时间' }), el('th', { text: '操作人' }),
        el('th', { text: '说明' }), el('th', { text: '关联' }),
      ])]),
      el('tbody', {}, json.items.map(function (e) {
        return el('tr', {}, [
          el('td', { class: 'num', text: showCount(e.id) }),
          el('td', { text: e.kind }),
          el('td', { class: 'num', text: e.delta_credits }),
          el('td', { class: 'num', text: e.balance_after_credits }),
          el('td', { text: fmtTime(e.settled_at_ms) }),
          el('td', { text: e.operator }),
          el('td', { class: 'wrap', text: show(e.note) }),
          el('td', {
            class: 'mono faint',
            text: e.ref_send_id ? e.ref_send_id.slice(0, 14) + '…' : (e.ref_code_hash_prefix ? '码 ' + e.ref_code_hash_prefix + '…' : '—'),
          }),
        ])
      })),
    ])]))
  }, '台账加载失败')
}

function renderDetailSends(box) {
  var card = el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title', text: '发送明细' }),
      el('span', { class: 'faint small', text: '只有哈希与判定，绝无评论/回复原文与 sec_uid' }),
    ]),
  ])
  box.appendChild(card)

  var verdictSel = el('select', { class: 'ctrl', style: 'max-width:160px' }, [
    el('option', { value: '', text: '全部判定' }),
  ].concat(Object.keys(VERDICT_LABELS).map(function (v) {
    return el('option', { value: v, text: VERDICT_LABELS[v] + '（' + v + '）' })
  })))
  var limitSel = el('select', { class: 'ctrl', style: 'max-width:120px' }, [
    el('option', { value: '50', text: '50 条' }),
    el('option', { value: '100', text: '100 条' }),
    el('option', { value: '300', text: '300 条' }),
  ])

  var loadSends = function () {
    var p = '/api/merchant/' + encodeURIComponent(State.currentAccount) + '/sends?limit=' + limitSel.value
    if (verdictSel.value) p += '&verdict=' + encodeURIComponent(verdictSel.value)
    load(p, function (json) {
      State.sends = json
      renderSendsTable(card, json)
    }, '发送明细加载失败')
  }

  card.appendChild(el('div', { class: 'row', style: 'margin-bottom:12px' }, [
    verdictSel, limitSel,
    el('button', { type: 'button', class: 'btn btn-sm', text: '查询', onclick: loadSends }),
  ]))
  var holder = el('div', { id: 'sends-holder' })
  card.appendChild(holder)
  loadSends()
}

function renderSendsTable(card, json) {
  var holder = card.querySelector('#sends-holder')
  if (!holder) return
  holder.textContent = ''
  holder.appendChild(el('p', {
    class: 'card-note',
    text: '隐私边界：' + json.privacy.rule + '。返回字段已固定为白名单。',
  }))
  if (!json.items.length) {
    holder.appendChild(el('div', { class: 'empty', text: '暂无数据' }))
    return
  }
  holder.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'tbl' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { text: '发送时间' }), el('th', { text: '渠道' }), el('th', { text: '判定' }),
      el('th', { text: '计费' }), el('th', { text: '计费毫单位' }), el('th', { text: '端点' }),
      el('th', { text: '平台码' }), el('th', { text: '失败原因' }), el('th', { text: '超限' }),
      el('th', { text: '策略版本' }), el('th', { text: 'send_id' }), el('th', { text: '目标哈希' }),
      el('th', { text: '用户哈希' }), el('th', { text: '内容哈希' }),
    ])]),
    el('tbody', {}, json.items.map(function (s) {
      return el('tr', {}, [
        el('td', { text: fmtTime(s.sent_at_ms) }),
        el('td', { text: SOURCE_LABELS[s.source_type] || s.source_type }),
        el('td', {}, [tag(VERDICT_LABELS[s.verdict] || s.verdict, VERDICT_TAG[s.verdict])]),
        el('td', { text: BILLING_LABELS[s.billing_status] || s.billing_status }),
        el('td', { class: 'num', text: showCount(s.charged_milli) }),
        el('td', { class: 'mono faint', text: show(s.platform_endpoint) }),
        el('td', { class: 'num', text: showCount(s.platform_status_code) }),
        el('td', { text: s.failure_reason ? (FAILURE_LABELS[s.failure_reason] || s.failure_reason) : '—' }),
        el('td', { text: Number(s.over_limit) === 1 ? '是' : '否' }),
        el('td', { class: 'num', text: showCount(s.applied_policy_version) }),
        el('td', { class: 'mono faint', text: show(s.send_id).slice(0, 16) + '…' }),
        el('td', { class: 'mono faint', text: show(s.target_hash).slice(0, 12) + '…' }),
        el('td', { class: 'mono faint', text: show(s.user_key_hash).slice(0, 12) + '…' }),
        el('td', { class: 'mono faint', text: show(s.content_hash).slice(0, 12) + '…' }),
      ])
    })),
  ])]))
}

function renderDetailChanges(box) {
  var d = State.detail
  var cc = d.config_changes
  box.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title', text: '配置变更历史' }),
    el('p', { class: 'card-note', text: cc.note }),
    el('div', { class: 'grid grid-4' }, [
      metric('变更总数', cc.summary.total),
      metric('来自用户', cc.summary.from_user),
      metric('来自服务端', cc.summary.from_server),
      metric('被拒绝（applied=false）', cc.summary.refused, null, cc.summary.refused > 0 ? 'is-warn' : null),
    ]),
    cc.items.length
      ? el('div', { class: 'table-wrap', style: 'margin-top:12px' }, [el('table', { class: 'tbl' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: '时间' }), el('th', { text: '来源' }), el('th', { text: '操作者' }),
          el('th', { text: '配置项' }), el('th', { text: '旧值' }), el('th', { text: '新值' }),
          el('th', { text: '是否生效' }), el('th', { text: '拒绝码' }), el('th', { text: '策略版本' }),
        ])]),
        el('tbody', {}, cc.items.map(function (c) {
          return el('tr', { class: c.applied ? '' : 'row-alert' }, [
            el('td', { text: fmtTime(c.changed_at_ms) }),
            el('td', { text: c.source }),
            el('td', { text: show(c.actor) }),
            el('td', { class: 'mono', text: c.field_key }),
            el('td', { class: 'mono', text: show(c.old_value) }),
            el('td', { class: 'mono', text: show(c.new_value) }),
            el('td', {}, [c.applied ? tag('已生效', 'tag-ok') : tag('未生效', 'tag-warn')]),
            el('td', { class: 'mono', text: show(c.reject_code) }),
            el('td', { class: 'num', text: showCount(c.policy_version) }),
          ])
        })),
      ])])
      : el('div', { class: 'empty', text: '暂无数据' }),
  ]))

  box.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title', text: '发送判定汇总' }),
    el('p', { class: 'card-note', text: d.sends_summary.privacy }),
    el('div', { class: 'grid grid-4' }, Object.keys(VERDICT_LABELS).map(function (v) {
      return metric(VERDICT_LABELS[v], d.sends_summary.by_verdict[v], v)
    }).concat([metric('合计', d.sends_summary.total)])),
    d.sends_summary.by_billing.length
      ? el('div', { class: 'table-wrap', style: 'margin-top:12px' }, [el('table', { class: 'tbl' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: '计费状态' }), el('th', { text: '条数' }), el('th', { text: '已计费毫单位' }),
        ])]),
        el('tbody', {}, d.sends_summary.by_billing.map(function (b) {
          return el('tr', {}, [
            el('td', { text: BILLING_LABELS[b.billing_status] || b.billing_status }),
            el('td', { class: 'num', text: showCount(b.count) }),
            el('td', { class: 'num', text: showCount(b.charged_milli) }),
          ])
        })),
      ])])
      : el('div', { class: 'empty', text: '暂无数据' }),
  ]))
}

function renderDetailSessions(box) {
  var d = State.detail
  var card = el('div', { class: 'card' }, [
    el('h2', { class: 'card-title', text: '设备会话' }),
    el('p', { class: 'card-note', text: '设备上限 ' + d.account.device_limit + '。吊销后客户端下一个请求会收到 401 并重新登录。' }),
  ])
  if (!d.sessions.length) {
    card.appendChild(el('div', { class: 'empty', text: '暂无数据' }))
  } else {
    card.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'tbl' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '会话 ID' }), el('th', { text: '设备' }), el('th', { text: '签发' }),
        el('th', { text: '最后活跃' }), el('th', { text: '过期' }), el('th', { text: '状态' }),
      ])]),
      el('tbody', {}, d.sessions.map(function (s) {
        var statusTag = s.live ? tag('在线', 'tag-ok')
          : (s.revoked_at_ms ? tag('已吊销：' + show(s.revoked_reason), 'tag-danger') : tag('已过期', 'tag-info'))
        return el('tr', {}, [
          el('td', { class: 'num', text: showCount(s.id) }),
          el('td', { class: 'mono faint', text: show(s.device_id).slice(0, 18) }),
          el('td', { text: fmtTime(s.issued_at_ms) }),
          el('td', { text: fmtTime(s.last_seen_ms) }),
          el('td', { text: fmtTime(s.expires_at_ms) }),
          el('td', {}, [statusTag]),
        ])
      })),
    ])]))
  }
  box.appendChild(card)
}

// ═══════════════════════════════════════════════════════════
// 取证（四个问题的可读视图）
// ═══════════════════════════════════════════════════════════

function renderForensics() {
  var root = $('panel-forensics')

  // 已经加载过 → 直接渲染（避免每次切页签都重新请求）
  if (State.forensics) { renderForensicsResult(root); return }

  root.textContent = ''
  var accountInput = el('input', {
    type: 'text', class: 'ctrl', style: 'max-width:200px',
    placeholder: '账号', value: State.forensicsInput.account,
  })
  var atInput = el('input', {
    type: 'text', class: 'ctrl', style: 'max-width:170px',
    placeholder: '时间点（YYYY-MM-DD，留空=现在）', value: State.forensicsInput.at,
  })
  var hoursInput = el('input', {
    type: 'text', class: 'ctrl', style: 'max-width:110px',
    placeholder: '窗口小时数', value: String(State.forensicsInput.hours),
  })

  var run = function () {
    var acct = accountInput.value.trim()
    if (!acct) { showError('取证失败', '请填写账号'); return }
    State.forensicsInput.account = acct
    State.forensicsInput.at = atInput.value.trim()
    State.forensicsInput.hours = Number(hoursInput.value) || 24
    var p = '/api/forensics/' + encodeURIComponent(acct) + '?hours=' + State.forensicsInput.hours
    if (State.forensicsInput.at) p += '&at=' + encodeURIComponent(State.forensicsInput.at)
    load(p, function (json) {
      State.forensics = json
      renderForensicsResult(root)
    }, '取证失败')
  }

  root.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title', text: '纠纷取证' }),
    el('p', {
      class: 'card-note',
      text: '一次性回答 shared/protocol.md §4.10 的四个问题。数据全部来自审计表，客户端无法篡改服务端副本。',
    }),
    el('div', { class: 'row' }, [
      accountInput, atInput, hoursInput,
      el('button', { type: 'button', class: 'btn', text: '查证', onclick: run }),
    ]),
  ]))
  if (State.forensicsInput.account) run()
}

function qaBlock(q, a, src, extra) {
  return el('div', { class: 'qa' }, [
    el('h3', { class: 'qa-q', text: q }),
    el('p', { class: 'qa-a', text: a }),
    el('p', { class: 'qa-src', text: '数据来源：' + src }),
    extra || null,
  ])
}

function renderForensicsResult(root) {
  var f = State.forensics
  root.textContent = ''

  root.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title' }, [
        document.createTextNode('取证：' + f.account.account),
        el('span', { class: 'faint small', text: f.account.display_name || '' }),
      ]),
      el('button', {
        type: 'button', class: 'btn btn-sm btn-ghost', text: '重新查询',
        onclick: function () { State.forensics = null; renderForensics() },
      }),
    ]),
    el('div', { class: 'grid grid-4' }, [
      metric('询问时间点', fmtTime(f.asked_at_ms)),
      metric('回溯窗口', f.hours + ' 小时'),
      metric('窗口起点', fmtTime(f.sends_at.window.from_ms)),
    ]),
  ]))

  // (a) 实际生效的策略
  var pa = f.policy_at
  var aExtra = el('div')
  if (pa.ack_is_fallback) {
    aExtra.appendChild(el('p', { class: 'card-note' }, [tag('注意：这是时间上最近的一条确认，未必在该时刻生效', 'tag-warn')]))
  }
  aExtra.appendChild(el('div', { class: 'grid grid-4' }, [
    metric('生效策略版本', pa.ack ? pa.ack.policy_version : null),
    metric('等级', pa.ack ? (TIER_LABELS[pa.ack.account_tier] || pa.ack.account_tier) : null),
    metric('第 N 天', pa.ack ? pa.ack.account_day_index : null),
    metric('确认实例', pa.ack ? pa.ack.instance_id : null),
    metric('生效值与当前值', pa.limits_differ === true ? '不同' : (pa.limits_differ === false ? '一致' : '无法比较'),
      null, pa.limits_differ === true ? 'is-warn' : null),
  ]))
  if (pa.effective_limits) {
    aExtra.appendChild(el('div', { class: 'table-wrap', style: 'margin-top:12px' }, [el('table', { class: 'tbl' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '渠道' }), el('th', { text: '生效 日上限' }), el('th', { text: '生效 最小间隔ms' }),
        el('th', { text: '生效 相似度上限' }), el('th', { text: '当前 日上限' }), el('th', { text: '当前 最小间隔ms' }),
      ])]),
      el('tbody', {}, Object.keys(SOURCE_LABELS).map(function (src) {
        var e = (pa.effective_limits && pa.effective_limits[src]) || {}
        var c = (pa.current_policy.limits && pa.current_policy.limits[src]) || {}
        return el('tr', {}, [
          el('td', { text: SOURCE_LABELS[src] }),
          el('td', { class: 'num', text: show(e.daily_max) }),
          el('td', { class: 'num', text: show(e.min_interval_ms) }),
          el('td', { class: 'num', text: show(e.content_similarity_max) }),
          el('td', { class: 'num', text: show(c.daily_max) }),
          el('td', { class: 'num', text: show(c.min_interval_ms) }),
        ])
      })),
    ])]))
  }
  if (pa.from_send_snapshot) {
    aExtra.appendChild(el('p', { class: 'card-note', style: 'margin-top:8px' }, [
      document.createTextNode('明细自带的策略快照（独立冗余来源，v' +
        show(pa.from_send_snapshot.policy_version) + ' @ ' + fmtTime(pa.from_send_snapshot.sent_at_ms) + '）：'),
      el('code', { class: 'break', text: show(JSON.stringify(pa.from_send_snapshot.limits)) }),
    ]))
  }
  root.appendChild(el('div', { class: 'card' }, [qaBlock(pa.question, pa.answer_zh, pa.source, aExtra)]))

  // (b) 变化来源
  var cb = f.change_origin
  var bExtra = el('div', { class: 'grid grid-4' }, [
    metric('用户侧变更', cb.counts.from_user),
    metric('服务端下发', cb.counts.from_server),
    metric('变更总数', cb.counts.total),
    metric('判定', cb.verdict === 'both' ? '两边都有' : (cb.verdict === 'user' ? '仅用户' : (cb.verdict === 'server_policy' ? '仅服务端' : '无记录'))),
  ])
  if (cb.by_field.length) {
    bExtra.appendChild(el('div', { class: 'table-wrap', style: 'margin-top:12px' }, [el('table', { class: 'tbl' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '配置项' }), el('th', { text: '次数' }),
      ])]),
      el('tbody', {}, cb.by_field.map(function (g) {
        return el('tr', {}, [
          el('td', { class: 'mono', text: g.field_key + (g.field_label ? '（' + g.field_label + '）' : '') }),
          el('td', { class: 'num', text: showCount(g.count) }),
        ])
      })),
    ])]))
  }
  root.appendChild(el('div', { class: 'card' }, [qaBlock(cb.question, cb.answer_zh, cb.source, bExtra)]))

  // (c) 是否主动调高过 / 被拒绝过
  var rf = f.refusal
  var cExtra = el('div')
  cExtra.appendChild(el('div', { class: 'row' }, [
    rf.attempted_raise ? tag('有调高尝试', 'tag-warn') : tag('无调高尝试', 'tag-ok'),
    tag('被拒绝 ' + rf.refusals.length + ' 次', rf.refusals.length ? 'tag-danger' : 'tag-ok'),
  ]))
  if (rf.escalations.length) {
    cExtra.appendChild(el('h4', { class: 'small muted', style: 'margin:12px 0 4px', text: '放宽方向的用户尝试（原始证据）' }))
    cExtra.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'tbl' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '时间' }), el('th', { text: '配置项' }), el('th', { text: '旧值' }),
        el('th', { text: '新值' }), el('th', { text: '生效' }), el('th', { text: '拒绝码' }),
      ])]),
      el('tbody', {}, rf.escalations.map(function (e) {
        return el('tr', { class: e.applied ? '' : 'row-alert' }, [
          el('td', { text: fmtTime(e.changed_at_ms) }),
          el('td', { class: 'mono', text: e.field_key }),
          el('td', { class: 'mono', text: show(e.old_value) }),
          el('td', { class: 'mono', text: show(e.new_value) }),
          el('td', {}, [e.applied ? tag('已生效', 'tag-ok') : tag('被拒绝', 'tag-danger')]),
          el('td', { class: 'mono', text: show(e.reject_code) }),
        ])
      })),
    ])]))
  }
  if (rf.refusals.length) {
    cExtra.appendChild(el('h4', { class: 'small muted', style: 'margin:12px 0 4px', text: '被系统拒绝的变更' }))
    cExtra.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'tbl' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '时间' }), el('th', { text: '来源' }), el('th', { text: '配置项' }),
        el('th', { text: '上报值' }), el('th', { text: '拒绝码' }),
      ])]),
      el('tbody', {}, rf.refusals.map(function (e) {
        return el('tr', { class: 'row-danger' }, [
          el('td', { text: fmtTime(e.changed_at_ms) }),
          el('td', { text: e.source }),
          el('td', { class: 'mono', text: e.field_key }),
          el('td', { class: 'mono', text: show(e.new_value) }),
          el('td', { class: 'mono', text: show(e.reject_code) }),
        ])
      })),
    ])]))
  }
  root.appendChild(el('div', { class: 'card' }, [qaBlock(rf.question, rf.answer_zh, rf.source, cExtra)]))

  // (d) 窗口内发送
  var sa = f.sends_at
  var dExtra = el('div')
  dExtra.appendChild(el('div', { class: 'grid grid-4' }, [
    metric('发送尝试', sa.counts.reply_attempts),
    metric('平台确认成功', sa.counts.sent_confirmed, null, 'is-ok'),
    metric('仅 DOM 判据', sa.counts.sent_confirmed_dom),
    metric('疑似', sa.counts.sent_suspected),
    metric('失败', sa.counts.failed, null, sa.counts.failed > 0 ? 'is-danger' : null),
    metric('风控相关失败', sa.risk_control_failures, null, sa.risk_control_failures > 0 ? 'is-danger' : null),
    metric('超策略上限条数', sa.over_limit_count, null, sa.over_limit_count > 0 ? 'is-warn' : null),
    metric('成功率', sa.success_rate_display, sa.success_rate === null ? '窗口内无发送尝试 → 不给出比率' : null),
  ]))
  var frKeys = Object.keys(sa.failure_reasons || {})
  if (frKeys.length) {
    dExtra.appendChild(el('div', { class: 'table-wrap', style: 'margin-top:12px' }, [el('table', { class: 'tbl' }, [
      el('thead', {}, [el('tr', {}, [el('th', { text: '失败原因' }), el('th', { text: '条数' })])]),
      el('tbody', {}, frKeys.map(function (k) {
        return el('tr', {}, [
          el('td', { text: (FAILURE_LABELS[k] || k) + '（' + k + '）' }),
          el('td', { class: 'num', text: showCount(sa.failure_reasons[k]) }),
        ])
      })),
    ])]))
  }
  if (sa.items.length) {
    dExtra.appendChild(el('h4', { class: 'small muted', style: 'margin:12px 0 4px', text: '逐条明细（只有哈希与判定）' }))
    dExtra.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'tbl' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '时间' }), el('th', { text: '渠道' }), el('th', { text: '判定' }),
        el('th', { text: '计费' }), el('th', { text: '端点' }), el('th', { text: '平台码' }),
        el('th', { text: '失败原因' }), el('th', { text: '内容哈希' }),
      ])]),
      el('tbody', {}, sa.items.map(function (s) {
        return el('tr', {}, [
          el('td', { text: fmtTime(s.sent_at_ms) }),
          el('td', { text: SOURCE_LABELS[s.source_type] || s.source_type }),
          el('td', {}, [tag(VERDICT_LABELS[s.verdict] || s.verdict, VERDICT_TAG[s.verdict])]),
          el('td', { text: BILLING_LABELS[s.billing_status] || s.billing_status }),
          el('td', { class: 'mono faint', text: show(s.platform_endpoint) }),
          el('td', { class: 'num', text: showCount(s.platform_status_code) }),
          el('td', { text: s.failure_reason ? (FAILURE_LABELS[s.failure_reason] || s.failure_reason) : '—' }),
          el('td', { class: 'mono faint', text: show(s.content_hash).slice(0, 12) + '…' }),
        ])
      })),
    ])]))
  } else {
    dExtra.appendChild(el('div', { class: 'empty', text: '暂无数据' }))
  }
  root.appendChild(el('div', { class: 'card' }, [qaBlock(sa.question, sa.answer_zh, sa.source, dExtra)]))
}

// ═══════════════════════════════════════════════════════════
// 对账
// ═══════════════════════════════════════════════════════════

function loadReconcile() {
  return load('/api/reconcile?days=' + State.trendDays, function (json) {
    State.reconcile = json
    renderReconcile()
  }, '对账加载失败')
}

function renderReconcile() {
  var root = $('panel-reconcile')
  root.textContent = ''
  var r = State.reconcile
  if (!r) return
  var ok = r.global.match && r.accounts.mismatched === 0

  root.appendChild(el('div', {
    class: 'card',
    style: ok ? '' : 'border-color:var(--c-danger)',
  }, [
    el('h2', { class: 'card-title' }, [
      document.createTextNode('全平台对账'),
      tag(ok ? '一致' : '不一致', ok ? 'tag-ok' : 'tag-danger'),
    ]),
    el('p', { class: 'card-note', text: r.note }),
    el('div', { class: 'grid grid-4' }, [
      metric('明细条数', r.global.detail_count, 'send_log billed'),
      metric('台账条数', r.global.ledger_count, 'credit_ledger consume'),
      metric('条数差', r.global.delta_count, null, r.global.delta_count === 0 ? null : 'is-danger'),
      metric('金额差（毫单位）', r.global.delta_milli, null, r.global.delta_milli === 0 ? null : 'is-danger'),
      metric('已核对账号', r.accounts.checked),
      metric('一致账号', r.accounts.matched, null, 'is-ok'),
      metric('不一致账号', r.accounts.mismatched, null, r.accounts.mismatched === 0 ? null : 'is-danger'),
    ]),
    el('p', { class: 'faint small', style: 'margin-top:12px' },
      ['窗口：' + r.window.from + ' ~ ' + r.window.to + '（UTC+8）']),
  ]))

  var card = el('div', { class: 'card' }, [el('h2', { class: 'card-title', text: '逐账号明细' })])
  if (!r.mismatches.length) {
    card.appendChild(el('div', { class: 'empty', text: '所有账号的明细与台账一致' }))
  } else {
    card.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'tbl' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '账号' }), el('th', { text: '明细条数' }), el('th', { text: '明细毫单位' }),
        el('th', { text: '台账条数' }), el('th', { text: '台账毫单位' }),
      ])]),
      el('tbody', {}, r.mismatches.map(function (m) {
        return el('tr', { class: 'row-danger' }, [
          el('td', {}, [el('button', {
            type: 'button', class: 'linklike mono', text: m.account,
            onclick: function () { openMerchant(m.account) },
          })]),
          el('td', { class: 'num', text: showCount(m.detail_count) }),
          el('td', { class: 'num', text: showCount(m.detail_milli) }),
          el('td', { class: 'num', text: showCount(m.ledger_count) }),
          el('td', { class: 'num', text: showCount(m.ledger_milli) }),
        ])
      })),
    ])]))
  }
  root.appendChild(card)
}

// ═══════════════════════════════════════════════════════════
// 系统
// ═══════════════════════════════════════════════════════════

function loadSystem() {
  var root = $('panel-system')
  root.textContent = ''
  load('/api/admin-actions?limit=50', function (json) {
    State.adminActions = json
    renderSystem(root)
  }, '操作日志加载失败')
}

function renderSystem(root) {
  var s = State.session
  var j = State.adminActions

  root.appendChild(el('div', { class: 'card' }, [
    el('h2', { class: 'card-title', text: '当前后台会话' }),
    el('div', { class: 'grid grid-4' }, [
      metric('管理员', s.admin.username),
      metric('角色', s.admin.role),
      metric('签发时间', fmtTime(s.session.issued_at_ms)),
      metric('过期时间', fmtTime(s.session.expires_at_ms)),
      metric('最后活跃', fmtTime(s.session.last_seen_ms)),
      metric('来源 IP', s.session.ip),
      metric('挂载路径', s.admin_path),
      metric('会话时长（小时）', s.session_ttl_hours),
      metric('cookie Secure', s.cookie_secure),
      metric('TRUST_PROXY', s.trust_proxy),
    ]),
    el('p', { class: 'card-note', style: 'margin-top:12px', text: s.ip_allow_note }),
    el('div', { class: 'row' }, s.ip_allow.map(function (e) { return tag(e, 'tag-info') })),
  ]))

  var tableCard = el('div', { class: 'card' }, [el('h2', { class: 'card-title', text: '管理员操作日志（最近 50 条）' })])
  if (!j || !j.items.length) {
    tableCard.appendChild(el('div', { class: 'empty', text: '暂无数据' }))
  } else {
    tableCard.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'tbl' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '时间' }), el('th', { text: '管理员' }), el('th', { text: '动作' }),
        el('th', { text: '对象' }), el('th', { text: '细节' }),
      ])]),
      el('tbody', {}, j.items.map(function (it) {
        return el('tr', {}, [
          el('td', { text: fmtTime(it.at_ms) }),
          el('td', { text: show(it.admin_name) }),
          el('td', { class: 'mono', text: it.action }),
          el('td', { class: 'mono', text: show(it.target) }),
          el('td', { class: 'mono faint break', text: it.detail ? JSON.stringify(it.detail) : '—' }),
        ])
      })),
    ])]))
  }
  root.appendChild(tableCard)
}

// ═══════════════════════════════════════════════════════════
// 弹窗（写操作）
// ═══════════════════════════════════════════════════════════

function closeModal() {
  var m = $('modal')
  m.hidden = true
  $('modal-body').textContent = ''
  $('modal-actions').textContent = ''
}

function openModal(title, bodyNodes, actions) {
  $('modal-title').textContent = title
  var body = $('modal-body')
  body.textContent = ''
  ;(bodyNodes || []).forEach(function (n) { body.appendChild(n) })
  var act = $('modal-actions')
  act.textContent = ''
  ;(actions || []).forEach(function (a) { act.appendChild(a) })
  $('modal').hidden = false
  var first = body.querySelector('input, select, textarea')
  if (first) first.focus()
}

function reasonField(label, placeholder) {
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-label', text: label || '原因（会写入审计/台账）' }),
    el('input', { type: 'text', class: 'ctrl', placeholder: placeholder || '例：商家投诉重复计费，人工核对后补发' }),
  ])
}

/** 发放/扣减积分。⚠️ 只走服务端的 grantCredits，绝不直接改余额。 */
function openCreditModal(account) {
  var amountInput = el('input', { type: 'text', class: 'ctrl', placeholder: '整数积分，正数加分、负数扣减；不能为 0' })
  var reason = reasonField('原因（写入 credit_ledger.note）')
  openModal('调整积分：' + account, [
    el('p', {}, [
      document.createTextNode('积分调整会以 '),
      el('code', { text: 'credit_ledger' }),
      document.createTextNode(' 的**新增分录**落地，历史分录永不被修改。'),
    ]),
    el('label', { class: 'field' }, [el('span', { class: 'field-label', text: '数量（积分）' }), amountInput]),
    reason,
    el('p', { class: 'faint small', text: '⚠️ 扣减不允许把余额扣成负数（服务端会拒绝并说明当前余额）。' }),
  ], [
    el('button', { type: 'button', class: 'btn', text: '取消', onclick: closeModal }),
    el('button', {
      type: 'button', class: 'btn btn-primary', style: 'width:auto', text: '提交',
      onclick: function () {
        var amount = Number(amountInput.value)
        var rs = reason.querySelector('input').value.trim()
        if (!isFinite(amount) || Math.floor(amount) !== amount) { showError('提交失败', '数量必须是整数积分'); return }
        if (!rs) { showError('提交失败', '必须填写原因'); return }
        post('/api/merchant/' + encodeURIComponent(account) + '/credit', { amount: amount, reason: rs })
          .then(function (res) {
            closeModal()
            clearError()
            if (res.warning) showError('已提交，但有提醒', res.warning)
            loadMerchantAfterWrite(account)
          })
          .catch(function (e) { showError('提交失败', e.message) })
      },
    }),
  ])
}

function openStatusModal(account, currentStatus) {
  var next = currentStatus === 'disabled' ? 'active' : 'disabled'
  var reason = reasonField('原因（写入 admin_action_log）')
  openModal((next === 'disabled' ? '停用账号：' : '启用账号：') + account, [
    next === 'disabled'
      ? el('p', {}, ['停用会**同时吊销该账号全部会话**，客户端会立刻收到 403 并停机。'])
      : el('p', {}, ['启用后客户端可以用原密码重新登录。套餐已到期时无法启用（需先续期）。']),
    reason,
  ], [
    el('button', { type: 'button', class: 'btn', text: '取消', onclick: closeModal }),
    el('button', {
      type: 'button', class: 'btn ' + (next === 'disabled' ? 'btn-danger' : 'btn-primary'),
      style: 'width:auto', text: next === 'disabled' ? '确认停用' : '确认启用',
      onclick: function () {
        var rs = reason.querySelector('input').value.trim()
        if (!rs) { showError('提交失败', '必须填写原因'); return }
        post('/api/merchant/' + encodeURIComponent(account) + '/status', { status: next, reason: rs })
          .then(function () { closeModal(); clearError(); loadMerchantAfterWrite(account) })
          .catch(function (e) { showError('提交失败', e.message) })
      },
    }),
  ])
}

function openRevokeModal(account) {
  var reason = reasonField('原因（写入 device_session.revoked_reason）')
  openModal('吊销会话：' + account, [
    el('p', {}, ['该账号全部未失效会话会被吊销，客户端下一个请求收到 401 并重新登录。']),
    reason,
  ], [
    el('button', { type: 'button', class: 'btn', text: '取消', onclick: closeModal }),
    el('button', {
      type: 'button', class: 'btn btn-danger', style: 'width:auto', text: '确认吊销',
      onclick: function () {
        post('/api/session/revoke', { account: account, reason: reason.querySelector('input').value.trim() || 'admin_revoke' })
          .then(function () { closeModal(); clearError(); loadMerchantAfterWrite(account) })
          .catch(function (e) { showError('吊销失败', e.message) })
      },
    }),
  ])
}

function openRevokeAll() {
  var reason = reasonField('原因（写入 device_session.revoked_reason）')
  openModal('吊销全平台会话', [
    el('p', {}, ['⚠️ 这会吊销**所有商家**的会话——全体商家需要重新登录。请确认这是有意的。']),
    reason,
  ], [
    el('button', { type: 'button', class: 'btn', text: '取消', onclick: closeModal }),
    el('button', {
      type: 'button', class: 'btn btn-danger', style: 'width:auto', text: '确认全部吊销',
      onclick: function () {
        post('/api/session/revoke', { all: true, reason: reason.querySelector('input').value.trim() || 'admin_revoke_all' })
          .then(function (res) {
            closeModal(); clearError()
            showError('已执行', '吊销 ' + showCount(res.revoked_sessions) + ' 个会话。' + res.note)
            loadMerchants()
          })
          .catch(function (e) { showError('吊销失败', e.message) })
      },
    }),
  ])
}

/** 写操作之后刷新详情（并给出可读的失败提示）。 */
function loadMerchantAfterWrite(account) {
  if (State.currentAccount === account) {
    State.detail = null
    renderMerchant()
  } else {
    loadMerchants()
  }
}

// ═══════════════════════════════════════════════════════════
// 口径说明
// ═══════════════════════════════════════════════════════════

function openHelp() {
  openModal('看板口径说明', [
    el('p', {}, ['本后台**不做任何算术**。所有数字由服务端 shared/lib/stats.js 计算，与商家端是同一份实现。']),
    el('p', {}, ['回复成功率 = 平台确认成功条数 ÷ 发送尝试条数。分母为 0 时显示 —，不显示 100%。']),
    el('p', {}, ['四个判定分别统计，绝不合并：平台确认（计费）/ 仅 DOM 判据（不计费）/ 疑似（不计费）/ 失败（不计费）。']),
    el('p', {}, ['「已回复人数」只统计平台确认送达的去重用户，DOM 判据与疑似不计入。']),
    el('p', {}, ['积分只对平台确认成功的发送扣减（红线 2）。台账 append-only，纠错走反向分录。']),
    el('p', {}, ['取证页的「生效值」来自 policy_ack_log（客户端确认应用过的那一版），不是当前下发的策略（红线 3）。']),
  ], [el('button', { type: 'button', class: 'btn', text: '知道了', onclick: closeModal })])
}

// ═══════════════════════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════════════════════

function boot() {
  $('login-form').addEventListener('submit', doLogin)
  $('btn-logout').addEventListener('click', doLogout)
  $('btn-refresh').addEventListener('click', function () { switchPanel(State.activePanel || 'overview') })
  $('btn-help').addEventListener('click', openHelp)
  $('modal').addEventListener('click', function (ev) { if (ev.target === $('modal')) closeModal() })
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeModal() })

  State.activePanel = 'overview'
  renderTabs()

  // ⚠️ 先问一次会话：cookie 有效就直接进主界面，避免每次都看到登录页闪一下。
  get('/api/session').then(function (s) {
    State.session = s
    renderAuth()
    switchPanel('overview')
  }).catch(function (e) {
    if (e.status === 401) {
      State.session = null
      renderAuth()
    } else {
      // 非鉴权类失败（服务端 500、静态资源缺失…）必须显式说出来，
      // 否则用户看到的是一个永远转圈的登录页。
      renderAuth()
      var msg = $('login-msg')
      if (msg) msg.textContent = '无法连接后台接口：' + e.message
    }
  })
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
else boot()
