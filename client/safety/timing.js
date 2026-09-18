'use strict'

// client/safety/timing.js
//
// 拟人化时序 —— 「发得像人」的确定性实现。
//
// ⚠️ 为什么必须存在（AGENTS.md §2.11）：
//     旧代码的节奏是 `10000 + rand(4000)`，也就是**每个周期都整齐地落在
//     10–14 秒**。均匀随机看着"随机"，但它的**分布形状本身**就是机器人特征：
//     真人不会以恒定的平均速率一直操作，真人的间隔是"多数偏短、偶尔很长"
//     （去干别的了）。对数正态分布正是这个形状。
//
// ⚠️ 三条容易写错的细节：
//   1. **上下界必须由参数传入**（服务端 policy 的 min_interval_ms）。
//      本模块不内置任何"默认间隔"——那等于在客户端硬编码安全限额（红线 1）。
//      唯一例外是 L1/L2/L3 这类**分布形状常数**（sigma 等），它们不限制
//      发多少条，只决定间隔长什么样。
//   2. **活跃时段的随机抖动只能在窗口内**（`dailyActiveHoursDrift`）。
//      抖动方向写错（把起点往前推、终点往后推）会**延长**可发送时间，
//      即放宽限制——这是红线。抖动一律向内收。
//   3. **`pickDelayUntilActiveHours` 返回 0 表示"已经在窗口内"**，
//      不能返回负值，也不能"顺手再等一个随机时长"。
//
// ⚠️ rng 一律可注入（默认 Math.random），测试用 makeSeededRng 保证可复现。

const { toMinutes, dayStartMs } = require('./guard')
const { MS_PER_DAY, TZ_OFFSET_MINUTES } = require('../../shared/lib/protocol')

/**
 * 操作前的随机停顿（毫秒）—— 点击 / 输入之前插入，避免"指令级瞬时"节奏。
 *
 * ⚠️ 这是**分布形状常数**（方案的 §4.5：每次点击/输入前插入 1–3 秒随机停顿），
 *    不是安全限额，可以由调用方覆盖。
 */
const OPERATION_DELAY_MIN_MS = 1000
const OPERATION_DELAY_MAX_MS = 3000

/**
 * 间隔分布的对数正态形状参数（σ）。
 *
 * ⚠️ 取值理由：σ 越大尾巴越长（越像人），但过大时大多数样本会被
 *    夹到上界，分布反而在**上界处**堆积成一个尖峰——又变成固定节奏。
 *    σ=0.5 时，μ±2σ 覆盖约 0.37×中位 ~ 2.7×中位；对 2.5 倍的
 *    max/min 比值而言几乎全部落在区间内，夹取只影响极少数样本。
 */
const INTERVAL_SIGMA = 0.5

/**
 * 未显式给上界时，上界 = 下界 × 本比值。
 *
 * ⚠️ 这只是"把服务端给的**下界**铺开成一个区间"的形状系数，
 *    最终仍受服务端 policy 的 min_interval_ms 约束（客户端的实际间隔
 *    永远 ≥ 该下界）。调用方若能从 policy 拿到区间上界，应直接传 maxMs。
 */
const INTERVAL_SPREAD_RATIO = 2.5

/** 输入停顿的分布参数：主体偏短（真人打字快），偶尔长停。 */
const TYPING_SIGMA = 0.65
const TYPING_BASE_MS = 120
const TYPING_BASE_JITTER = 60
const TYPING_PUNCT_PAUSE_MIN_MS = 320
const TYPING_PUNCT_PAUSE_MAX_MS = 900
const TYPING_LONG_PAUSE_PROBABILITY = 0.07
const TYPING_LONG_PAUSE_MIN_MS = 1200
const TYPING_LONG_PAUSE_MAX_MS = 3800
/** 标点：这些字符后面适合停顿（与语言无关，中英文都适用）。 */
const PUNCT_CHARS = '，。！？；：、,.!?;:…—～~'

/** 活跃时段抖动参数：向内收的比例 + 最小保留窗口。 */
const DRIFT_RATIO = 0.08
const DRIFT_MAX_MINUTES = 90
const MIN_WINDOW_KEEP_MINUTES = 120

