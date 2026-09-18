'use strict'

// client/platform/page-profile.js
//
// 私信页面模型：从评论/弹幕行定位到用户，打开私信会话，发送私信。
//
// ⚠️ 私信是三条链路里**最容易踩红线 3** 的一条，因为私信必须知道"发给谁"，
//    而"谁"在抖音里就是 `sec_uid`。legacy 直接把 `sec_uid` 写进了本地 JSON。
//
//    本项目的处理方式：
//      · `sec_uid` **只在本次操作的进程内存里存在**，用于在页面上定位目标；
//      · 落盘与上报一律用 `hmac(privacy_salt, sec_uid)` 的哈希（红线 3）；
//      · 本文件**不提供**任何"返回 sec_uid 给调用方去存"的接口——
//        只提供"跳转并打开会话"这个动作。
//
//    （为什么不像弹幕那样完全不取：私信必须真的跳到那个人的会话页，
//      这是页面操作，无法只用哈希完成。区别在于**用完即弃、绝不落盘**。）
//
// ⚠️ 私信链路的第二个坑：**提取不到 `sec_uid` 时必须跳过而不是猜**。
//    猜错的后果是给陌生人发私信——这既是骚扰，也是最容易被平台判定为
//    营销号的行为。契约把这种情况定义为 `not_locatable` 跳过。

const selectors = require('./selectors')
const { WorkbenchError } = require('../core/workbench-error')

const CHANNEL = 'dm'

