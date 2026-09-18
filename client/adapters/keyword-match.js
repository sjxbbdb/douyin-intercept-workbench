'use strict'

// client/adapters/keyword-match.js
//
// 关键词匹配 —— 决定"这条评论该不该回复"。
//
// ⚠️ 本文件的规则直接继承 legacy `pipeline.js:58-108` 的实战经验，
//    那段代码解决的是一个**真实踩过的坑**：抖音标题与评论里几乎不会连续
//    包含"怎么充值codex"这样的整串，按整串匹配会把结果全部过滤成 0，
//    运营看到的是"一条都没命中"。所以规则是：
//
//      ① 先剥掉零宽字符与所有空白（平台会往文本里插这些东西）
//      ② 整串连续命中 → 通过
//      ③ 否则按**分词 AND 命中**（顺序无关）→ 通过
//
//    第二条的分词也不是简单按空格切：中文没有空格，所以要在
//    「中文 ↔ 英文数字」边界切分，并剥掉疑问前缀与功能词。
//    例："怎么充值codex" → ["充值","codex"]
//
// ⚠️ 但**必须区分场景**，这是本文件与 legacy 的关键差别：
//
//    · **视频标题匹配**（决定"这个视频值不值得扫评论"）适合宽松的
//      分词 AND —— 漏掉一个视频就少一批线索，而多扫一个视频的代价很小。
//
//    · **评论区命中**（决定"这条评论要不要回复"）必须**更严格**。
//      误判的代价是给不相关的人发回复，而"答非所问"是最容易招致
//      用户举报的行为。所以评论侧默认要求**整串命中或高置信度分词命中**，
//      并对纯疑问前缀（"这个多少钱" → "多少钱"）单独处理。
//
//    同一个函数兼顾两者会导致其中一个方向永远不对，所以这里把
//    `strict` 做成显式参数而**不给默认值**——调用方必须想清楚自己在哪个场景。

/** 被忽略的字符（标点与符号，不影响语义） */
const IGNORED_CHARS = new Set([
  ...Array.from(' \t\r\n\u200b\u200c\u200d\ufeff'),
  ...Array.from('[]，。,.!！?？:：;；、"\'“”‘’(){}<>《》【】（）-_=+~`@#$%^&*|/\\'),
])

/** 疑问/功能前缀：剥掉之后剩下的才是真正的关键词 */
const INTERROGATIVE_PREFIXES = Object.freeze([
  '怎么', '如何', '怎样', '咋样', '咋', '哪里', '在哪', '哪个', '什么',
  '有没有', '求', '教我', '请问', '想问', '麻烦', '这个', '那个', '这款', '那款',
])

/** 功能词：本身不承载语义，单独成段就丢弃 */
const FUNCTION_WORDS = new Set([
  '的', '了', '吗', '呢', '吧', '啊', '呀', '和', '与', '或', '在', '是',
  '我', '你', '他', '它', '要', '想', '会', '能', '可以', '一下', '多少',
  '钱', '贵', '便宜', '买', '卖', '有', '没',
])

/** 归一化：小写 + 去零宽字符 + 去所有空白 */
function normalizeSearchText(value) {
  return String(value === undefined || value === null ? '' : value)
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/\s+/g, '')
}

/**
 * 关键词分词。
 *
 * ⚠️ 单字中文段一律丢弃（`lower.length < 2`）。理由：单字命中率极高，
 *    留下它们等于把匹配退化成"只要出现这个字就回复"，误判率会高到不可用。
 */
function keywordSegments(keyword) {
  const raw = String(keyword || '').trim()
  if (!raw) return []

  const rough = raw.split(/[\s,，。.!！?？、;；:：/|]+/).filter(Boolean)
  const parts = []
  for (const piece of rough) {
    // 在「中文 ↔ 英文数字」边界切分
    const chunks = piece.match(/[\u4e00-\u9fa5]+|[A-Za-z0-9]+/g) || []
    for (const c of chunks) parts.push(c)
  }

  const out = []
  for (const part of parts) {
    let lower = part.toLowerCase()
    if (/^[\u4e00-\u9fa5]+$/.test(part)) {
      for (const p of INTERROGATIVE_PREFIXES) {
        if (lower.startsWith(p) && lower.length > p.length) { lower = lower.slice(p.length); break }
      }
      if (lower.length < 2) continue
      if (FUNCTION_WORDS.has(lower)) continue
      out.push(lower)
    } else {
      if (lower.length < 2) continue
      out.push(lower)
    }
  }
  return [...new Set(out)]
}

