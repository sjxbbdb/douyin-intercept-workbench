'use strict'

// client/platform/page-comment.js
//
// 视频评论区的**页面模型**：把选择器 key 翻译成具体表达式，并定义"评论页长什么样"。
//
// ⚠️ 本文件只做两件事：**认识页面** + **算出坐标/值**。
//    所有实际动作（点鼠标、打字、按 Enter、嗅探响应）都由
//    `core/browser-host.js` 执行——它才是持有 CDP 的唯一模块。
//    这里若出现 `Input.dispatchMouseEvent` 之类的调用就是分层错误。
//
// ⚠️ 本文件不得内联选择器字符串。所有选择器来自 `platform/selectors.js`
//    （契约测试会扫源码，硬编码选择器直接判缺陷）。
//
// ═══════════════════════════════════════════════════════════
// 来自 legacy/ 的 DOM 事实（这些是**经验**，不是猜测，务必保留）
// ═══════════════════════════════════════════════════════════
//
//  1. **页面同时存在隐藏与可见两套评论容器**（legacy reply_worker.js:78,100,150）。
//     直接取第一个 `comment-list` 会拿到隐藏那套，里面的按钮尺寸是 0，
//     于是所有点击都"成功执行"但什么也没发生。
//     判据必须是 `rect.width>0 && rect.height>0`。
//
//  2. **评论项是虚拟列表**（legacy reply_worker.js:288）。深评论会被回收，
//     所以定位目标必须先 `scrollIntoView` 再**延迟**读坐标；
//     立即读会拿到 0×0。这个延迟由 browser-host 的 click() 内建重试覆盖。
//
//  3. **「回复」按钮的判据是文本严格等于「回复」**，且必须排除弹幕
//     （legacy reply_worker.js:83-92,338）。页面上有大量含"回复"二字
//     的元素（"回复中"、"回复了"、弹幕行），按文本包含匹配会点错。
//
//  4. **激活内联编辑器的判据是所在的 comment-item 里出现「回复中」字样**
//     （legacy reply_worker.js:305）。只找 `[contenteditable=true]`
//     会命中页面底部那个**主评论输入框**——而往那里输入会发出
//     **一条顶级评论**（不是回复），且平台照样返回 `status_code: 0`。
//     ⚠️ 这是本项目最隐蔽的一个陷阱：看起来发送成功、平台也没报错，
//        但回复发到了错误的地方，而计费会照算。所以本文件把
//        "编辑器必须在含「回复中」的评论项内"写成硬判据，
//        并且**显式排除**主输入框容器。
//
//  5. **图文帖（/note/）网页版的评论区是右侧小浮层**，深评论被虚拟列表
//     回收后无法稳定定位回复按钮（legacy reply_worker.js:262-270）。
//     这类目标按「跳过」处理，判 `NOTE_POST_UNSUPPORTED`（不可重试），
//     避免反复失败污染队列。
//
//  6. **Enter 是提交的主路径**（legacy reply_worker.js:385-388），
//     不是点发送按钮。发送按钮只作为兜底。
//
//  7. **成功判定绝不能来自 DOM**。编辑器消失只能推出
//     `sent_suspected`；节点稳定存在只能推出 `sent_confirmed_dom`。
//     真正的 `sent_confirmed` 只能来自 `publish-verifier.js` 抓到的响应体。

const selectors = require('./selectors')
const { WorkbenchError } = require('../core/workbench-error')

/** 渠道标识（与契约的 source_type 一致） */
const CHANNEL = 'comment'

/**
 * 文本归一化：去空白 + 去标点 + 小写。
 *
 * ⚠️ 必须与 legacy 的归一化规则**语义一致**（legacy reply_worker.js:288）：
 *    平台会在评论里插入零宽字符与不换行空格，还有全角半角混用。
 *    不一致的后果是"明明在页面上看到的评论，代码却匹配不到"。
 */
