'use strict'

// client/safety/similarity.js
//
// 内容相似度（SimHash）—— 发送前的"别老发同一句话"关卡。
//
// ⚠️⚠️ **本模块最容易写反的一行**（AGENTS.md §2.4）：
//
//        相似度 **超过** 阈值  ⇒  **拒绝发送**
//        （content_similarity_max = 0.85 的意思是"相似度 > 85% 拒绝"）
//
//     写反（"相似度低于阈值才拒绝"）会得到一个**只发相似内容**的系统：
//     第一条正常的文案因为和近期内容都不像而被拒，之后每一条都必须是
//     复制粘贴才能发出去——账号瞬间变成复读机，是本项目最严重的灾难性缺陷。
//     因此：`checkContent()` 里那一行 `>` 永远不许改成 `<`；
//     `test/unit/client-safety.test.js` 里有专门的"方向守卫"用例，
//     一旦方向被改，用例必然失败。
//
// ⚠️ 为什么是 SimHash 而不是编辑距离：
//     需求是"和**最近 50 条**已发内容比对"。编辑距离是 O(n·m)，50 条 × 每秒
//     若干次判定会明显吃 CPU；SimHash 把每段文本压成 64 位指纹，
//     比对退化成一次异或 + 数 1，恒定开销。
//
// ⚠️ 为什么在 SimHash 之外还要叠加"特征包含度曲线"（见 CONTAINMENT_CURVE_POWER）：
//     64 位指纹的**分辨率**在中文短句上不够。实测："这个商品多少钱呢，方便的话
//     报个价" 与 "这个商品多少钱呀，方便的话报个价"（只差一个语气词）的指纹
//     相似度只有 0.83——**低于 0.85 阈值**，也就是近重复文案会漏网。
//     指纹层面 0.83 没错（确实有 11 位不同），但业务层面这两句就是重复内容。
//     所以最终相似度取**两路信号的最大值**：
//       · 指纹相似度   1 − 汉明距离/64        （长文本可靠、对词序扰动稳健）
//       · 包含度曲线   Jaccard(特征集)^0.35   （短文本的近重复敏感）
//     两路都落在同一个 [0,1] 区间，共用服务端下发的同一个阈值。
//     这是"相似度"的合成口径，**不是**阈值调整——阈值仍然只有服务端 policy
//     一个来源，客户端不得改动（红线 1）。
//
// ⚠️ 为什么中文要**同时**取一元与二元特征：
//     · 中文没有空格，按空白切词等于整句一个特征，指纹退化为"整句哈希"，
//       任何一字之差都变成完全不同的指纹 → 近乎相同的内容判为不相似。
//     · 只用一元（单字）："这个商品多少钱" 与 "这个产品多少钱" 共享
//       「这个…多少…钱」五个字，指纹高度重合 → **把正常换词误判为重复**，
//       于是商家怎么写都被拒，最后只能重复发同一句（正是要避免的结果）。
//     · 只用二元（双字）：短文本（"好的""收到"）只有三四个特征，
//       指纹由这几个特征决定，随机性极大，判定不可信。
//     所以：一元给短文本足够的特征量，二元给长文本区分度，两者都要。
//
// ⚠️ 纯函数模块：不读盘、不写盘、不联网、无第三方依赖。
//    阈值一律由调用方从服务端 policy 传入（红线 1：客户端不得硬编码限额）。

const crypto = require('node:crypto')

/** SimHash 指纹位数。64 位在 50 条窗口下的碰撞概率足够低。 */
const HASH_BITS = 64

/**
 * 判定"文本太短、指纹不可信"的特征数下限。
 *
 * ⚠️ 这个数字不是安全限额（不是 daily_max/interval/相似度阈值），
 *    而是**分布形状参数**：SimHash 需要足够多的特征投票才能稳定。
 *    特征数不足时本模块返回"无法评估"而不是拿噪声去拒绝，
 *    真正兜住节奏的是日上限、最小间隔与单用户冷却。
 */
const MIN_FEATURES_FOR_HASH = 8

/**
 * 特征包含度曲线的放大指数。
 *
 * ⚠️ 这是一个**分布形状参数**（校准出来的，不是拍脑袋的政策值），
 *    把 Jaccard 系数放大成对"近重复"敏感、对"换了个说法"仍然宽松的曲线：
 *      · 只差一个语气词、17 字的文案：Jaccard ≈ 0.68 → 0.68^0.35 ≈ 0.87  → 拒绝
 *      · 明显换了说法的文案：      Jaccard ≈ 0.07 → 0.07^0.35 ≈ 0.39  → 放行
 *    指数越小越敏感（0.35 是保守侧的取值：宁可漏掉一些近重复，
 *    也不要把正常换词判成重复——那会逼商家反复发同一句话）。
 */