/** 分布体检的分桶数（仅用于 describeIntervalDistribution）。 */
const DIST_BUCKETS = 10

// ═══════════════════════════════════════════════════════════
// 随机源
// ═══════════════════════════════════════════════════════════

/**
 * 可复现的伪随机源（mulberry32）。**仅供测试与排障**。
 *
 * ⚠️ 不要在生产发送路径上用种子随机：可复现意味着**可预测**，
 *    那正是拟人化要消除的特征。生产一律用 Math.random。
 *
 * @param {number} seed
 * @returns {() => number} 返回 [0,1) 的纯函数式随机源
 */
function makeSeededRng(seed) {
  let a = (Number(seed) >>> 0) || 1
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 取 rng，缺省 Math.random。非函数一律抛错（不静默改用 Math.random）。 */
function resolveRng(rng) {
  if (rng === undefined || rng === null) return Math.random
  if (typeof rng !== 'function') throw new Error('rng 必须是函数')
  return rng
}

/** 标准正态分布采样（Box–Muller）。 */
function normalSample(rng) {
  let u = 0
  let v = 0
  // ⚠️ 不能用 log(0)：Math.random() 可能返回 0，必须重抽而不是让它变成 −Infinity。
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** 夹取到 [lo, hi]。 */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

// ═══════════════════════════════════════════════════════════
// 间隔
// ═══════════════════════════════════════════════════════════

/**
 * 下一次发送间隔（毫秒）—— **对数正态分布**，夹取到 [minMs, maxMs]。
 *
 * 数学口径：
 *   μ = ln(几何中心) = (ln min + ln max) / 2      ← 在**对数尺度**上取中点
 *   x = exp(μ + σ·z),  z ~ N(0,1)
 *   返回 clamp(round(x), minMs, maxMs)
 *
 * ⚠️ 为什么 μ 取对数中点而不是算术中点 `ln((min+max)/2)`：
 *    对数正态的中位数是 exp(μ)。用算术中点做 μ 会让分布整体偏高、
 *    大多数样本贴着上界——上界处堆出一个尖峰，等于回到固定节奏。
 *    （两者在 min≈max 时几乎相同，但区间一宽就明显不同。）
 *
 * @param {object} opts
 * @param {number} opts.minMs 服务端 policy 的 min_interval_ms（**必填**）
 * @param {number} [opts.maxMs] 区间上界；缺省为 minMs × INTERVAL_SPREAD_RATIO
 * @param {() => number} [opts.rng]
 * @param {number} [opts.sigma] 形状参数（默认 INTERVAL_SIGMA）
 * @returns {number} 毫秒整数，恒落在 [minMs, maxMs] 内
 */
function nextIntervalMs(opts = {}) {
  const minMs = Math.floor(Number(opts.minMs))
  if (!Number.isFinite(minMs) || minMs <= 0) {
    throw new Error(
      'nextIntervalMs 需要 minMs（取自服务端 policy 的 min_interval_ms）。' +
      '本模块不内置默认间隔——硬编码间隔会放宽服务端限制（红线 1）。'
    )
  }
  const maxMs = opts.maxMs === undefined
    ? Math.floor(minMs * INTERVAL_SPREAD_RATIO)
    : Math.floor(Number(opts.maxMs))
  if (!Number.isFinite(maxMs) || maxMs < minMs) {
    throw new Error(`nextIntervalMs 的区间非法：[${minMs}, ${maxMs}]`)
  }
  if (maxMs === minMs) return minMs

  const sigma = opts.sigma === undefined ? INTERVAL_SIGMA : Number(opts.sigma)
  if (!Number.isFinite(sigma) || sigma < 0) {
    throw new Error(`nextIntervalMs 的 sigma 非法：${opts.sigma}`)
  }

  const mu = (Math.log(minMs) + Math.log(maxMs)) / 2
  const x = Math.exp(mu + sigma * normalSample(resolveRng(opts.rng)))
  return clamp(Math.round(x), minMs, maxMs)
}

/**
 * 操作前的随机停顿（1000–3000ms）。
 *
 * ⚠️ 用的是**均匀**分布（不是对数正态）：这里的目的是"不让人机时序对齐"，
 *    而不是模拟"人隔多久发下一条"。固定 1 秒的停顿同样是机器特征。
 */
function operationDelayMs(rng, opts = {}) {
  const lo = Math.max(0, Math.floor(opts.minMs === undefined ? OPERATION_DELAY_MIN_MS : Number(opts.minMs)))
  const hi = Math.max(lo, Math.floor(opts.maxMs === undefined ? OPERATION_DELAY_MAX_MS : Number(opts.maxMs)))
  const r = resolveRng(rng)
  return lo + Math.floor(r() * (hi - lo + 1))
}

// ═══════════════════════════════════════════════════════════
// 输入计划
// ═══════════════════════════════════════════════════════════

/**
 * 生成拟人化的输入计划。
 *
 * ⚠️ 三条不可省的细节：
 *   1. **按块输入而不是逐字**：真人用输入法一次上屏一个词组，
 *      严格逐字（每字间隔都一样）反而是机器特征。
 *   2. **标点后停久一点**：真人打完一句话会停顿思考。
 *   3. **拼接必须严格等于原文**：块边界由 JS 字符串下标切出，
 *      而 String.prototype.slice 在 UTF-16 码元上切分——对 BMP 内的
 *      中英文完全正确；emoji（代理对）只会被切成两半后相邻拼接，
 *      拼回来仍是原串。测试里对此有断言。
 *
 * @param {string} text
 * @param {object} [opts] {rng, sigma, baseMs}
 * @returns {Array<{text:string, delayMs:number}>} 每块的文本与**该块之前的**停顿
 */
function typingPlan(text, opts = {}) {
  const s = text === undefined || text === null ? '' : String(text)
  if (s.length === 0) return []

  const rng = resolveRng(opts.rng)
  const sigma = opts.sigma === undefined ? TYPING_SIGMA : Number(opts.sigma)
  const baseMs = opts.baseMs === undefined ? TYPING_BASE_MS : Number(opts.baseMs)
  if (!Number.isFinite(sigma) || sigma < 0) throw new Error(`typingPlan 的 sigma 非法：${opts.sigma}`)
  if (!Number.isFinite(baseMs) || baseMs < 0) throw new Error(`typingPlan 的 baseMs 非法：${opts.baseMs}`)

  const out = []
  let i = 0
  while (i < s.length) {
    // ⚠️ 块长至少 1（不能出现空块，否则文本会丢字符）
    const chunkLen = Math.max(1, Math.round(Math.exp(sigma * normalSample(rng))))
    const end = Math.min(s.length, i + chunkLen)
    const chunk = s.slice(i, end)

    // 块内最后一个字符（退而取块的任意字符）决定是否有标点停顿
    const lastChar = chunk[chunk.length - 1] || ''
    const punct = PUNCT_CHARS.includes(lastChar)

    let delayMs
    if (punct) {
      delayMs = TYPING_PUNCT_PAUSE_MIN_MS +
        Math.round(rng() * (TYPING_PUNCT_PAUSE_MAX_MS - TYPING_PUNCT_PAUSE_MIN_MS))
    } else {
      const jitter = Math.round(rng() * TYPING_BASE_JITTER)
      delayMs = Math.max(1, Math.round(baseMs) + jitter)
    }

    // 偶尔来一次明显更长的停顿（"想了一下"），概率与上限都是形状常数
    if (rng() < TYPING_LONG_PAUSE_PROBABILITY) {
      delayMs += TYPING_LONG_PAUSE_MIN_MS +
        Math.round(rng() * (TYPING_LONG_PAUSE_MAX_MS - TYPING_LONG_PAUSE_MIN_MS))
    }

    out.push({ text: chunk, delayMs })
    i = end
  }
  return out
}

// ═══════════════════════════════════════════════════════════
// 活跃时段
// ═══════════════════════════════════════════════════════════

/** 取活跃时段的时区偏移（分钟），缺省 UTC+8。 */
function tzOffsetOf(activeHours) {
  const v = activeHours && activeHours.tz_offset_minutes
  return Number.isFinite(Number(v)) ? Number(v) : TZ_OFFSET_MINUTES
}

/** 本地时刻（UTC+偏移）距本地当日 00:00 的毫秒数。 */
function msOfLocalDay(ms, offsetMs) {
  const local = ms + offsetMs
  return ((local % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY
}

/**
 * 当天的活跃时段随机抖动。
 *
 * ⚠️⚠️ **抖动只能向内收**：起点往后推、终点往前挪。
 *    写反（起点提前 / 终点延后）会**延长**可发送时间——那是放宽安全限制，
 *    属于红线 1。返回的窗口一定是传入窗口的**子集**。
 *
 * ⚠️ 抖动是"每天一次"的：调用方应按自然日缓存结果（同一天内多次调用
 *    若传同一个 rng 会得到不同窗口，导致调度器与审计口径不一致）。
 *
 * @param {{windows?:Array<[string,string]>, tz_offset_minutes?:number}} activeHours
 * @param {() => number} [rng]
 * @returns {Array<[string,string]>} 抖动后的窗口（格式与输入一致）
 */
function dailyActiveHoursDrift(activeHours, rng) {
  const windows = activeHours && activeHours.windows
  // 未配置 = 不限时段（与 guard.isWithinActiveHours 的口径一致）
  if (!Array.isArray(windows) || windows.length === 0) return []
  const r = resolveRng(rng)

  const out = []
  for (const w of windows) {
    const s = toMinutes(w && w[0])
    const e = toMinutes(w && w[1])
    if (s === null || e === null || s >= e) {
      // 非法/跨天窗口原样保留：本模块不负责纠正配置，交由 guard 判定
      out.push([w[0], w[1]])
      continue
    }

    const span = e - s
    const cap = Math.min(DRIFT_MAX_MINUTES, Math.floor(span * DRIFT_RATIO))
    const startJitter = cap > 0 ? Math.floor(r() * (cap + 1)) : 0
    const endJitter = cap > 0 ? Math.floor(r() * (cap + 1)) : 0
    let ns = s + startJitter
    let ne = e - endJitter

    // 保证抖动后仍是一个可用的窗口（过短的窗口会让调度器几乎无法发送）
    if (ne - ns < MIN_WINDOW_KEEP_MINUTES) {
      ns = s
      ne = e
    }
    out.push([minutesToHHMM(ns), minutesToHHMM(ne)])
  }
  return out
}

/** 分钟数 → "HH:MM"。 */
function minutesToHHMM(min) {
  const m = ((Math.round(Number(min)) % (24 * 60)) + 24 * 60) % (24 * 60)
  const hh = String(Math.floor(m / 60)).padStart(2, '0')
  const mm = String(m % 60).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * 距离下一个可发送时刻还有多久。
 *
 * ⚠️ **已在窗口内返回 0**（不是负值、也不是"顺手再等一会"）。
 *    返回负值会让调用方的 `setTimeout` 立刻触发，静默变成"无间隔发送"。
 *
 * @param {number} nowMs
 * @param {{windows?:Array<[string,string]>, tz_offset_minutes?:number}} activeHours
 * @returns {number} 毫秒；0 表示当前就在窗口内
 */
function pickDelayUntilActiveHours(nowMs, activeHours) {
  const windows = activeHours && activeHours.windows
  if (!Array.isArray(windows) || windows.length === 0) return 0 // 未配置 = 不限

  const now = Number(nowMs)
  if (!Number.isFinite(now)) throw new Error(`pickDelayUntilActiveHours 收到非法时刻：${nowMs}`)

  const offsetMs = tzOffsetOf(activeHours) * 60 * 1000
  const nowMin = msOfLocalDay(now, offsetMs) / 60000

  const parsed = windows
    .map((w) => ({ s: toMinutes(w && w[0]), e: toMinutes(w && w[1]) }))
    .filter((w) => w.s !== null && w.e !== null && w.s < w.e)
  if (parsed.length === 0) return 0

  for (const w of parsed) {
    if (nowMin >= w.s && nowMin < w.e) return 0 // 已在窗口内
  }

  // 今天还没开始的最近一个窗口
  let best = null
  for (const w of parsed) {
    if (w.s > nowMin && (best === null || w.s < best)) best = w.s
  }
  const targetMin = best === null
    ? Math.min(...parsed.map((w) => w.s)) + 24 * 60 // 今天已过 → 明天的第一个窗口
    : best

  return Math.max(0, Math.ceil(targetMin * 60000 - nowMin * 60000))
}

// ═══════════════════════════════════════════════════════════
// 分布体检（测试与运维巡检用）
// ═══════════════════════════════════════════════════════════

/**
 * 采样并统计间隔分布，用于证明"不是固定间隔"。
 *
 * ⚠️ 这是**只读工具**，不参与发送链路。测试用它断言：
 *    · 全部样本落在 [minMs, maxMs] 内
 *    · 标准差足够大（不是常数）
 *    · 没有单个分桶占比超过约 40%（不是"换了外衣的固定值"）
 *
 * @param {number} n 样本数
 * @param {object} opts 同 nextIntervalMs，另有 buckets
 * @returns {{n:number, minMs:number, maxMs:number, mean:number, stddev:number,
 *            minSample:number, maxSample:number, distinct:number,
 *            inRange:number, outOfRange:number, histogram:number[],
 *            buckets:number, maxBucketRatio:number}}
 */
function describeIntervalDistribution(n, opts = {}) {
  const count = Math.max(1, Math.floor(Number(n) || 0))
  const rng = resolveRng(opts.rng)
  const samples = []
  for (let i = 0; i < count; i++) {
    samples.push(nextIntervalMs({
      minMs: opts.minMs,
      maxMs: opts.maxMs,
      sigma: opts.sigma,
      rng,
    }))
  }
  return summarize(samples, {
    minMs: Math.floor(Number(opts.minMs)),
    maxMs: opts.maxMs === undefined
      ? Math.floor(Number(opts.minMs) * INTERVAL_SPREAD_RATIO)
      : Math.floor(Number(opts.maxMs)),
    buckets: opts.buckets === undefined ? DIST_BUCKETS : Math.max(2, Math.floor(opts.buckets)),
  })
}

/** 纯统计：把样本数组汇总成分布体检结果（便于测试直接喂构造数据）。 */
function summarize(samples, opts) {
  const n = samples.length
  const mean = samples.reduce((a, b) => a + b, 0) / n
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  const buckets = opts.buckets
  const lo = opts.minMs
  const hi = opts.maxMs
  const width = (hi - lo) / buckets || 1

  const histogram = new Array(buckets).fill(0)
  let outOfRange = 0
  for (const v of samples) {
    if (v < lo || v > hi) outOfRange++
    const idx = clamp(Math.floor((v - lo) / width), 0, buckets - 1)
    histogram[idx]++
  }

  return {
    n,
    minMs: lo,
    maxMs: hi,
    mean: Number(mean.toFixed(2)),
    stddev: Number(Math.sqrt(variance).toFixed(2)),
    minSample: Math.min(...samples),
    maxSample: Math.max(...samples),
    distinct: new Set(samples).size,
    inRange: n - outOfRange,
    outOfRange,
    histogram,
    buckets,
    maxBucketRatio: Number((Math.max(...histogram) / n).toFixed(4)),
  }
}

module.exports = {
  nextIntervalMs,
  operationDelayMs,
  typingPlan,
  dailyActiveHoursDrift,
  pickDelayUntilActiveHours,
  describeIntervalDistribution,
  makeSeededRng,
  // 常量（分布形状，非安全限额）
  OPERATION_DELAY_MIN_MS,
  OPERATION_DELAY_MAX_MS,
  INTERVAL_SIGMA,
  INTERVAL_SPREAD_RATIO,
  TYPING_SIGMA,
  PUNCT_CHARS,
  DRIFT_RATIO,
  DRIFT_MAX_MINUTES,
  MIN_WINDOW_KEEP_MINUTES,
  // 工具
  minutesToHHMM,
  summarize,
  dayStartMs,
}
