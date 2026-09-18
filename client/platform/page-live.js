'use strict'

// client/platform/page-live.js
//
// 直播间页面模型：弹幕采集 + 弹幕回复。
//
// ⚠️ 直播间的 DOM 比评论区**更不稳定**：弹幕没有稳定的 `data-e2e`，
//    legacy 用的是 7 个模糊匹配（`live_dom_collector.js:349-357`），
//    `selectors.js` 里对应的 confidence 也因此标成 `low`。
//    所以本文件的设计取向是**宁缺勿错**：
//      · 解析不出「用户 + 正文」两段的行，直接丢弃，不做猜测；
//      · 已知的系统消息（进入直播间/点赞/关注…）显式排除；
//      · 每行都带 `rowKey` 供去重，避免同一弹幕被反复回复。
//
// ⚠️ 弹幕回复与评论回复有一个**本质区别**：弹幕发出去之后就消失在滚动流里，
//    **无法用 DOM 回读验证**。所以弹幕的成功判定**只能**来自平台响应体
//    （`live/comment/send` 的 `status_code`）。DOM 判据在这里连
//    `sent_confirmed_dom` 都给不出来——这一点必须写进上层逻辑，
//    不能指望"再看看页面上有没有"。

const selectors = require('./selectors')
const { WorkbenchError } = require('../core/workbench-error')

const CHANNEL = 'live_danmaku'

/** 系统消息前缀：这些不是用户发言，绝不能回复（回复它们等于对空气说话） */
const SYSTEM_MESSAGE_PREFIXES = Object.freeze([
  '进入直播间', '加入了直播间', '点赞了', '关注了主播', '分享了直播间',
  '送出', '赠送', '来了', '拍了拍', '成为了粉丝', '加入了粉丝团',
  '欢迎', '感谢', '主播', '系统',
])

/** 界面文案（不是弹幕）的完整行，命中即排除 */
const UI_LABELS = Object.freeze([
  '直播间', '全部评论', '互动消息', '在线人数', '发消息', '说点什么',
  '聊天', '公屏', '礼物', '排行榜',
])

const NORMALIZE_JS = `function __norm(s){
  return String(s||'')
    .replace(/[\\u200b-\\u200f\\ufeff]/g,'')
    .replace(/[\\u00a0]/g,' ')
    .replace(/\\s+/g,' ')
    .trim();
}`

const VISIBLE_JS = `function __visible(el){
  if(!el) return false;
  var r=el.getBoundingClientRect();
  if(r.width<=0||r.height<=0) return false;
  var s=getComputedStyle(el);
  if(s.display==='none'||s.visibility==='hidden') return false;
  return true;
}`

class LivePage {
  /**
   * @param {object} opts
   * @param {object} opts.host
   * @param {string} [opts.role]
   * @param {object} [opts.logger]
   * @param {object} [opts.sel]
   */
  constructor(opts) {
    if (!opts || !opts.host) throw new Error('LivePage 需要 host')
    this.host = opts.host
    this.role = opts.role || 'live'
    this.logger = opts.logger || null
    this.sel = opts.sel || selectors
    /** 已见过的弹幕行键（进程内去重，跨重启靠调用方的 dedupKey） */
    this.seenRowKeys = new Set()
    this.seenLimit = 5000
  }

