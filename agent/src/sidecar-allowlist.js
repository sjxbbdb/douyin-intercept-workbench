'use strict';

// sidecar 方法的【单一事实来源】：分层白名单 + 禁止清单。
//
// 为什么单独一个模块：registry.js 依赖 tools，tools 又要 import 它 ——
// 直接互相 require 会成环。把清单放进这个没有依赖的叶子模块，两边都能用。
//
// 🔴 关键设计：这里提供【运行时】断言（assertAllowed），不只是静态文本扫描。
//    早先的守卫是"扫源码里有没有出现方法名"，那有两个毛病：
//      ① 双引号写法能绕过（只扫了单引号）；
//      ② 绕过方式无穷，守卫永远追不上。
//    现在真正的闸门在调用现场：任何一次 sidecar 调用都必须过 assertAllowed。

const READ_SIDECAR_METHODS = ['capabilities', 'doctor', 'search_pool', 'comment_result', 'live_result'];
const CAPTURE_SIDECAR_METHODS = ['search', 'collect_comments', 'collect_live', 'live_listen'];
const PLAN_SIDECAR_METHODS = ['comment_plan'];
// execute：真正写入平台内容的方法。只有 approve_batch 用得到，
// 而且它必须先拿到服务端【逐条】授权。
// execute：真正写入平台内容的方法。只有 approve_batch / approve_private 用得到，
// 且每一步都必须先拿到服务端【逐条】授权。
const EXECUTE_SIDECAR_METHODS = ['comment_reply', 'live_reply', 'comment_private'];
const LIFECYCLE_SIDECAR_METHODS = ['launch', 'close'];

const ALLOWED_SIDECAR_METHODS = [].concat(
  READ_SIDECAR_METHODS,
  CAPTURE_SIDECAR_METHODS,
  PLAN_SIDECAR_METHODS,
  EXECUTE_SIDECAR_METHODS,
  LIFECYCLE_SIDECAR_METHODS
);

// 明确禁止：私信（第二阶段必须单独审批）、任意跳转、单发入口、直播建计划。
// 仍然禁止：单发入口（绕过批次）、任意跳转、直播建计划。
// 私信的【批次】入口 comment_private 已进 execute 层（有单独审批工具与两阶段绑定）；
// 但单发私信 send_private 依旧禁止 —— 它没有批次与 publicSendId 的强制上下文。
const FORBIDDEN_SIDECAR_METHODS = [
  'open', 'live_private', 'live_plan', 'send_private', 'send_comment'
];

function isAllowed(method) {
  return ALLOWED_SIDECAR_METHODS.indexOf(String(method)) !== -1;
}

// 运行时闸门。返回 null 表示放行；否则返回稳定原因。
function check(method) {
  const name = String(method == null ? '' : method);
  if (!name) return { code: 'blocked/invalid_input', reason: 'sidecar method is required' };
  if (FORBIDDEN_SIDECAR_METHODS.indexOf(name) !== -1) {
    return { code: 'blocked/unsupported',
             reason: 'sidecar method is forbidden at this layer: ' + name };
  }
  if (!isAllowed(name)) {
    return { code: 'blocked/unsupported',
             reason: 'sidecar method is not in the allowlist: ' + name };
  }
  return null;
}

module.exports = {
  READ_SIDECAR_METHODS,
  CAPTURE_SIDECAR_METHODS,
  PLAN_SIDECAR_METHODS,
  EXECUTE_SIDECAR_METHODS,
  LIFECYCLE_SIDECAR_METHODS,
  ALLOWED_SIDECAR_METHODS,
  FORBIDDEN_SIDECAR_METHODS,
  isAllowed,
  check
};
