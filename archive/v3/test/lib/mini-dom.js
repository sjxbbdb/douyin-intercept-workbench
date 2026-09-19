// ⚠️ 仅用于离线 fixture 断言。能力边界见 shared/测试策略.md §2.6。
'use strict'

const VOID_TAGS = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'track', 'wbr'])

// 解析出所有标签（开标签与闭标签各成一项），便于按区间切块。
// 闭标签单独成项是必须的：否则无法正确配平同名前缀的兄弟元素（如三个连续的 <div>…</div>）。
function scanTags(html) {
  const tags = []
  // ⚠️ 属性段必须用贪婪 [^<>]*：用惰性 [^<>]*? 会在第一个空格处就收尾，
  //    导致 attrsRaw 只剩空白、所有属性匹配全部失效（本项目实测踩过）。
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^<>]*?)(\/?)>/g
  let m
  while ((m = re.exec(html)) !== null) {
    const name = m[2].toLowerCase()
    const isClose = m[1] === '/'
    tags.push({
      name,
      isClose,
      attrsRaw: isClose ? '' : (m[3] || ''),
      selfClosing: !isClose && (m[4] === '/' || VOID_TAGS.has(name)),
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return tags
}

// 解析属性串 → { class: 'a b', 'data-e2e': 'comment-list' }
function parseAttrs(attrsRaw) {
  const out = {}
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let m
  while ((m = re.exec(attrsRaw)) !== null) {
    const name = m[1].toLowerCase()
    out[name] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : ''
  }
  return out
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, '\u00a0')   // ⚠️ 必须还原，解析规则依赖它（见平台知识 §4.1）
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

// ⚠️ 本函数据 tags 的绝对下标工作：调用方必须先 scanTags(rangeHtml)，
//    再把返回下标加上区间偏移（见 queryIn）。tokens 只解析一次、全区间复用。
function findClose(tags, tokens, openIndex) {
  const open = tags[openIndex]
  if (open.selfClosing) return open.end
  let depth = 0
  for (let i = openIndex; i < tags.length; i++) {
    const t = tags[i]
    // 只配平同名标签；用提前算好的 tokens 避免对每个元素重复扫描全表
    if (tokens[i] !== open.name) continue
    if (t.isClose) {
      depth--
      if (depth === 0) return t.start
    } else if (!t.selfClosing) {
      depth++
    }
  }
  return tags[tags.length - 1].end
}

// 极简选择器：tag | .class | #id | [attr] | [attr="v"] | [attr*="v"] | 组合（如 div.foo[data-e2e="x"]）
function selectorMatches(attrs, tagName, selector) {
  const parts = selector.match(/^([a-zA-Z][a-zA-Z0-9-]*)?((?:[.#]?[\w-]+|\[[^\]]+\])*)$/)
  if (!parts) throw new Error('unsupported selector: ' + selector)
  if (parts[1] && parts[1].toLowerCase() !== tagName) return false
  const rest = parts[2] || ''
  const tokenRe = /\.([\w-]+)|#([\w-]+)|\[([^\]]+)\]/g
  let m
  while ((m = tokenRe.exec(rest)) !== null) {
    if (m[1]) {
      const cls = (attrs.class || '').split(/\s+/)
      if (!cls.includes(m[1])) return false
    } else if (m[2]) {
      if (attrs.id !== m[2]) return false
    } else {
      const cond = m[3]
      // 同时支持 [attr]、[attr=v]、[attr="v"]、[attr*="v"] 四种写法
      // （⚠️ legacy 里 [data-e2e=comment-list] 与 [data-e2e="comment-list"] 两种写法都存在）
      const am = cond.match(/^([\w-]+)\s*(?:([*^$]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s"'\]]+)))?$/)
      if (!am) throw new Error('unsupported attr condition: ' + cond)
      const name = am[1].toLowerCase()
      const value = attrs[name]
      if (am[2] === undefined) {
        if (value === undefined) return false
      } else {
        const op = am[2]
        const want = am[3] !== undefined ? am[3] : am[4] !== undefined ? am[4] : am[5]
        if (value === undefined) return false
        if (op === '=' && value !== want) return false
        if (op === '*=' && !value.includes(want)) return false
        if (op === '^=' && !value.startsWith(want)) return false
        if (op === '$=' && !value.endsWith(want)) return false
      }
    }
  }
  return true
}

class MiniElement {
  // html 始终是「完整快照字符串」，offset 是本元素在其中的绝对起始位置。
  // 这样嵌套 querySelectorAll 只需把子区间偏移回去，不需要另建作用域字符串。
  constructor(html, tag, attrs, offset, innerStart, innerEnd) {
    this._html = html; this.tagName = tag; this.attrs = attrs
    this._offset = offset; this._innerStart = innerStart; this._innerEnd = innerEnd
  }
  // 近似 textContent：剥标签 + 还原实体（不做 DOM 排版处理）
  get textContent() {
    return decodeEntities(this._html.slice(this._innerStart, this._innerEnd).replace(/<[^>]*>/g, ''))
  }
  // ⚠️ 模拟 innerText：只把 br 与块级闭合标签当换行边界；无法模拟 CSS 影响。
  // 换行后去掉行首缩进、折叠行内连续空白（对应真实 innerText 的排版行为）。
  get innerText() {
    return decodeEntities(
      this._html.slice(this._innerStart, this._innerEnd)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, '\n')
        .replace(/<[^>]*>/g, '')
    ).split('\n').map((s) => s.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean).join('\n')
  }
  getAttribute(name) { return this.attrs[String(name).toLowerCase()] ?? null }
  querySelectorAll(selector) {
    return queryIn(this._html, this._innerStart, this._innerEnd, selector)
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
}

// 在 [scopeStart, scopeEnd) 区间内匹配；返回的元素偏移是「完整快照」的绝对位置
function queryIn(html, scopeStart, scopeEnd, selector) {
  const rangeHtml = html.slice(scopeStart, scopeEnd)
  const tags = scanTags(rangeHtml)
  // tokens 用标签名预计算，供 findClose 复用（否则每个候选元素都要重扫全表）
  const tokens = tags.map((t) => t.name)
  const out = []
  for (let i = 0; i < tags.length; i++) {
    if (tags[i].isClose) continue
    const attrs = parseAttrs(tags[i].attrsRaw)
    if (!selectorMatches(attrs, tags[i].name, selector)) continue
    const close = findClose(tags, tokens, i)
    out.push(new MiniElement(
      html, tags[i].name, attrs,
      scopeStart + tags[i].start,
      scopeStart + tags[i].end,
      scopeStart + close,
    ))
  }
  return out
}

function parse(html) {
  return {
    querySelectorAll: (sel) => queryIn(html, 0, html.length, sel),
    querySelector: (sel) => queryIn(html, 0, html.length, sel)[0] || null,
  }
}

module.exports = { parse, queryIn, scanTags, findClose, parseAttrs, decodeEntities, selectorMatches }