const CONTAINMENT_CURVE_POWER = 0.35

/**
 * 包含度曲线只有在"确实有共同特征"时才允许贡献相似度。
 * 没有任何共同特征 → 贡献 0，避免把两段毫无关系的文本抬到阈值附近。
 */
const EXPANSION_FLOOR = 1e-6

/**
 * 规则模板池的变体数下限。
 *
 * ⚠️ 需求（plans/A-工具链路开发指导.md §4.5）要求"规则保存时校验模板池
 *    至少 5 条变体"。这是**兜底**，不是"5 条就够"——
 *    规则保存入口应把服务端下发的模板池下限传进来（见 templateVariantsOk）。
 */
const MIN_TEMPLATE_VARIANTS = 5

// ═══════════════════════════════════════════════════════════
// 分词（中文感知，零依赖）
// ═══════════════════════════════════════════════════════════

/** CJK 统一表意文字（含扩展 A 与兼容区），覆盖中文与常见全角汉字。 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
/** 字母数字（含全角英数与常见重音字母）。其余字符一律视作分隔符。 */
const ALNUM_RE = /[0-9a-z\u00c0-\u024f\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]/

/**
 * 文本 → 特征序列（含重复，重复即权重）。
 *
 * 切分规则：非 CJK、非字母数字的字符一律是**边界**（标点、空白、emoji、
 * `@`、`#` 全部当分隔符）。CJK 段落内逐字产出**一元**特征并产出相邻**二元**特征；
 * 字母数字段落小写后作为**整词**特征。
 * ⚠️ 因为 `@` 也是分隔符，`A@B` 得到 `["a","b"]` 而不是 `["a@b"]`——
 *    这是刻意的：分隔符两侧是两段独立内容，不能拼成一个特征。
 *
 * @param {string} text
 * @returns {string[]} 特征序列；空白输入返回空数组
 */
function tokenize(text) {
  if (text === undefined || text === null) return []
  const s = String(text)
  const out = []
  let i = 0

  while (i < s.length) {
    const ch = s[i]
    if (CJK_RE.test(ch)) {
      // ── CJK 连续段：逐字一元 + 相邻二元 ──
      let j = i
      while (j < s.length && CJK_RE.test(s[j])) j++
      const seg = s.slice(i, j)
      for (let k = 0; k < seg.length; k++) out.push(seg[k])                 // 一元
      for (let k = 0; k + 1 < seg.length; k++) out.push(seg.slice(k, k + 2)) // 二元
      i = j
      continue
    }
    if (ALNUM_RE.test(ch.toLowerCase())) {
      // ── 字母数字连续段：整词（小写） ──
      let j = i
      while (j < s.length && ALNUM_RE.test(s[j].toLowerCase())) j++
      out.push(s.slice(i, j).toLowerCase())
      i = j
      continue
    }
    i++ // 分隔符：跳过
  }
  return out
}

/** 单个特征的 64 位哈希。sha256 前 8 字节大端序——确定性、无平台差异。 */
function featureHash(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest().readBigUInt64BE(0)
}

// ═══════════════════════════════════════════════════════════
// SimHash
// ═══════════════════════════════════════════════════════════

/**
 * 文本 → 64 位 SimHash 指纹。
 *
 * 算法：每个（出现的）特征贡献一张 64 位票，第 b 位为 1 则 +1、否则 −1；
 * 最后第 b 位取 `票和 > 0`。特征重复出现即权重更高（词频加权）。
 * 全零指纹是合法值（票和为 0），不得被当成"空指纹"。
 *
 * @param {string} text
 * @returns {bigint} 0n ~ 2^64−1 的无符号 64 位整数
 */
function simhash(text) {
  const tokens = tokenize(text)
  if (tokens.length === 0) return 0n

  const votes = new Array(HASH_BITS).fill(0)
  for (const t of tokens) {
    const h = featureHash(t)
    for (let b = 0; b < HASH_BITS; b++) {
      const bit = (h >> BigInt(b)) & 1n
      votes[b] += bit === 1n ? 1 : -1
    }
  }

  let out = 0n
  for (let b = 0; b < HASH_BITS; b++) {
    if (votes[b] > 0) out |= (1n << BigInt(b))
  }
  return out
}

/** 文本的**去重**特征集合。 */
function featureSet(text) {
  return new Set(tokenize(text))
}