/** 提取关键词里出现过的单字（供"模糊兜底"使用）。 */
function extractKeywordChars(value) {
  return [...new Set(
    Array.from(String(value || '').toLowerCase())
      .filter((ch) => !IGNORED_CHARS.has(ch) && ch.trim() !== '')
  )]
}

/**
 * 匹配判定。
 *
 * @param {string} text      被检文本（评论文本 / 视频标题）
 * @param {string} keyword   关键词
 * @param {object} opts
 * @param {boolean} opts.strict  **必填**。true = 评论侧（严格）；false = 视频标题侧（宽松）
 * @returns {{hit:boolean, how:string, segments:string[], matched:string[]}}
 *          `how` ∈ `exact` / `segments` / `char_fallback` / `none`
 */
function matchKeyword(text, keyword, opts) {
  if (!opts || typeof opts.strict !== 'boolean') {
    // ⚠️ 不给默认值。这个参数决定了"会不会给不相关的人发回复"，
    //    必须由调用方按场景显式选择（见文件头说明）。
    throw new Error('matchKeyword 需要显式的 strict 参数（true=评论侧严格，false=标题侧宽松）')
  }
  const strict = opts.strict
  const source = normalizeSearchText(text)
  const target = normalizeSearchText(keyword)
  if (!target) return { hit: false, how: 'none', segments: [], matched: [] }

  // ① 整串连续命中
  if (source.includes(target)) {
    return { hit: true, how: 'exact', segments: [target], matched: [target] }
  }

  const segs = keywordSegments(keyword)
  if (!segs.length) {
    // 关键词分词后什么都不剩（例如只给了单字或纯功能词）。
    // ⚠️ 这时**宽松模式也不放行**：没有可用特征就意味着匹配没有依据。
    return { hit: false, how: 'none', segments: [], matched: [] }
  }

  const matched = segs.filter((s) => source.includes(s))

  // ② 全部分词命中（顺序无关）
  if (matched.length === segs.length) {
    return { hit: true, how: 'segments', segments: segs, matched }
  }

  // ③ 严格模式：不放过部分命中
  if (strict) {
    return { hit: false, how: 'none', segments: segs, matched }
  }

  // ④ 宽松模式（视频标题侧）：多数分词命中即可
  //    ⚠️ 门限写死成"过半"而不是可配置：它是经验值，暴露成配置只会
  //       让人调成 0 然后抱怨匹配不准。
  const need = Math.ceil(segs.length / 2)
  if (matched.length >= need) {
    return { hit: true, how: 'segments', segments: segs, matched }
  }

  // ⑤ 兜底：关键词字符的命中比例。
  //    ⚠️ 只在宽松模式用。评论侧用它会让"这个多少钱"命中"这个怎么样"
  //       这类完全不相关的内容。
  const chars = extractKeywordChars(keyword)
  if (chars.length >= 2) {
    const hitChars = chars.filter((c) => source.includes(c))
    if (hitChars.length / chars.length >= 0.8) {
      return { hit: true, how: 'char_fallback', segments: segs, matched: hitChars }
    }
  }

  return { hit: false, how: 'none', segments: segs, matched }
}

/**
 * 从一组规则里挑出命中的第一条。
 *
 * ⚠️ 规则顺序即优先级，**必须保持配置里的顺序**（找不到任何命中返回 null）。
 *    若改成"挑最长的关键词"之类，运营在界面上调整顺序就会莫名其妙失效。
 *
 * @param {string} text
 * @param {Array<{id:string, keyword:string, templates:string[]}>} rules
 * @param {object} opts `{strict}`，同 matchKeyword
 */
function matchRules(text, rules, opts) {
  for (const rule of rules || []) {
    if (!rule || !rule.keyword) continue
    const r = matchKeyword(text, rule.keyword, opts)
    if (r.hit) return { rule, ...r }
  }
  return null
}

module.exports = {
  matchKeyword,
  matchRules,
  keywordSegments,
  extractKeywordChars,
  normalizeSearchText,
  INTERROGATIVE_PREFIXES,
  FUNCTION_WORDS,
  IGNORED_CHARS,
}