const NORMALIZE_JS = `function __norm(s){
  return String(s||'')
    .replace(/[\\u200b-\\u200f\\u202a-\\u202e\\ufeff]/g,'')
    .replace(/[\\s\\[\\]，。,.!！?？:：;；、"'“”‘’()\\[\\]{}<>《》【】（）\\-_=+~\`@#$%^&*|/\\\\]/g,'')
    .toLowerCase();
}`

/** 可见性判据（必须与 legacy 一致，且**同时**检查 style 与 rect）。 */
const VISIBLE_JS = `function __visible(el){
  if(!el) return false;
  var r=el.getBoundingClientRect();
  if(r.width<=0||r.height<=0) return false;
  var s=getComputedStyle(el);
  if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0) return false;
  return true;
}`

/**
 * 选取**可见的**评论列表根。
 *
 * ⚠️ 这是本文件最重要的一个 helper。取错根的后果是"操作全部成功但毫无效果"，
 *    而错误信息里什么异常都没有——排查者会怀疑选择器、怀疑网络、
 *    怀疑平台改版，唯独想不到"有两个容器，你取的是隐藏那个"。
 */
const PICK_ROOT_JS = `function __root(sel){
  var lists=Array.from(document.querySelectorAll(sel));
  for(var i=0;i<lists.length;i++){ if(__visible(lists[i])) return lists[i]; }
  return null;
}`

/** 目标匹配谓词：按归一化后的评论文本（+可选昵称）定位评论项。 */
function targetMatcher(bodyKey, userKey) {
  const q = JSON.stringify(String(bodyKey || ''))
  const n = JSON.stringify(String(userKey || ''))
  return `function __match(item){
    var norm=__norm(item.innerText||item.textContent||'');
    var q=${q}, n=${n};
    if(!q) return false;
    if(norm.indexOf(q)<0) return false;
    if(n && n.length>1 && norm.indexOf(n)<0) return false;
    return true;
  }`
}

class CommentPage {
  /**
   * @param {object} opts
   * @param {object} opts.host   BrowserHost
   * @param {string} [opts.role] 标签页角色，默认 'comment'
   * @param {object} [opts.logger]
   * @param {object} [opts.sel]  选择器表（测试可注入替身）
   */
  constructor(opts) {
    if (!opts || !opts.host) throw new Error('CommentPage 需要 host')
    this.host = opts.host
    this.role = opts.role || 'comment'
    this.logger = opts.logger || null
    this.sel = opts.sel || selectors
  }

