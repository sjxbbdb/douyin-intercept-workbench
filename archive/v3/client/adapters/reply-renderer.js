'use strict'

// client/adapters/reply-renderer.js
//
// 把规则模板渲染成实际发出的回复文案。
//
// ⚠️ 本文件的核心约束来自需求文档与计划文档各一条，两条都踩过坑：
//
//   ① **禁止 `{随机1-9}` 这种数字占位符**（计划 §4.5）。
//      用数字凑变化会产生 `"1"` `"2"` `"3"` 这类明显机器痕迹——
//      真人不会在一句话前面加个数字。正确的"变体"是**语言变体**：
//      「这个」「这款」「它」（同义替换），而不是「1这个」「2这个」。
//      所以本文件提供的是**同义词槽**，而不是随机数槽。
//
//   ② **模板池至少 5 条变体**（需求 FR-2.2 / 计划 §4.5）。
//      少于 5 条时相似度护栏会频繁拒绝，表现为"规则配好了但不回复"。
//      这条在保存规则时校验（`similarity.js` 的 `templateVariantsOk`），
//      渲染时再校验一次作为兜底——因为规则可能被绕过界面直接改文件。
//
// ⚠️ 另一个必须做对的事：**渲染结果必须可复现**。
//    同一条评论、同一个规则，渲染两次应得到同一个文案。理由：
//    渲染发生在"已落盘 send_id 之后、真正发送之前"，如果它是不可复现的，
//    崩溃恢复时就无法判断"刚才发的是哪一条变体"，而相似度护栏依赖
//    "最近发过什么"——不可复现会让护栏失去依据。
//    所以随机源是**可注入的**，默认用 `Math.random`，测试注入种子源。

/** 同义词槽：键是槽名，值是语言变体（**不是**数字） */
const SYNONYM_SLOTS = Object.freeze({
  商品: ['这个商品', '这款', '它', '这件'],
  价格: ['价格', '多少钱', '什么价位', '怎么卖'],
  功能: ['功能', '怎么用', '用法', '能做什么'],
  购买: ['购买', '下单', '入手', '拍下'],
  联系: ['联系', '私信', '找我', '联系我'],
  语气: ['呢', '哦', '～', ''],
  称呼: ['亲', '您好', '你好', ''],
})

/** 允许出现在模板里的占位符（白名单） */
const ALLOWED_PLACEHOLDERS = Object.freeze(Object.keys(SYNONYM_SLOTS))

/**
 * 校验模板：占位符合法 + 池子有足够变体。
 *
 * @param {string[]} templates
 * @param {object} [opts]
 * @param {number} [opts.minVariants] 默认 5（需求下限，不要调低）
 * @returns {{ok:boolean, problems:string[], distinct:number}}
 */
function validateTemplates(templates, opts = {}) {
  const minVariants = opts.minVariants === undefined ? 5 : Number(opts.minVariants)
  const problems = []
  const list = Array.isArray(templates) ? templates.filter((t) => String(t || '').trim()) : []

  if (list.length < minVariants) {
    problems.push(`模板池只有 ${list.length} 条，至少需要 ${minVariants} 条变体`)
  }

  const seen = new Set()
  for (const t of list) {
    const s = String(t)
    // 占位符白名单
    const slots = s.match(/\{([^}]*)\}/g) || []
    for (const raw of slots) {
      const name = raw.slice(1, -1).trim()
      if (!ALLOWED_PLACEHOLDERS.includes(name)) {
        problems.push(`模板含未知占位符 ${raw}（允许：${ALLOWED_PLACEHOLDERS.join(' / ')}）`)
      }
    }
    // ⚠️ 显式拦住数字类占位符。它们是"看起来聪明"的写法，
    //    但产物是机器痕迹，必须在保存阶段就挡住。
    if (/\{(随机|rand|random|rnd)\s*\d*\s*[-~]?\s*\d*\}/i.test(s) || /\{\d+\s*[-~]\s*\d+\}/.test(s)) {
      problems.push(`模板使用了数字随机占位符（${s.slice(0, 30)}…）：` +
        `那会产生 "1这个" "2这个" 这类明显机器痕迹，请改用语言变体槽如 {商品} {价格}`)
    }
    seen.add(normalizeForCompare(s))
  }

  return { ok: problems.length === 0, problems: [...new Set(problems)], distinct: seen.size }
}

/**
 * 渲染一条回复。
 *
 * @param {object} p
 * @param {string[]} p.templates 模板池（≥5 条）
 * @param {() => number} [p.rng] 随机源（测试可注入种子源）
 * @param {object} [p.pick] 强制指定选哪条模板（崩溃恢复时用，保证可复现）
 * @returns {{text:string, templateIndex:number, slots:object}}
 */
function renderReply(p) {
  if (!p || !Array.isArray(p.templates) || !p.templates.length) {
    throw new Error('renderReply 需要非空的 templates')
  }
  const rng = p.rng || Math.random
  const templates = p.templates.map((t) => String(t))

  const index = p.pick === undefined
    ? Math.floor(rng() * templates.length) % templates.length
    : Number(p.pick) % templates.length

  const slots = {}
  const text = templates[index].replace(/\{([^}]*)\}/g, (raw, name) => {
    const key = String(name).trim()
    const variants = SYNONYM_SLOTS[key]
    if (!variants) return raw // 未知槽原样保留（校验阶段已报错）
    const v = variants[Math.floor(rng() * variants.length) % variants.length]
    slots[key] = v
    return v
  })

  return { text: text.trim(), templateIndex: index, slots }
}

/** 归一化用于"变体是否重复"的比对。 */
function normalizeForCompare(s) {
  return String(s || '').replace(/\s+/g, '').replace(/\{[^}]*\}/g, '{}').toLowerCase()
}

module.exports = {
  renderReply,
  validateTemplates,
  normalizeForCompare,
  SYNONYM_SLOTS,
  ALLOWED_PLACEHOLDERS,
}