/** 文本的**去重**特征数（"文本是否足够长到可评估"的判断用）。 */
function featureCount(text) {
  return featureSet(text).size
}

/** 汉明距离（两个指纹有多少位不同）。同值 → 0。 */
function hammingDistance(a, b) {
  let x = toU64(a) ^ toU64(b)
  let count = 0
  while (x !== 0n) {
    x &= (x - 1n) // 消掉最低位的 1
    count++
  }
  return count
}

/**
 * 两个指纹的相似度 ∈ [0,1]。1 = 完全相同。
 * 口径：`1 − 汉明距离 / 64`（**不是**"距离越小越相似"这类反向表达）。
 */
function hammingSimilarity(a, b) {
  return 1 - hammingDistance(a, b) / HASH_BITS
}

/**
 * 两个特征集合的包含度曲线：`Jaccard^CONTAINMENT_CURVE_POWER`。
 * 无共同特征时返回 0（不参与相似度合成）。
 */
function containmentSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0
  let inter = 0
  const [small, big] = setA.size <= setB.size ? [setA, setB] : [setB, setA]
  for (const t of small) if (big.has(t)) inter++
  if (inter === 0) return 0
  const union = setA.size + setB.size - inter
  const jaccard = inter / union
  if (jaccard <= EXPANSION_FLOOR) return 0
  return Math.min(1, Math.pow(jaccard, CONTAINMENT_CURVE_POWER))
}

/**
 * 相似度 ∈ [0,1]，1 = 完全一致。
 *
 * ⚠️ 口径是**两路信号取最大值**（理由见文件头注释）：
 *      · 指纹相似度（长文本、抗词序扰动）
 *      · 特征包含度曲线（短文本的近重复敏感）
 *    两路都在 [0,1]，所以"超过阈值即拒绝"这一个判定对两者同时成立。
 *
 * ⚠️ 任一方太短（特征数 < MIN_FEATURES_FOR_HASH）时返回 0 = "无法评估"，
 *    由 checkContent 放行。**不得**返回凭噪声算出的高相似度——
 *    那会把 `"好的"`、`"收到"` 这类正常短回复全部堵死。
 *
 * @param {string|bigint} a 文本或指纹
 * @param {string|bigint} b 文本或指纹
 * @returns {number}
 */
function similarity(a, b) {
  const ha = typeof a === 'bigint' || typeof a === 'number'
  const hb = typeof b === 'bigint' || typeof b === 'number'
  if (ha && hb) return hammingSimilarity(a, b)

  const sa = ha ? null : featureSet(a)
  const sb = hb ? null : featureSet(b)
  if (sa !== null && sa.size < MIN_FEATURES_FOR_HASH) return 0
  if (sb !== null && sb.size < MIN_FEATURES_FOR_HASH) return 0

  const hamming = hammingSimilarity(ha ? a : simhash(a), hb ? b : simhash(b))
  if (sa === null || sb === null) return hamming // 只给了一侧特征，无法算包含度
  return Math.max(hamming, containmentSimilarity(sa, sb))
}

/**
 * 在近期已发内容中找最相似的一条。
 *
 * ⚠️ 文本特征数不足（短文本）时返回 `null` = "无法评估"，
 *    由 checkContent 决定是放行还是拒绝。
 *
 * @param {string} text
 * @param {string[]} recentTexts
 * @returns {{index:number, similarity:number}|null}
 */
function findMostSimilar(text, recentTexts) {
  if (!Array.isArray(recentTexts) || recentTexts.length === 0) return null
  const targetSet = featureSet(text)
  if (targetSet.size < MIN_FEATURES_FOR_HASH) return null

  const target = simhash(text)
  let best = null
  for (let i = 0; i < recentTexts.length; i++) {
    const other = recentTexts[i]
    if (other === undefined || other === null) continue
    const otherSet = featureSet(other)
    if (otherSet.size < MIN_FEATURES_FOR_HASH) continue // 特征数不足，比对无意义
    const s = Math.max(
      hammingSimilarity(target, simhash(other)),
      containmentSimilarity(targetSet, otherSet)
    )
    if (best === null || s > best.similarity) best = { index: i, similarity: s }
  }
  return best
}

