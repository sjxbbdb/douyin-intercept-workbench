'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { INTENTS } = require('./blocked-codes');

// 意图判据（规则版）。
//
// 为什么先用规则而不是 LLM：
//   1) 可解释：每条判定都能说出"命中了哪个词"，商家能自己核对、自己改；
//   2) 零推理成本、零新增未知：LLM 意图识别要背准确率/召回门槛与评估集，那是后面的事；
//   3) v3 章程的原意就是"商家自配话术池与判据，改完即生效"。
//
// 🔴 complaint 的召回是硬门槛（契约 §11.1：>= 95%）。所以：
//   · complaint 排在最前，一命中就停，不被后面的规则抢走；
//   · 关键词宁宽勿窄 —— 漏掉一条投诉的代价，远大于多拦一条。

const DEFAULT_RULES = [
  { intent: 'complaint', priority: 100, keywords: [
    '骗子', '骗人', '骗钱', '诈骗', '割韭菜', '忽悠', '垃圾', '坑人', '太坑', '踩坑',
    '退款', '退钱', '退不了', '不给退', '不退', '投诉', '举报', '维权', '曝光', '拉黑',
    '差评', '虚假', '假冒', '假货', '不满', '无良', '黑心', '恶心', '态度差', '态度恶劣',
    '骗局', '智商税', '太差', '差劲', '客服不理', '没人管'
  ] },
  { intent: 'after_sales', priority: 80, keywords: [
    '售后', '退换', '换货', '维修', '坏了', '不能用', '用不了', '打不开', '登不上',
    '闪退', '报错', '出错', '故障', '失效', '过期', '没反应', '卡住'
  ] },
  { intent: 'price_inquiry', priority: 60, keywords: [
    '多少钱', '价格', '价位', '收费', '报价', '费用', '贵不贵', '便宜', '免费吗',
    '怎么卖', '几块', '一年多少', '贵吗'
  ] },
  { intent: 'purchase_intent', priority: 50, keywords: [
    '怎么买', '想要', '购买', '下单', '求带', '带我', '报名', '加入', '怎么加入',
    '求教程', '想看', '链接', '哪里有', '在哪买'
  ] },
  { intent: 'feature_question', priority: 20, keywords: [
    '怎么', '如何', '能不能', '可以吗', '支持吗', '有没有', '教程', '怎么学', '好学吗',
    '适合', '需要什么'
  ] }
];

// 明显与业务无关的短噪音：长度太短、纯语气词、纯表情。
const NOISE_PATTERNS = [
  /^[\s\p{P}\p{S}]+$/u,
  /^[哈哈嘿呵嗯哦噢啊呀哎唉额]+$/u,
  /^(第一|沙发|前排|路过|打卡|互关|互粉|来了|签到)$/u
];

function rulesFile(agentStateDir, accountScope) {
  return path.join(agentStateDir, 'accounts', String(accountScope), 'intent-rules.json');
}

// 规则可以覆盖：文件里给 { rules: [...] } 就整体替换默认规则。
// 校验不过就整体退回默认并说明原因 —— 宁可判得保守，也不能带着半套规则跑。
function loadRules(agentStateDir, accountScope) {
  const file = rulesFile(agentStateDir, accountScope);
  if (!fs.existsSync(file)) return { ok: true, rules: DEFAULT_RULES, source: 'builtin_default' };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { ok: true, rules: DEFAULT_RULES, source: 'builtin_default',
             warning: 'intent-rules.json is not valid JSON; falling back to defaults' };
  }
  const raw = parsed && Array.isArray(parsed.rules) ? parsed.rules : null;
  if (!raw || !raw.length) {
    return { ok: true, rules: DEFAULT_RULES, source: 'builtin_default',
             warning: 'intent-rules.json has no non-empty rules array; falling back to defaults' };
  }
  const cleaned = [];
  for (let i = 0; i < raw.length; i += 1) {
    const rule = raw[i] || {};
    if (INTENTS.indexOf(String(rule.intent)) === -1) {
      return { ok: true, rules: DEFAULT_RULES, source: 'builtin_default',
               warning: 'rule ' + i + ' has an intent outside the closed enum; falling back to defaults' };
    }
    if (!Array.isArray(rule.keywords) || !rule.keywords.length) {
      return { ok: true, rules: DEFAULT_RULES, source: 'builtin_default',
               warning: 'rule ' + i + ' has no keywords; falling back to defaults' };
    }
    cleaned.push({
      intent: String(rule.intent),
      priority: Number.isFinite(Number(rule.priority)) ? Number(rule.priority) : 0,
      keywords: rule.keywords.map(function (k) { return String(k); }).filter(Boolean)
    });
  }
  // 高优先级在前：优先级是唯一决定"谁先判"的东西，不靠书写顺序。
  cleaned.sort(function (a, b) { return b.priority - a.priority; });
  return { ok: true, rules: cleaned, source: 'intent-rules.json' };
}

function isNoise(text) {
  const raw = String(text == null ? '' : text).trim();
  if (raw.length < 2) return true;
  return NOISE_PATTERNS.some(function (re) { return re.test(raw); });
}

// 返回闭集里的 intent + 命中的关键词。命中不了就是 unknown —— 不猜。
function classify(text, rules) {
  const list = Array.isArray(rules) && rules.length ? rules : DEFAULT_RULES;
  const raw = String(text == null ? '' : text).trim();
  // 空文本 = 没有内容可判，不是"判不出来"：空的东西本来就不该进候选。
  if (!raw) return { intent: 'irrelevant', matched: [], reasonCode: 'rule_priority' };
  if (isNoise(raw)) return { intent: 'irrelevant', matched: [], reasonCode: 'rule_priority' };
  for (let i = 0; i < list.length; i += 1) {
    const rule = list[i];
    const matched = rule.keywords.filter(function (k) { return raw.indexOf(k) !== -1; });
    if (matched.length) {
      return { intent: rule.intent, matched, reasonCode: 'rule_priority' };
    }
  }
  return { intent: 'unknown', matched: [], reasonCode: 'rule_priority' };
}

function isComplaint(intent) {
  return String(intent) === 'complaint';
}

module.exports = { DEFAULT_RULES, rulesFile, loadRules, classify, isNoise, isComplaint };