/** 抖音用户主页/私信路径前缀（用于识别并解码 sec_uid） */
const USER_PATH_RE = /\/user\/([^/?#]+)/i

const VISIBLE_JS = `function __visible(el){
  if(!el) return false;
  var r=el.getBoundingClientRect();
  if(r.width<=0||r.height<=0) return false;
  var s=getComputedStyle(el);
  if(s.display==='none'||s.visibility==='hidden') return false;
  return true;
}`

class ProfilePage {
  /**
   * @param {object} opts
   * @param {object} opts.host
   * @param {string} [opts.role]
   * @param {object} [opts.logger]
   * @param {object} [opts.sel]
   */
  constructor(opts) {
    if (!opts || !opts.host) throw new Error('ProfilePage 需要 host')
    this.host = opts.host
    this.role = opts.role || 'profile'
    this.logger = opts.logger || null
    this.sel = opts.sel || selectors
  }

  #log(level, msg, detail) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](msg, detail)
  }

  /**
   * 在当前页面里，从某个元素出发向上/向下找出目标用户的资料路径。
   *
   * ⚠️ 只在**当前页面**找，不新开标签页。理由见文件头：
   *    这一步只为了拿到跳转目标，用完即弃。
   *
   * @param {object} p
   * @param {string} p.role 页面角色（comment / live）
   * @param {string} p.anchorText 目标评论/弹幕的正文（用于定位所在行）
   * @param {string} [p.userName] 目标昵称（可提高定位精度）
   * @returns {Promise<{found:boolean, profilePath?:string, reason?:string}>}
   */
  async resolveUserPath({ role, anchorText, userName }) {
    const q = JSON.stringify(normalizeText(anchorText))
    const n = JSON.stringify(normalizeText(userName))

    const expr = `(function(){
      function norm(s){
        return String(s||'')
          .replace(/[\\u200b-\\u200f\\ufeff]/g,'')
          .replace(/[\\s\\[\\]，。,.!！?？:：;；、"'“”‘’()\\[\\]{}<>《》【】（）\\-_=+~\`@#$%^&*|\\/\\\\]/g,'')
          .toLowerCase();
      }
      var q=${q}, n=${n};
      var all=Array.from(document.querySelectorAll('*'));
      // 找"文本包含目标正文"的**最深**元素（避免命中整个页面容器）
      var hit=null;
      for(var i=0;i<all.length;i++){
        var el=all[i];
        if(el.children && el.children.length>0){
          // 只考虑叶子或近叶子，避免命中 body
          if(el.children.length>3) continue;
        }
        var t=norm(el.innerText||el.textContent||'');
        if(t && t.indexOf(q)>=0){ hit=el; break; }
      }
      if(!hit) return {found:false, reason:'anchor_not_found'};
      // 从命中点及祖先里找 /user/<sec_uid> 链接
      var a=hit;
      for(var d=0; d<6 && a; d++, a=a.parentElement){
        var links=Array.from(a.querySelectorAll('a[href]'));
        for(var L=0;L<links.length;L++){
          var href=links[L].getAttribute('href')||'';
          var m=href.match(/\\/user\\/([^\\/?#]+)/i);
          if(!m) continue;
          if(n && n.length>1){
            var own=norm(a.innerText||'');
            if(own.indexOf(n)<0) continue;
          }
          return {found:true, profilePath:'/user/'+m[1]};
        }
        var ph=a.getAttribute&&a.getAttribute('href');
        if(ph){ var m2=ph.match(/\\/user\\/([^\\/?#]+)/i); if(m2) return {found:true, profilePath:'/user/'+m2[1]}; }
      }
      return {found:false, reason:'no_profile_link_near_anchor'};
    })()`

    const r = await this.#evaluate(role || this.role, expr, { defaultValue: { found: false, reason: 'evaluate_failed' } })
    if (!r || !r.found) {
      // ⚠️ 取不到就是取不到。**绝不猜**——猜错 = 给陌生人发私信。
      this.#log('info', 'dm_target_not_locatable', { reason: r ? r.reason : 'null' })
      return { found: false, reason: r ? r.reason : 'null' }
    }
    return { found: true, profilePath: r.profilePath }
  }

  /**
   * 打开与某用户的私信会话。
   *
   * @param {string} profilePath 形如 `/user/MS4wLj...`
   */
  async openConversation(profilePath, { timeoutMs = 20000 } = {}) {
    if (!profilePath || !USER_PATH_RE.test(profilePath)) {
      throw new WorkbenchError('NOT_LOCATABLE', `非法的用户路径：${profilePath}`, { profile_path: profilePath })
    }

    // ⚠️ 私信页要用**新标签页**（计划 §4.6 第 4 条：长期复用的页面会退化）。
    //    而且私信页与评论页共用标签会互相导航，导致"评论发到私信页"这类错乱。
    const url = `https://www.douyin.com${profilePath}`
    await this.host.ensureTab(this.role, url, { fresh: true })

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = await this.#evaluate(this.role, `(function(){
        ${VISIBLE_JS}
        // 会话输入框：私信页有且只有一个可见的可编辑输入区
        var eds=Array.from(document.querySelectorAll('[contenteditable=true],textarea'));
        var ready=null;
        for(var i=0;i<eds.length;i++){ if(__visible(eds[i])){ ready=eds[i]; break; } }
        var body=String(document.body?document.body.innerText:'').slice(0,20000);
        return {
          has_input: !!ready,
          requires_login: /\\u767b\\u5f55|\\u626b\\u7801\\u767b\\u5f55|\\u8bf7\\u5148\\u767b\\u5f55/.test(body),
          is_404: /\\u9875\\u9762\\u4e0d\\u5b58\\u5728|\\u627e\\u4e0d\\u5230\\u8be5\\u7528\\u6237/.test(body)
        };
      })()`, { defaultValue: { has_input: false } })

      if (state && state.requires_login) {
        // ⚠️ 专用浏览器里的登录态丢了。这不是"重试就好"的故障——
        //    必须让商家知道要去那个浏览器里重新登录（我们不碰 Cookie）。
        throw new WorkbenchError(
          'LOGIN_EXPIRED',
          '专用浏览器里的抖音登录态已失效。请在该浏览器窗口里重新登录后再启动自动回复。',
          { url }
        )
      }
      if (state && state.is_404) {
        throw new WorkbenchError('NOT_LOCATABLE', '该用户主页不存在或已被封禁', { url })
      }
      if (state && state.has_input) return { ok: true, url }
      await sleep(700)
    }
    throw new WorkbenchError('ELEMENT_TIMEOUT', '私信输入框在预算时间内未出现', {
      selector: 'inlineEditor', url, timeout_ms: timeoutMs,
    })
  }

  /**
   * 发送私信。
   *
   * ⚠️ 与评论区/弹幕不同，私信的提交**没有可靠的 Enter 语义**：
   *    会话页的 Enter 常常是"换行"而不是"发送"（平台在不同入口行为不一致）。
   *    所以这里采用 legacy 的做法：优先点发送按钮，Enter 作为兜底。
   *    而无论走哪条路径，**成功判定都只能来自 `im/send` 的响应体**。
   */
  async findSendButton() {
    const r = await this.#evaluate(this.role, `(function(){
      ${VISIBLE_JS}
      // 发送按钮：可见、文本是「发送」，或是一个含 send 语义的可点元素
      var cands=Array.from(document.querySelectorAll('button,[role="button"],span,div'));
      for(var i=0;i<cands.length;i++){
        var e=cands[i];
        if(e.children && e.children.length>1) continue;
        var t=String(e.innerText||e.textContent||'').replace(/\\s+/g,'').trim();
        if(t!=='\\u53d1\\u9001' && t!=='Send') continue;
        if(!__visible(e)) continue;
        var r=e.getBoundingClientRect();
        return {ok:true, x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};
      }
      return {ok:false, reason:'send_button_not_found'};
    })()`, { defaultValue: { ok: false, reason: 'evaluate_failed' } })
    return r
  }

  /**
   * 确认私信输入框已聚焦（发送前的最后一道检查）。
   *
   * ⚠️ 存在的理由：私信页在打开后会异步把焦点抢走（自动聚焦到搜索框之类）。
   *    不检查就输入，文字会进到**搜索框**里——而搜索框按 Enter 会跳转页面，
   *    表现是"发完私信页面就变了"。
   */
  async focusInput() {
    const r = await this.#evaluate(this.role, `(function(){
      ${VISIBLE_JS}
      var eds=Array.from(document.querySelectorAll('[contenteditable=true],textarea'));
      for(var i=0;i<eds.length;i++){
        var ed=eds[i];
        if(!__visible(ed)) continue;
        ed.focus();
        var r=ed.getBoundingClientRect();
        var tag=(ed.tagName||'').toLowerCase();
        var isSearch=false;
        var a=ed, d=0;
        while(a && d<5){ var c=((a.className||'')+'').toLowerCase()+((a.getAttribute&&a.getAttribute('placeholder'))||'');
          if(c.indexOf('search')>=0||c.indexOf('\\u641c\\u7d22')>=0){ isSearch=true; break; }
          a=a.parentElement; d++; }
        if(isSearch) continue;
        return {ok:true, x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2),
                focused:(document.activeElement===ed)};
      }
      return {ok:false, reason:'dm_input_not_found'};
    })()`, { defaultValue: { ok: false, reason: 'evaluate_failed' } })

    if (!r || !r.ok) {
      throw new WorkbenchError('ELEMENT_TIMEOUT', '未找到私信输入框', {
        selector: 'inlineEditor', reason: r ? r.reason : 'null',
      })
    }
    return r
  }

  async #evaluate(role, expression, { defaultValue, timeoutMs } = {}) {
    try {
      const r = await this.host.evaluate(role, expression, { returnByValue: true, timeoutMs })
      return r === undefined ? defaultValue : r
    } catch (e) {
      if (defaultValue !== undefined) return defaultValue
      throw e
    }
  }
}

/**
 * 归一化文本（与 page-comment / page-live 同一套规则）。
 *
 * ⚠️ 三处必须一致。不一致的后果是"在评论区能匹配到、在私信页匹配不到"，
 *    而这类问题会被误判成"页面改版"，浪费大量排查时间。
 *    （将来若再抽一层，就把它移到 shared —— 但**不能**放到 core/，
 *      core 不许有平台知识。）
 */
function normalizeText(s) {
  return String(s || '')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[\s[\]，。,.!！?？:：;；、"'“”‘’()[\]{}<>《》【】（）\-_=+~`@#$%^&*|/\\]/g, '')
    .toLowerCase()
}

/**
 * 从会话数据里提取会话 ID（用于私信去重键）。
 *
 * ⚠️ 只返回**哈希输入**，不返回 `sec_uid` 给调用方存盘。
 *    调用方应立刻 `privacyHash(secUid, salt)` 再落盘。
 */
function extractSecUidFromPath(profilePath) {
  const m = USER_PATH_RE.exec(String(profilePath || ''))
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch (e) {
    // URL 解码失败（畸形百分号编码）时返回原始片段即可——
    // 它的用途只是做哈希输入，不是要还原成有效 URL。
    return m[1]
  }
}

function sleep(ms) {
  return new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref() })
}

module.exports = {
  ProfilePage,
  CHANNEL,
  USER_PATH_RE,
  normalizeText,
  extractSecUidFromPath,
  VISIBLE_JS,
}
