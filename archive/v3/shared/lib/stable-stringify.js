'use strict'

// shared/lib/stable-stringify.js
//
// ⚠️ 确定性序列化。HMAC 签名串依赖它，任何行为变化都会导致**全网签名校验失败**。
//
// 要求（protocol.md §5）：
//   · 递归按 key 升序排列
//   · 无多余空格
//   · 数组保持原序（顺序有语义）
//   · 覆盖 undefined / null / 数字 / 布尔 / 字符串 / 嵌套对象 / 数组
//
// ⚠️ 已实测过的三个坑（写测试时覆盖了）：
//   1. 不能用 JSON.stringify 的 replacer 做排序——replacer 拿到的是已被
//      引擎处理过的值，无法重排 key。
//   2. 浮点数必须走 String(n)；不能用 toFixed，会丢精度导致两端不一致。
//   3. 显式区分 undefined 与 null：undefined 的键**整体省略**（与 JSON 一致），
//      null 保留为 null。混同会让签名在两端算出不同结果。

/**
 * 确定性序列化。等价于"对 key 递归排序后的 JSON.stringify"。
 * @param {*} value
 * @returns {string}
 */
function stableStringify(value) {
  return serialize(value)
}

function serialize(value) {
  if (value === null) return 'null'

  const type = typeof value

  if (type === 'undefined') return undefined // 由调用方决定省略（对象键）或转 null（数组项）
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      // NaN / Infinity 无 JSON 表示。抛错好过静默产出不可校验的签名。
      throw new TypeError(`stableStringify 不支持非有限数字：${value}`)
    }
    return String(value)
  }
  if (type === 'bigint') return String(value)
  if (type === 'string') return JSON.stringify(value)

  if (Array.isArray(value)) {
    const items = value.map((item) => {
      const s = serialize(item)
      return s === undefined ? 'null' : s // 数组项里的 undefined 转 null（与 JSON 一致）
    })
    return `[${items.join(',')}]`
  }

  if (type === 'object') {
    const keys = Object.keys(value).sort()
    const parts = []
    for (const key of keys) {
      const s = serialize(value[key])
      if (s === undefined) continue // 对象键值为 undefined → 整体省略
      parts.push(`${JSON.stringify(key)}:${s}`)
    }
    return `{${parts.join(',')}}`
  }

  // function / symbol 不参与序列化
  return undefined
}

module.exports = { stableStringify }