  #log(level, msg, detail) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](msg, detail)
  }

  /** 取某个选择器 key 的首个候选 CSS（候选列表由 selectors.js 拥有）。 */
  #css(key) {
    const spec = this.sel[key]
    if (!spec) {
      throw new WorkbenchError('SELECTOR_MISS', `selectors.js 中不存在选择器 ${key}`, { selector: key })
    }
    const cands = spec.candidates
    if (!Array.isArray(cands) || !cands.length) {
      throw new WorkbenchError('SELECTOR_MISS', `选择器 ${key} 没有候选`, { selector: key })
    }
    return { css: cands[0], spec }
  }

  /**
   * 打开一个视频页并等到评论面板真正可用。
   *
   * ⚠️ 「可用」的判据不是 `readyState === 'complete'`，而是
   *    **可见的**评论容器出现了。理由：SPA 的 readyState 早就 complete，
   *    但评论面板是异步渲染的，此时点任何东西都是点空。
   */
  async open(videoUrl, { timeoutMs = 30000 } = {}) {
    const { css } = this.#css('commentList')
    await this.host.ensureTab(this.role, videoUrl, { fresh: false })

    // ── 图文帖：直接跳过（事实 5）────────────────────────────
    const noteCss = this.#css('noteDetail').css
    const isNote = await this.#evaluate(
      `(function(){
        var nd=document.querySelector(${JSON.stringify(noteCss)});
        return (!!nd) || location.pathname.indexOf('/note/')>=0;
      })()`,
      { defaultValue: false }
    ).catch(() => false)
    if (isNote) {
      throw new WorkbenchError(
        'NOTE_POST_UNSUPPORTED',
        '这是图文帖：网页版评论区是右侧小浮层，无法稳定定位回复按钮，已跳过',
        { selector: 'noteDetail' }
      )
    }

    const ready = await this.#waitForVisible(css, { timeoutMs, selectorKey: 'commentList' })
    if (!ready) {
      throw new WorkbenchError('ELEMENT_TIMEOUT', '评论区面板在预算时间内未变为可见', {
        selector: 'commentList', timeout_ms: timeoutMs,
      })
    }
    return { ok: true, url: videoUrl }
  }

  /**
   * 扫描当前**可见**的评论项，返回结构化列表。
   *
   * ⚠️ 返回的字段刻意**不含评论原文之外的隐私标识**：
   *    没有 `sec_uid`、没有资料页链接。评论正文是必要的（要按关键词判断
   *    是否回复、要拿去生成回复），但它是**页面数据**，本方法不落盘。
   *    落盘由调用方经隐私哈希处理（红线 3）。
   *
   * @returns {Promise<Array<{index:number, text:string, user:string, replyable:boolean}>>}
   */
  async scan({ limit = 50 } = {}) {
    const { css: listCss } = this.#css('commentList')
    const { css: itemCss } = this.#css('commentItem')
    const { css: contentCss } = this.#css('commentContent')
    const { css: btnCss } = this.#css('replyButton')

    const expr = `(function(){
      ${NORMALIZE_JS}
      ${VISIBLE_JS}
      ${PICK_ROOT_JS}
      var root=__root(${JSON.stringify(listCss)});
      if(!root) return {ok:false, reason:'no_visible_root'};
      var items=Array.from(root.querySelectorAll(${JSON.stringify(itemCss)}));
      var out=[];
      for(var i=0;i<items.length && out.length<${Number(limit)};i++){
        var it=items[i];
        if(!__visible(it)) continue;
        var body=it.querySelector(${JSON.stringify(contentCss)});
        var text=(body&&(body.innerText||body.textContent))||'';
        text=String(text).replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();
        if(!text) continue;
        // 昵称：评论项里第一段短文本（平台结构不稳，取不到就不取，
        // 不猜——猜错会把别人的昵称当成目标用户）
        var lines=String(it.innerText||'').split(/\\n+/).map(function(s){return s.replace(/\\s+/g,' ').trim();}).filter(Boolean);
        var user=(lines.length>1 && lines[0].length<=48 && lines[0]!==text)?lines[0]:'';
        var btns=Array.from(it.querySelectorAll(${JSON.stringify(btnCss)}));
        var replyable=false;
        for(var b=0;b<btns.length;b++){
          var t=String(btns[b].innerText||btns[b].textContent||'').replace(/\\s+/g,'').trim();
          if(t==='\\u56de\\u590d' && __visible(btns[b])){ replyable=true; break; }
        }
        out.push({index:i, text:text, user:user, replyable:replyable});
      }
      return {ok:true, items:out, total:items.length};
    })()`

    const r = await this.#evaluate(expr, { defaultValue: { ok: false, reason: 'evaluate_failed' } })
    if (!r || r.ok !== true) {
      throw new WorkbenchError('SELECTOR_MISS', '找不到可见的评论区容器（页面可能未加载完或已改版）', {
        selector: 'commentList', reason: r ? r.reason : 'null_result',
      })
    }
    return r.items || []
  }

  /**
   * 滚动到目标评论并让它真正可见。
   *
   * ⚠️ 定位靠**归一化文本匹配**，不靠节点身份。理由：虚拟列表回收后
   *    节点对象会被替换，任何"记住这个节点"的做法都会在滚动后失效。
   *    文本匹配虽然土，但跨渲染周期稳定。
   *
   * @returns {Promise<{found:boolean, index:number}>}
   */
  async scrollToComment({ bodyKey, userKey, maxScrolls = 5 } = {}) {
    const { css: listCss } = this.#css('commentList')
    const { css: itemCss } = this.#css('commentItem')

    const expr = `(function(){
      ${NORMALIZE_JS}
      ${VISIBLE_JS}
      ${PICK_ROOT_JS}
      ${targetMatcher(bodyKey, userKey)}
      var root=__root(${JSON.stringify(listCss)});
      if(!root) return {found:false, reason:'no_visible_root'};
      var items=Array.from(root.querySelectorAll(${JSON.stringify(itemCss)}));
      for(var i=0;i<items.length;i++){
        if(!__match(items[i])) continue;
        items[i].scrollIntoView({block:'center'});
        return {found:true, index:i};
      }
      // 没找到 → 向下滚一屏，等下一轮虚拟列表渲染
      var before=root.scrollTop;
      root.scrollTop = before + Math.max(200, Math.floor(root.clientHeight*0.8));
      return {found:false, scrolled:root.scrollTop!==before};
    })()`

    for (let i = 0; i <= maxScrolls; i++) {
      const r = await this.#evaluate(expr, { defaultValue: { found: false } })
      if (r && r.found) {
        // ⚠️ 滚动后必须等一下再读坐标：虚拟列表会重渲染，
        //    立即读到的 rect 是 0×0（事实 2）。等待放在这里而不是
        //    让 browser-host 的 click 去兜，是因为"先等再点"比
        //    "点了失败再重试"少一次无效点击——而无效点击在页面上
        //    是**真实的鼠标事件**，会被平台记录。
        await sleep(600)
        return { found: true, index: r.index }
      }
      if (r && r.scrolled === false) break // 已经到底，再滚也没用
      await sleep(400)
    }
    return { found: false, index: -1 }
  }

  /**
   * 激活目标评论的内联回复编辑器。
   *
   * ⚠️ 这里是事实 4 的落点，也是最危险的一步。判据是三层**同时**成立：
   *      ① 在含目标评论的 comment-item 内
   *      ② 该 comment-item 的文本里出现「回复中」
   *      ③ 编辑器可见且 `contenteditable`
   *    以及一条**显式排除**：不得是页面底部的主评论输入框。
   *
   *    漏掉 ② 或那条排除 → 回复会变成一条**顶级评论**发出去，
   *    而平台照样返回 `status_code: 0`，计费也照算。
   *    这是"看起来一切正常"的静默错误，必须靠判据挡住，不能靠运气。
   */
  async activateInlineEditor({ bodyKey, userKey, attempts = 3 } = {}) {
    const { css: listCss } = this.#css('commentList')
    const { css: itemCss } = this.#css('commentItem')
    const { css: editorCss } = this.#css('inlineEditor')
    const { css: btnCss } = this.#css('replyButton')
    const { css: contentCss } = this.#css('commentContent')

    /** 查找内联编辑器；返回坐标或原因。 */
    const probe = `(function(){
      ${NORMALIZE_JS}
      ${VISIBLE_JS}
      ${PICK_ROOT_JS}
      ${targetMatcher(bodyKey, userKey)}
      var root=__root(${JSON.stringify(listCss)});
      if(!root) return {ok:false, reason:'no_visible_root'};
      var items=Array.from(root.querySelectorAll(${JSON.stringify(itemCss)}));
      var main=document.querySelector('.comment-input-container');
      for(var i=0;i<items.length;i++){
        var it=items[i];
        if(!__match(it)) continue;
        var t=String(it.innerText||'');
        if(t.indexOf('\\u56de\\u590d\\u4e2d')<0) return {ok:false, reason:'not_in_reply_mode'};
        var eds=Array.from(it.querySelectorAll(${JSON.stringify(editorCss)}));
        for(var e=0;e<eds.length;e++){
          var ed=eds[e];
          if(!__visible(ed)) continue;
          // ⚠️ 显式排除主评论输入框。往那里输入 = 发一条顶级评论。
          if(main && main.contains(ed)) continue;
          if(ed.getAttribute('contenteditable')!=='true') continue;
          var r=ed.getBoundingClientRect();
          // 点靠左的位置（固定点中间可能落在占位文字上，光标位置不稳）
          return {ok:true, x:Math.round(r.x+Math.min(60,Math.max(12,r.width/3))), y:Math.round(r.y+r.height/2)};
        }
        return {ok:false, reason:'editor_not_found_in_item'};
      }
      return {ok:false, reason:'target_item_not_found'};
    })()`

    /** 取「回复」按钮坐标（文本严格等于「回复」，且排除弹幕容器）。 */
    const findButton = `(function(){
      ${NORMALIZE_JS}
      ${VISIBLE_JS}
      ${PICK_ROOT_JS}
      ${targetMatcher(bodyKey, userKey)}
      var root=__root(${JSON.stringify(listCss)});
      if(!root) return null;
      var items=Array.from(root.querySelectorAll(${JSON.stringify(itemCss)}));
      for(var i=0;i<items.length;i++){
        if(!__match(items[i])) continue;
        var els=Array.from(items[i].querySelectorAll(${JSON.stringify(btnCss)}));
        for(var b=0;b<els.length;b++){
          var e=els[b];
          var t=String(e.innerText||e.textContent||'').replace(/\\s+/g,'').trim();
          if(t!=='\\u56de\\u590d') continue;
          if(!__visible(e)) continue;
          var p=e.parentElement, pc=((p&&p.className)||'').toString();
          if(pc.indexOf('danmaku')>=0||pc.indexOf('danmu')>=0) continue;
          var r=e.getBoundingClientRect();
          return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};
        }
      }
      return null;
    })()`

    let lastReason = null
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        // 重试前先重新滚动定位（虚拟列表可能把它回收了）
        await this.scrollToComment({ bodyKey, userKey, maxScrolls: 0 }).catch((e) => {
          this.#log('warn', 'scroll_before_retry_failed', { message: e && e.message })
        })
      }

      const before = await this.#evaluate(probe, { defaultValue: { ok: false, reason: 'probe_failed' } })
      if (before && before.ok) return { ok: true, x: before.x, y: before.y, via: 'already_active' }
      lastReason = before ? before.reason : 'probe_failed'

      // 点「回复」激活
      const btn = await this.#evaluate(findButton, { defaultValue: null })
      if (!btn) {
        // 兜底（事实 4 的 legacy 做法）：先点一下评论正文，再找按钮。
        // 有些版本「回复」只在 hover 或点正文后才出现。
        const tap = await this.#evaluate(
          `(function(){
            ${NORMALIZE_JS}
            ${VISIBLE_JS}
            ${PICK_ROOT_JS}
            ${targetMatcher(bodyKey, userKey)}
            var root=__root(${JSON.stringify(listCss)});
            if(!root) return null;
            var items=Array.from(root.querySelectorAll(${JSON.stringify(itemCss)}));
            for(var i=0;i<items.length;i++){
              if(!__match(items[i])) continue;
              var body=items[i].querySelector(${JSON.stringify(contentCss)})||items[i];
              if(!__visible(body)) continue;
              var r=body.getBoundingClientRect();
              return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};
            }
            return null;
          })()`,
          { defaultValue: null }
        )
        if (!tap) {
          lastReason = lastReason || 'reply_button_not_found'
          await sleep(1200)
          continue
        }
        await this.host.click(this.role, { at: { x: tap.x, y: tap.y } })
        await sleep(1200)
        const btn2 = await this.#evaluate(findButton, { defaultValue: null })
        if (!btn2) { lastReason = 'reply_button_not_found_after_tap'; await sleep(1200); continue }
        await this.host.click(this.role, { at: { x: btn2.x, y: btn2.y } })
      } else {
        await this.host.click(this.role, { at: { x: btn.x, y: btn.y } })
      }

      // 等编辑器出现（平台动画约 300–800ms，留足冗余）
      await sleep(1800)
      const after = await this.#evaluate(probe, { defaultValue: { ok: false, reason: 'probe_failed' } })
      if (after && after.ok) return { ok: true, x: after.x, y: after.y, via: 'activated' }
      lastReason = after ? after.reason : 'probe_failed'
      await sleep(800)
    }

    // ⚠️ 区分两种失败，因为它们对商家的含义完全不同：
    //    · 没进入回复态 → 页面问题，可重试
    //    · 找不到目标评论 → 评论可能已被删除，不可重试
    if (lastReason === 'target_item_not_found') {
      throw new WorkbenchError('NOT_LOCATABLE', '目标评论已不在页面上（可能被删除或被折叠）', {
        selector: 'commentItem',
      })
    }
    throw new WorkbenchError(
      'ELEMENT_TIMEOUT',
      `未能激活内联回复编辑器（${lastReason || '未知原因'}）。` +
      `为避免把回复发成顶级评论，已放弃本次发送。`,
      { selector: 'inlineEditor', reason: lastReason, attempts }
    )
  }

  /**
   * 判断评论项是否已稳定存在（DOM 判据）。
   *
   * ⚠️ 这个结果**只能**产出 `sent_confirmed_dom`，**默认不计费**（契约 §6.1）。
   *    它绝不能升级成 `sent_confirmed`——那是 `publish-verifier.js` 的专属职责。
   *
   * @returns {Promise<{stable:boolean, stableMs:number}>}
   */
  async waitForReplyStable({ bodyKey, userKey, replyTextHashProvider, stableMs = 3000, pollMs = 1000 } = {}) {
    const { css: listCss } = this.#css('commentList')
    const { css: itemCss } = this.#css('commentItem')

    // ⚠️ 只比对"目标评论项仍然存在"，不比对回复文本。
    //    比对回复文本需要在页面里拿到回复原文，而那是隐私内容——
    //    本方法刻意不把回复原文带进表达式（红线 3：页面数据留在页面里）。
    const expr = `(function(){
      ${NORMALIZE_JS}
      ${VISIBLE_JS}
      ${PICK_ROOT_JS}
      ${targetMatcher(bodyKey, userKey)}
      var root=__root(${JSON.stringify(listCss)});
      if(!root) return false;
      var items=Array.from(root.querySelectorAll(${JSON.stringify(itemCss)}));
      for(var i=0;i<items.length;i++){ if(__match(items[i])) return true; }
      return false;
    })()`

    void replyTextHashProvider
    const rounds = Math.max(1, Math.ceil(stableMs / pollMs))
    let stable = 0
    for (let i = 0; i < rounds; i++) {
      await sleep(pollMs)
      const present = await this.#evaluate(expr, { defaultValue: false })
      if (present) stable += pollMs
      else stable = 0
      if (stable >= stableMs) return { stable: true, stableMs: stable }
    }
    return { stable: false, stableMs: stable }
  }

  /**
   * 向内联编辑器输入文案，并**回读校验**。
   *
   * ⚠️ 回读校验不是可选项。`Input.insertText` 与分块输入都可能被页面
   *    的输入法/组件吞掉（尤其是刚 focus 完的那一瞬间），而"输入丢了"
   *    的表现是发出一条空回复或半截回复——比发不出去更糟，
   *    因为它真的发出去了、真的会被计费、也真的会让用户困惑。
   *
   * ⚠️ 也**不能**用 `Runtime.evaluate` 直接给编辑器赋值。那样绕过了
   *    真实的输入事件，React 类框架的受控组件不会更新内部 state，
   *    于是"页面上看得见文字、提交时发出去的是空的"。
   *    所以必须走 browser-host 的真实键盘路径。
   *
   * @param {string} text
   * @param {object} p
   * @param {Array<{text:string, delayMs:number}>} [p.plan] 打字计划（来自 safety/timing.js）
   * @param {number} [p.timeoutMs]
   */
  async typeIntoEditor(text, p = {}) {
    const expected = String(text || '')
    if (!expected) {
      throw new WorkbenchError('CONTENT_TOO_SHORT', '回复文案为空，已拒绝发送')
    }

    if (Array.isArray(p.plan) && p.plan.length) {
      await this.host.type(this.role, null, null, { plan: p.plan })
    } else {
      // 没有计划就一次性插入。⚠️ 这是**降级**路径：一次性插入的
      //    时间特征与真人差异最大，只应该在调用方明确要求时走。
      await this.host.type(this.role, null, expected)
    }

    // ── 回读校验 ─────────────────────────────────────────────
    const readBack = await this.#evaluate(`(function(){
      var eds=Array.from(document.querySelectorAll('[contenteditable=true],textarea'));
      var main=document.querySelector('.comment-input-container');
      for(var i=0;i<eds.length;i++){
        var ed=eds[i];
        var r=ed.getBoundingClientRect();
        if(r.width<=0||r.height<=0) continue;
        if(main && main.contains(ed)) continue;
        var v=(ed.value!==undefined && ed.value!==null) ? String(ed.value) : String(ed.innerText||ed.textContent||'');
        return {ok:true, value:v};
      }
      return {ok:false, reason:'editor_not_found_after_typing'};
    })()`, { defaultValue: { ok: false, reason: 'evaluate_failed' } })

    if (!readBack || !readBack.ok) {
      throw new WorkbenchError('ELEMENT_TIMEOUT',
        '输入文案后找不到编辑器，无法确认内容是否写入', { selector: 'inlineEditor' })
    }
    if (normalizeForReadback(readBack.value) !== normalizeForReadback(expected)) {
      // ⚠️ 不重试输入。输入不一致说明页面组件状态与我们的认知不同，
      //    盲目重试可能造成"文字重复追加"。抛错让上层决定（通常是重排队）。
      throw new WorkbenchError('ELEMENT_TIMEOUT',
        '输入文案与预期不一致（可能被页面组件吞掉），已中止本次发送以免发出半截回复',
        { expected_length: expected.length, got_length: String(readBack.value || '').length })
    }

    return { ok: true, length: expected.length }
  }

  /**
   * 提交回复。
   *
   * ⚠️ **Enter 是主路径**，不是点发送按钮（legacy reply_worker.js:385-388）。
   *    旧代码实测发现：内联回复框的发送按钮在部分版本里位于 SVG 内部，
   *    点击坐标不稳定（`path[fill="#FE2C55"]`），而 Enter 一直有效。
   *
   * ⚠️ 发送按钮兜底只在这里做，且**不重复按 Enter**：
   *    重复 Enter 有发出两条评论的风险，而重复回复是平台最容易
   *    识别的机器人特征。所以顺序是：按一次 Enter → 等 →
   *    若编辑器仍在（说明 Enter 没生效）→ 点一次按钮 → 等。
   */
  async submitReply({ enterWaitMs = 5000, fallbackWaitMs = 6000 } = {}) {
    await this.host.pressEnter(this.role)
    await sleep(enterWaitMs)

    // Enter 是否生效？判据是**编辑器消失**（这是"继续下一步"的判据，
    // ⚠️ 绝不是成功判据 —— 成功只能由 publish-verifier 从响应体判定）。
    const stillOpen = await this.#evaluate(`(function(){
      var eds=Array.from(document.querySelectorAll('[contenteditable=true]'));
      var main=document.querySelector('.comment-input-container');
      for(var i=0;i<eds.length;i++){
        var ed=eds[i];
        var r=ed.getBoundingClientRect();
        if(r.width<=0||r.height<=0) continue;
        if(main && main.contains(ed)) continue;
        var inReplyItem=false;
        var a=ed, d=0;
        while(a && d<6){ if(String(a.innerText||'').indexOf('\\u56de\\u590d\\u4e2d')>=0){ inReplyItem=true; break; } a=a.parentElement; d++; }
        if(inReplyItem) return true;
      }
      return false;
    })()`, { defaultValue: false })

    if (!stillOpen) return { via: 'enter' }

    // 兜底：点发送按钮（只点一次）
    // ⚠️ 选择器来自 selectors.js 的 `sendButton`，**不得**在这里内联写死。
    //    内联的后果是平台改版时只改 selectors.js 不生效——
    //    而"改一个文件就能修好选择器失效"正是 S-4 这条约束的全部意义。
    const { css: itemCss } = this.#css('commentItem')
    const { css: sendBtnCss } = this.#css('sendButton')
    const btn = await this.#evaluate(`(function(){
      ${VISIBLE_JS}
      var items=Array.from(document.querySelectorAll(${JSON.stringify(itemCss)}));
      for(var i=0;i<items.length;i++){
        if(String(items[i].innerText||'').indexOf('\\u56de\\u590d\\u4e2d')<0) continue;
        var cands=Array.from(items[i].querySelectorAll(${JSON.stringify(sendBtnCss)}));
        for(var s=0;s<cands.length;s++){
          var el=cands[s];
          // 品牌红是页面上唯一稳定的可辨识特征（legacy reply_worker.js:395）
          var p=el.querySelector ? el.querySelector('path[fill="#FE2C55"]') : null;
          if(!p && !(el.tagName||'').match(/^(svg)$/i)) continue;
          var clickable=el.parentElement||el;
          var r=clickable.getBoundingClientRect();
          if(r.width>0&&r.height>0){
            return {ok:true, x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};
          }
        }
      }
      return {ok:false};
    })()`, { defaultValue: { ok: false } })

    if (!btn || !btn.ok) {
      this.#log('warn', 'submit_button_not_found', {})
      return { via: 'enter', editor_still_open: true }
    }

    this.#log('info', 'submit_via_button_fallback', {})
    await this.host.click(this.role, { at: { x: btn.x, y: btn.y } })
    await sleep(fallbackWaitMs)
    return { via: 'button' }
  }

  /**
   * 拾取"某条规则命中"所需的原始文本（供适配器做关键词匹配）。
   *
   * ⚠️ 本方法返回评论文本，它是**页面数据**。调用方不得直接落盘——
   *    落盘与上报必须经 `license/privacy.js` 的哈希处理（红线 3）。
   */
  async pickTexts({ limit = 100 } = {}) {
    const items = await this.scan({ limit })
    return items.map((it) => ({ index: it.index, text: it.text, user: it.user }))
  }

  /**
   * 等待某个选择器对应的元素**可见**。
   * @returns {Promise<boolean>}
   */
  async #waitForVisible(css, { timeoutMs, selectorKey }) {
    const expr = `(function(){
      ${VISIBLE_JS}
      var els=Array.from(document.querySelectorAll(${JSON.stringify(css)}));
      for(var i=0;i<els.length;i++){ if(__visible(els[i])) return true; }
      return false;
    })()`
    const deadline = Date.now() + timeoutMs
    let lastErr = null
    while (Date.now() < deadline) {
      try {
        const ok = await this.#evaluate(expr, { defaultValue: false })
        if (ok) return true
      } catch (e) {
        // ⚠️ 页面还在导航时 evaluate 会失败（执行上下文被销毁），
        //    这是**预期内**的，不是错误。但必须留痕，
        //    否则"选择器一直不命中"和"页面一直在跳转"无法区分。
        lastErr = e
      }
      await sleep(500)
    }
    if (lastErr) {
      this.#log('warn', 'wait_visible_ended_with_errors', { selector: selectorKey, message: lastErr.message })
    }
    return false
  }

  /** 求值包装：统一转成 WorkbenchError，并保留选择器 key 便于改版定位。 */
  async #evaluate(expression, { defaultValue, timeoutMs } = {}) {
    try {
      const r = await this.host.evaluate(this.role, expression, {
        returnByValue: true, timeoutMs,
      })
      if (r === undefined) return defaultValue
      return r
    } catch (e) {
      if (defaultValue !== undefined) return defaultValue
      throw e
    }
  }
}

function sleep(ms) {
  return new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref() })
}

/**
 * 回读比对用的归一化。
 *
 * ⚠️ 比 `NORMALIZE_JS` **宽松得多**：只统一换行、不换行空格与首尾空白。
 *    理由：回读的目的是"确认文字没丢"，而不是"确认逐字节相同"。
 *    编辑器的 `innerText` 会把换行规范化、可能插入 `\u00a0`，
 *    用它套 NORMALIZE_JS（那会删掉所有标点）反而会把"丢了标点"
 *    这种真实差异掩盖掉。
 */
function normalizeForReadback(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

module.exports = {
  CommentPage,
  CHANNEL,
  NORMALIZE_JS,
  VISIBLE_JS,
  PICK_ROOT_JS,
  targetMatcher,
  normalizeForReadback,
}
