'use strict'

// client/license/privacy.js
//
// 上报前的隐私处理 —— **红线 3 的唯一落地点**。
//
// ⚠️ 契约 §7.5 的硬约束：上报里**绝不允许**出现
//      · 评论/弹幕/私信原文
//      · 回复内容原文
//      · `sec_uid` 原文、昵称、头像地址
//      · 抖音 Cookie / token
//    只允许上传**哈希与计数**。
//
// ⚠️ 为什么必须带盐（`privacy_salt`，服务端下发）：
//    抖音用户 ID 空间是**可枚举**的（纯数字或短字符串）。无盐哈希等于
//    "把原文换个写法上传"——攻击者手上有全部 ID 就能做彩虹表反查。
//    加盐后同一用户在服务端仍是稳定可聚合的（同一个盐），
//    但盐不下发到第三方，反查不可行。
//
// ⚠️ 盐轮换（`privacy_salt_version`）会让**同一用户在新盐下产生不同哈希**。
//    这是刻意的：跨版本不可关联。代价是服务端的"唯一用户"统计在轮换日
//    会重置，这一点必须让运营方知道——所以本模块提供 `saltVersion()` 供上报携带。

const crypto = require('node:crypto')

/**
 * 计算隐私哈希。
 *
 * @param {string} value       原文（sec_uid / 用户标识 / 内容）
 * @param {string} salt        服务端下发的 privacy_salt
 * @param {string} [namespace] 命名空间，避免不同字段之间碰撞
 *                             （如 user 与 content 恰好同串时会得到同一哈希）
 * @returns {string} 64 hex
 */
function privacyHash(value, salt, namespace = 'v1') {
  if (value === undefined || value === null || value === '') {
    throw new Error(`privacyHash 需要非空 value（namespace=${namespace}）`)
  }
  if (!salt) {
    // ⚠️ fail-closed：没有盐就不允许上报。
    //    退化成无盐哈希会**静默**削弱隐私保护，是最糟的失败方式。
    throw new Error('缺少 privacy_salt，拒绝生成可被反查的哈希。请先完成登录。')
  }
  return crypto
    .createHash('sha256')
    .update(`${namespace}|${salt}|${String(value)}`, 'utf8')
    .digest('hex')
}

/** 用户标识哈希（`user_key_hash`，契约 §4.8）。 */
function userKeyHash(secUid, salt) {
  return privacyHash(secUid, salt, 'user')
}

/** 内容哈希（`content_hash`，契约 §4.8）。 */
function contentHash(text, salt) {
  return privacyHash(text, salt, 'content')
}

/** 目标哈希（`target_hash`：被回复的评论 ID / 弹幕 ID / 会话 ID）。 */
function targetHash(targetId, salt) {
  return privacyHash(targetId, salt, 'target')
}

/**
 * 上报前扫描：发现隐私字段就抛错。
 *
 * ⚠️ 为什么要有这一层而不是"写代码时小心点"：
 *    上报对象是层层拼出来的，任何一层多带一个字段（例如把整条评论
 *    对象塞进 evidence 方便排障）都会把原文传到服务端，而且**服务端
 *    大概率不会报错**——它会正常入库。等发现时数据已经出去了。
 *    所以这里做**白名单式**拒绝：出现禁用键名一律拒绝发送。
 *
 * ⚠️ 匹配是**精确键名**，不是子串。
 *    早期版本用 `includes` 判断，把合法的 `content_hash` 也判成泄露，
 *    结果上报全被拦下。禁用的是 `content` 这个键，不是含有 content 的键。
 */
const FORBIDDEN_KEYS = Object.freeze([
  'content', 'text', 'comment', 'comment_text', 'reply', 'reply_text',
  'message', 'msg', 'danmaku', 'danmaku_text', 'dm_text',
  'sec_uid', 'secUid', 'uid', 'user_id', 'userId', 'nickname', 'nick_name',
  'avatar', 'avatar_url', 'cookie', 'cookies', 'token', 'password',
  'pass_hash', 'sign_key', 'phone', 'mobile', 'email', 'id_card',
])

/**
 * 结构性路径：这些路径下的**子键名**与隐私键重名，但语义完全不同。
 *
 * ⚠️ 必须显式豁免，否则会把合法上报全部拦下。具体冲突：
 *    契约 §4.8 的 `policy_snapshot.applied_limits` 形如
 *    `{comment:{daily_max,min_interval_ms}, live_danmaku:{...}, dm:{...}}`——
 *    这里的 `comment` 是**渠道名**，不是评论内容。
 *    按键名一刀切会把每一批上报都判成隐私泄露，
 *    而后果是**计费明细永远报不上去**（比漏报更严重）。
 *
 * ⚠️ 豁免的作用域是"该路径之下的所有层级"，用**路径后缀**匹配，
 *    因此写 `applied_limits` 即可覆盖 `policy_snapshot.applied_limits`
 *    以及数组元素里的同名字段。豁免范围内只跳过**键名**检查，
 *    值仍会被继续遍历——真的塞进原文还是会被抓到别处。
 */
const STRUCTURAL_KEY_PATHS = Object.freeze([
  'applied_limits',
])

/**
 * 深度扫描对象，返回发现的禁用键路径列表（空数组 = 通过）。
 *
 * @param {any} obj
 * @param {object} [opts]
 * @param {string[]} [opts.allow] 允许的例外键名（值须仍是哈希/计数）
 * @returns {string[]} 形如 `sends[0].evidence.comment`
 */
function scanForPrivacyLeaks(obj, opts = {}) {
  const allow = new Set(opts.allow || [])
  const hits = []
  const seen = new WeakSet()

  /**
   * @param {any} node
   * @param {string} pathStr
   * @param {boolean} structuralInside 是否已处于结构性路径之内
   */
  const walk = (node, pathStr, structuralInside) => {
    if (node === null || node === undefined) return
    const t = typeof node
    if (t === 'string' || t === 'number' || t === 'boolean') return
    if (t !== 'object') return
    if (seen.has(node)) return
    seen.add(node)

    if (Array.isArray(node)) {
      // ⚠️ 数组不消耗路径，structuralInside 原样传递——
      //    实际数据里 `applied_limits` 常出现在数组元素中，
      //    若在这里复位就会漏掉豁免。
      node.forEach((v, i) => walk(v, `${pathStr}[${i}]`, structuralInside))
      return
    }

    for (const [k, v] of Object.entries(node)) {
      const p = pathStr ? `${pathStr}.${k}` : k
      const isStructuralKey = STRUCTURAL_KEY_PATHS.includes(k)
      if (!structuralInside && isStructuralKey) {
        walk(v, p, true)
        continue
      }
      if (!structuralInside && !allow.has(k) && FORBIDDEN_KEYS.includes(k)) {
        hits.push(p)
        continue
      }
      walk(v, p, structuralInside)
    }
  }

  walk(obj, '', false)
  return hits
}

module.exports = {
  privacyHash,
  userKeyHash,
  contentHash,
  targetHash,
  scanForPrivacyLeaks,
  FORBIDDEN_KEYS,
  STRUCTURAL_KEY_PATHS,
}