/**
 * 发送前判定 —— 「这条文案能不能发」。
 *
 * ⚠️⚠️⚠️ **方向不可改**：相似度 **超过** 阈值 ⇒ 拒绝。
 *
 *        0.85 的语义是"相似度 > 85% 拒绝"，不是"相似度 < 85% 拒绝"。
 *        写反 = 系统只发相似内容 = 灾难性缺陷（AGENTS.md §2.4）。
 *
 * @param {string} text 渲染好的回复文案
 * @param {object} opts
 * @param {string[]} [opts.recentTexts] 近期已发内容（建议最近 50 条 + 该规则模板池）
 * @param {number}   opts.threshold      相似度上限，**必须**由服务端 policy 传入
 *                                       （comment/live_danmaku 与 dm 的取值不同）
 * @returns {{allow:boolean, reason:string|null, similarity:number,
 *            matchedIndex:number|null, threshold:number}}
 *          reason: content_rejected | text_empty | similarity_not_assessable | null
 */
function checkContent(text, opts = {}) {
  const recentTexts = Array.isArray(opts.recentTexts) ? opts.recentTexts : []
  const threshold = Number(opts.threshold)

  if (!Number.isFinite(threshold)) {
    // ⚠️ fail-closed：阈值缺失时**不猜**，也不放行。
    //    猜默认值等于在客户端硬编码限额（红线 1），放行等于没有这道门。
    throw new Error(
      'checkContent 需要 threshold（取自服务端 policy 的 content_similarity_max），' +
      '客户端不得自行假定默认值'
    )
  }
  if (threshold < 0 || threshold > 1) {
    throw new Error(`content_similarity_max 必须是 0~1 之间的数，收到 ${threshold}`)
  }

  const deny = (reason, sim, matchedIndex) => ({
    allow: false, reason, similarity: sim, matchedIndex, threshold,
  })
  const pass = (reason, sim, matchedIndex) => ({
    allow: true, reason, similarity: sim, matchedIndex, threshold,
  })

  const s = text === undefined || text === null ? '' : String(text)
  if (s.trim() === '') {
    // 空文案：这是调用方的缺陷（模板渲染为空），但不属于"相似"问题。
    return deny('text_empty', 0, null)
  }

  const match = findMostSimilar(s, recentTexts)
  if (match === null) {
    // 太短而无法评估 → 放行（理由见 MIN_FEATURES_FOR_HASH 的说明）。
    return pass('similarity_not_assessable', 0, null)
  }

  // ⚠️⚠️ 这一行是红线。`>` 改成 `<` / `<=` 会让系统只发相似内容。
  if (match.similarity > threshold) {
    return deny('content_rejected', match.similarity, match.index)
  }

  // 边界：恰好等于阈值 → **放行**（语义是"超过"才拒绝）。
  return pass(null, match.similarity, match.index)
}

/**
 * 模板池变体数校验（规则保存时调用）。
 *
 * ⚠️ 校验的是"**去重后**"的变体数：写 5 条一模一样的模板不算数——
 *    那正好会让相似度关卡在运行时把这条规则的全部回复拒掉。
 *    去重按"去掉所有空白后的原文"比较，大小写与标点差异视为不同变体
 *    （标点不同在平台上确实不是同一条内容）。
 *
 * @param {string[]} texts
 * @param {object} [opts]
 * @param {number} [opts.required] 下限；调用方应传服务端策略里的值
 * @returns {{ok:boolean, distinct:number, required:number}}
 */
function templateVariantsOk(texts, opts = {}) {
  const required = opts.required === undefined ? MIN_TEMPLATE_VARIANTS : Number(opts.required)
  if (!Number.isFinite(required) || required < 1) {
    throw new Error(`模板池变体数下限非法：${opts.required}`)
  }

  const list = Array.isArray(texts) ? texts : []
  const seen = new Set()
  for (const t of list) {
    if (t === undefined || t === null) continue
    const key = String(t).replace(/\s+/g, '')
    if (key === '') continue // 空模板不计入变体
    seen.add(key)
  }

  return { ok: seen.size >= required, distinct: seen.size, required }
}

/** 把 number|string|bigint 统一成无符号 64 位 BigInt。 */
function toU64(v) {
  if (typeof v === 'bigint') return BigInt.asUintN(HASH_BITS, v)
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`相似度比对收到非法数值：${v}`)
    return BigInt.asUintN(HASH_BITS, BigInt(Math.trunc(v)))
  }
  return simhash(v)
}

module.exports = {
  simhash,
  hammingDistance,
  similarity,
  findMostSimilar,
  checkContent,
  templateVariantsOk,
  // 供测试与排障使用（不是业务 API）
  tokenize,
  featureSet,
  featureCount,
  hammingSimilarity,
  containmentSimilarity,
  HASH_BITS,
  MIN_FEATURES_FOR_HASH,
  MIN_TEMPLATE_VARIANTS,
  CONTAINMENT_CURVE_POWER,
}