  #log(level, msg, detail) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](msg, detail)
  }

  #css(key) {
    const spec = this.sel[key]
    if (!spec || !Array.isArray(spec.candidates) || !spec.candidates.length) {
      throw new WorkbenchError('SELECTOR_MISS', `selectors.js 中不存在可用选择器 ${key}`, { selector: key })
    }
    return spec.candidates[0]
  }

  /** 打开直播间并等到弹幕容器出现。 */
  async open(roomUrl, { timeoutMs = 30000 } = {}) {
    const css = this.#css('danmakuRow')
    await this.host.ensureTab(this.role, roomUrl, { fresh: false })
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const n = await this.#evaluate(
        `(function(){
          ${VISIBLE_JS}
          var els=Array.from(document.querySelectorAll(${JSON.stringify(css)}));
          var c=0; for(var i=0;i<els.length;i++){ if(__visible(els[i])) c++; }
          return c;
        })()`,
        { defaultValue: 0 }
      )
      if (n > 0) return { ok: true, rows: n }

      // ⚠️ 直播已结束 / 回放页没有弹幕。这不是"还没加载完"，
      //    继续等下去只是浪费时间并让队列堆积。显式判出来。
      const ended = await this.#evaluate(
        `(function(){
          var t=String(document.body?document.body.innerText:'').slice(0,20000);
          return /\\u76f4\\u64ad\\u5df2\\u7ed3\\u675f|\\u76f4\\u64ad\\u7ed3\\u675f|\\u56de\\u653e/.test(t);
        })()`,
        { defaultValue: false }
      )
      if (ended) {
        throw new WorkbenchError('NOT_LOCATABLE', '直播间已结束或正在回放，没有可回复的弹幕', {
          url: roomUrl,
        })
      }
      await sleep(800)
    }
    throw new WorkbenchError('ELEMENT_TIMEOUT', '弹幕容器在预算时间内未出现', {
      selector: 'danmakuRow', timeout_ms: timeoutMs,
    })
  }

  /**
   * 采集当前可见弹幕。
   *
   * ⚠️ 解析规则直接继承 legacy `live_dom_collector.js:319-347` 的经验：
   *    · 行内按换行切，第一行是昵称、其余拼成正文；
   *    · 只有一行时尝试 `昵称: 正文` 的形态；
   *    · 少于两段就**丢弃**（宁缺勿错，见文件头说明）；
   *    · 已知系统消息与界面文案显式排除。
   *
   * ⚠️ 返回**不含** `secUid` / 头像 / 资料页链接。
   *    直播间行里确实能拿到这些（legacy 就这么做的），但红线 3 要求
   *    只上传哈希，而定位私信目标需要的是 DOM 上的点击路径，
   *    不是把 `sec_uid` 抄进本地文件。所以这里刻意不取。
   *
   * @returns {Promise<Array<{rowKey,user,text,userId,rect}>>}
   */
  async collect({ limit = 100 } = {}) {
    const css = this.#css('danmakuRow')
    const expr = `(function(){
      ${NORMALIZE_JS}
      ${VISIBLE_JS}
      function attr(el,names){
        for(var i=0;i<names.length;i++){ var v=el.getAttribute&&el.getAttribute(names[i]); if(v) return String(v); }
        return '';
      }
      function lines(el){
        var raw=String((el&&(el.innerText||el.textContent))||'').split(/\\n+/);
        var out=[];
        raw.forEach(function(l){ var v=__norm(l); if(v && out.indexOf(v)<0) out.push(v); });
        return out;
      }
      var sel=${JSON.stringify(css)};
      var nodes=[];
      try{ nodes=Array.from(document.querySelectorAll(sel)); }catch(e){ nodes=[]; }
      var rows=[], seen={};
      for(var i=0;i<nodes.length && rows.length<${Number(limit)};i++){
        var el=nodes[i];
        if(!__visible(el)) continue;
        var ls=lines(el);
        if(ls.length===1){
          var m=ls[0].match(/^(.{1,32})[:\\uff1a]\\s*(.{1,220})$/);
          if(m) ls=[m[1].trim(), m[2].trim()];
        }
        if(ls.length<2) continue;
        var user=ls[0].replace(/^@/,'').trim();
        var text=ls.slice(1).join(' ').trim();
        if(!user||!text||user.length>48||text.length>260) continue;
        var key=user+'|'+text;
        if(seen[key]) continue;
        seen[key]=1;
        var r=el.getBoundingClientRect();
        rows.push({
          rowKey:(attr(el,['data-id','data-msg-id','data-message-id','data-comment-id','data-key'])||key).slice(0,240),
          user:user,
          text:text,
          userId:attr(el,['data-user-id','data-uid']),
          rect:{x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}
        });
      }
      return { ok:true, rows:rows, matched_nodes:nodes.length,
               url:location.href, title:(document.title||'').slice(0,200) };
    })()`

    const r = await this.#evaluate(expr, { defaultValue: { ok: false, rows: [] } })
    if (!r || r.ok !== true) {
      throw new WorkbenchError('SELECTOR_MISS', '弹幕选择器全部未命中（直播间结构可能已改版）', {
        selector: 'danmakuRow',
      })
    }

    // 排除系统消息与界面文案
    const filtered = []
    for (const row of r.rows) {
      if (isSystemMessage(row.text) || UI_LABELS.includes(row.user)) continue
      if (this.seenRowKeys.has(row.rowKey)) continue
      filtered.push(row)
    }

    // ⚠️ 采样诊断信息一并返回。弹幕选择器是 `low` confidence，
    //    "匹配到多少节点、解析出多少行"是判断改版的唯一线索——
    //    没有它，运营只能说"弹幕不出来了"，而开发无从下手。
    return Object.assign(filtered, {
      diagnostics: {
        matched_nodes: r.matched_nodes,
        parsed_rows: r.rows.length,
        filtered_rows: filtered.length,
        url: r.url,
        title: r.title,
      },
    })
  }

  /** 记住已见行（避免同一弹幕被反复处理）。 */
  markSeen(rowKey) {
    this.seenRowKeys.add(rowKey)
    if (this.seenRowKeys.size > this.seenLimit) {
      // 保留最近一半，避免无限增长。Set 的插入序即迭代序。
      const arr = [...this.seenRowKeys]
      this.seenRowKeys = new Set(arr.slice(-Math.floor(this.seenLimit / 2)))
    }
  }

  /**
   * 打开直播间的弹幕输入框并聚焦。
   *
   * ⚠️ 与评论区不同，弹幕只有**一个**输入框，不存在"发错地方"的风险。
   *    但仍要确认它是**直播间公屏**的输入框，而不是私信或搜索框——
   *    判据是它所在的容器带 chatroom/danmaku 类特征。
   */
  async focusInput() {
    const expr = `(function(){
      ${VISIBLE_JS}
      function inChat(el){
        var a=el, d=0;
        while(a && d<6){ var c=((a.className||'')+'').toLowerCase();
          if(c.indexOf('chatroom')>=0||c.indexOf('danmu')>=0||c.indexOf('chat')>=0) return true;
          a=a.parentElement; d++; }
        return false;
      }
      var eds=Array.from(document.querySelectorAll('[contenteditable=true],textarea'));
      for(var i=0;i<eds.length;i++){
        var ed=eds[i];
        if(!__visible(ed)) continue;
        if(!inChat(ed)) continue;
        ed.focus();
        var r=ed.getBoundingClientRect();
        return {ok:true, x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};
      }
      return {ok:false, reason:'chat_input_not_found'};
    })()`

    const r = await this.#evaluate(expr, { defaultValue: { ok: false, reason: 'evaluate_failed' } })
    if (!r || !r.ok) {
      throw new WorkbenchError('ELEMENT_TIMEOUT', '未找到直播间公屏输入框', {
        selector: 'danmakuRow', reason: r ? r.reason : 'null',
      })
    }
    return r
  }

  async #evaluate(expression, { defaultValue, timeoutMs } = {}) {
    try {
      const r = await this.host.evaluate(this.role, expression, { returnByValue: true, timeoutMs })
      return r === undefined ? defaultValue : r
    } catch (e) {
      if (defaultValue !== undefined) return defaultValue
      throw e
    }
  }
}

/** 是否为系统消息（不是用户发言）。 */
function isSystemMessage(text) {
  const t = String(text || '').replace(/\s+/g, '')
  if (!t) return true
  return SYSTEM_MESSAGE_PREFIXES.some((p) => t.startsWith(p))
}

function sleep(ms) {
  return new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref() })
}

module.exports = {
  LivePage,
  CHANNEL,
  SYSTEM_MESSAGE_PREFIXES,
  UI_LABELS,
  isSystemMessage,
  NORMALIZE_JS,
  VISIBLE_JS,
}
