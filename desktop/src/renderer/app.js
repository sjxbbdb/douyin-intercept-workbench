'use strict';

const state = { view: 'tasks', data: null, ledger: [], endpoint: '', draftUrl: '', taskEditor: null, recheckPending: new Set() };
const UNVERIFIED_CANDIDATE = { commentNode: '[data-e2e="comment-item"], [data-e2e="comment-list"] [role="listitem"]', commentText: '[data-e2e="comment-text"]', commentAuthor: '[data-e2e="comment-author"]', commentId: '[data-comment-id]', replyInput: 'textarea, [contenteditable="true"]', sendButton: 'button', replyButton: 'button' };
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const formatExpiry = (value) => { const time = Number(value); return Number.isFinite(time) ? new Date(time).toLocaleString() : '有效期未知'; };
const formatDate = (value) => { const time = typeof value === 'number' ? value : Date.parse(String(value || '')); return Number.isFinite(time) ? new Date(time).toLocaleString() : '时间未知'; };
const creditKind = (value) => ({ admin_credit: '管理员充值', redeem: '兑换积分', evaluate_reply: '规则回复生成', draft_reply: 'Agent 回复生成', refund: '退回积分' }[value] || '积分变动');
const reasonText = (value) => ({ local_no_keyword: '关键词未命中', local_keywords_missing: '未设置关键词', local_exclude: '命中排除词', empty: '评论内容为空', generation_budget_exhausted: '今日判定上限已用完', sender_capability_unverified: '发送能力尚未验证', license_required: '需要有效授权', SIDECAR_BUSY: '侧车当前忙', target_not_open: '打开目标页面，任务已暂停', browser_navigation: '打开目标页面，任务已暂停' }[value] || String(value ?? ''));
const recheckResultText = (result = {}) => { const evaluated = Number(result.evaluated || 0); const queued = Number(result.queued || 0); const skipped = Number(result.skipped || 0); const detail = String(result.message || reasonText(result.stopReason) || '').trim(); const prefix = detail ? (evaluated || queued ? '重新筛选部分完成' : '重新筛选未完成') : '重新筛选完成'; return `${prefix}：已判定 ${evaluated} 条，新增待确认 ${queued} 条，跳过 ${skipped} 条${detail ? `；${detail}` : ''}`; };
const taskLogLabel = (value) => ({ task_saved: '任务已保存', task_running: '任务已启动', task_paused: '任务已暂停', task_stopped: '任务已停止', task_offline: '任务已离线', task_blocked: '任务被阻止', task_deleted: '任务已删除', recheck_skipped: '重新筛选', task_recheck: '重新筛选', storage_recovery_required: '本地记录需要恢复' }[value] || null);
const notify = (message, kind = 'info') => { const node = $('#notice'); node.textContent = message; node.dataset.kind = kind; node.hidden = false; window.setTimeout(() => { node.hidden = true; }, 5000); };
const clientError = (error) => {
  let message = String(error?.message || '操作失败').replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^(?:ProbeError|Error):\s*/i, '').trim();
  if (/target_not_found|owned browser target is unavailable/i.test(message)) return '专用浏览器标签页已关闭，请重新打开目标页面';
  if (/IPC|sender|stack|Cannot|undefined|TypeError/i.test(message)) return '桌面状态暂时不可用，请稍后重试';
  return message;
};
const call = async (action, ...args) => { try { const result = await action(...args); await refresh(); return result; } catch (error) { console.error('[desktop-ui]', error); notify(clientError(error), 'error'); throw error; } };
const licenseIdentity = (license) => license?.user?.id || license?.user?.username || license?.user?.email || null;
const openTaskEditor = (task = {}) => { state.taskEditor = { license: licenseIdentity(state.data?.license), submitting: false }; $('#content').innerHTML = taskForm(task); bind(); };

async function refresh() {
  state.data = await window.agentApi.getState();
  const endpoint = await window.agentApi.getEndpoint();
  state.endpoint = endpoint.apiEndpoint;
  render();
}

function statusText(status) { return ({ running: '运行中', paused: '已暂停', stopped: '已停止', needs_calibration: '需要校准', license_required: '需要授权', offline: '离线' }[status] || status || '未知'); }

function renderHeader() {
  const license = state.data?.license || {};
  const browser = state.data?.browser || {};
  $('#license-status').textContent = license.state === 'authorized' ? `已授权至 ${formatExpiry(license.user?.expiresAt)}` : license.state === 'expired' ? '授权已失效' : '未授权';
  $('#license-status').dataset.kind = license.state === 'authorized' ? 'ok' : 'warn';
  $('#browser-status').textContent = browser.connected ? `抖音窗口已连接，本轮读取 ${browser.matchCount || 0} 条评论` : '抖音窗口未连接';
  $('#balance').textContent = `积分 ${license.balance ?? '--'}`;
  $('#page-title').textContent = ({ tasks: '任务', leads: '线索', logs: '回复记录', credits: '积分', settings: '设置' }[state.view] || '任务');
}

function renderLogin() {
  return `<section class="auth-panel"><div class="section-heading"><div><p class="eyebrow">需要工作台授权</p><h2>登录后开始采集</h2><p class="muted">抖音账号仍需在专用窗口内由你手动登录。桌面端不会读取 Cookie 或 Token。</p></div></div><form id="login-form" class="form-grid narrow"><label>工作台账号<input name="username" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button class="primary" type="submit">登录工作台</button></form><p class="helper">授权中心地址可在设置中修改。首次运行默认为本机开发地址。</p></section>`;
}

function taskForm(task = {}) {
  task = { ...task, url: task.url || state.draftUrl || '' };
  const features = state.data?.license?.features || {};
  const aiEnabled = features.draft === true || features.ai === true || features.aiEnabled === true;
  return `<section class="panel form-panel"><div class="section-heading"><div><p class="eyebrow">任务配置</p><h2>${task.id ? '编辑任务' : '新建任务'}</h2></div><button class="quiet" data-action="cancel-task">取消</button></div><form id="task-form" class="form-grid"><input type="hidden" name="id" value="${escapeHtml(task.id || '')}"><label class="span-2">目标视频或直播 URL<input name="url" type="url" placeholder="https://www.douyin.com/video/..." value="${escapeHtml(task.url || '')}" required></label><label>来源<select name="source"><option value="video" ${task.source !== 'live' ? 'selected' : ''}>视频评论</option><option value="live" ${task.source === 'live' ? 'selected' : ''}>直播公屏</option></select></label><label>触达方式<select name="contactMode"><option value="comment" ${task.contactMode !== 'private' ? 'selected' : ''}>原评论回复</option><option value="private" ${task.contactMode === 'private' ? 'selected' : ''}>私信目标用户</option></select></label><label>决策模式<select name="decisionMode"><option value="rule" ${task.decisionMode !== 'ai' ? 'selected' : ''}>规则筛选与模板</option><option value="ai" ${task.decisionMode === 'ai' ? 'selected' : ''} ${aiEnabled ? '' : 'disabled'}>Agent 意向判断${aiEnabled ? '' : '（未配置）'}</option></select></label><label class="span-2">卖什么<input name="businessContext" value="${escapeHtml(task.businessContext || '')}" placeholder="例如：南京本地婚礼摄影套餐"></label><label class="span-2">目标客户<input name="targetCustomer" value="${escapeHtml(task.targetCustomer || '')}" placeholder="例如：近期准备婚礼且在南京的用户"></label><label>关键词<input name="keywords" value="${escapeHtml((task.keywords || []).join('，'))}" placeholder="价格，怎么买"><small class="helper">规则模式启动前至少填写一个关键词；留空仍可保存草稿。</small></label><label>排除词<input name="excludeKeywords" value="${escapeHtml((task.excludeKeywords || []).join('，'))}" placeholder="投诉，退款"></label><label class="span-2">回复模板<textarea name="replyTemplate" required placeholder="您好，已看到您的问题，我们会尽快联系您。">${escapeHtml(task.replyTemplate || '')}</textarea></label><label class="span-2">话术要求与禁止承诺<textarea name="replyInstructions" placeholder="不要承诺最低价，不要索要敏感信息">${escapeHtml(task.replyInstructions || '')}</textarea></label><label>工作模式<select name="mode"><option value="manual" ${task.mode !== 'auto' ? 'selected' : ''}>人工确认后发送</option><option value="auto" ${task.mode === 'auto' ? 'selected' : ''}>自动发送</option></select></label><label>发送间隔（毫秒）<input name="intervalMs" type="number" min="0" value="${task.intervalMs || 30000}"></label><label>每日判定上限<input name="maxActions" type="number" min="1" value="${task.maxActions || task.dailyLimit || 20}" required></label><label>每日发送上限<input name="dailyLimit" type="number" min="1" value="${task.dailyLimit || 20}" required></label><div class="form-foot span-2"><p class="helper">判定上限和间隔是本机保守设置，授权中心仍会按账号和积分权威重验。未命中服务端结果也计入判定次数，本地关键词筛掉的评论不计；生成回复会消耗服务端积分，实际价格以积分页为准。</p><button class="primary" type="submit">保存任务</button></div></form></section>`;
}

function renderTasks() {
  const tasks = state.data?.tasks || [];
  const events = state.data?.events || [];
  const pending = state.data?.pending || [];
  const today = new Date().toISOString().slice(0, 10);
  const taskQuota = (task) => { const currentDay = task.actionDay === today; return { generationToday: currentDay ? Number(task.generationToday || 0) : 0, sendAttemptsToday: currentDay ? Number(task.sendAttemptsToday || 0) : 0, maxActions: Number(task.maxActions || task.dailyLimit || 0), dailyLimit: Number(task.dailyLimit || 0) }; };
  const taskSummary = (task) => {
    const recent = events.filter((event) => event.taskId === task.id);
    const noKeyword = recent.filter((event) => event.reason === 'local_no_keyword').length;
    const taskPending = pending.filter((item) => item.taskId === task.id).length;
    const { generationToday, maxActions } = taskQuota(task);
    const modeHint = task.decisionMode !== 'ai'
      ? (Array.isArray(task.keywords) && task.keywords.length ? `关键词：${task.keywords.join('、')}` : '规则模式：未设置关键词')
      : 'Agent 意向判断';
    const pendingHint = task.mode === 'manual' && taskPending === 0 ? '（暂无待确认回复）' : '';
    const recheckBusy = state.recheckPending.has(task.id);
    const quotaReached = maxActions > 0 && generationToday >= maxActions;
    const recheck = task.mode === 'manual' && task.decisionMode !== 'ai'
      ? `<button class="quiet" data-action="recheck-skipped" data-id="${escapeHtml(task.id)}" ${recheckBusy || quotaReached ? 'disabled' : ''}>${recheckBusy ? '筛选中…' : '重新筛选'}</button><small class="task-recheck-hint">${recheckBusy ? '正在处理此前本地跳过且未提交过的评论' : quotaReached ? '今日判定上限已用完，请编辑提高上限后再重新筛选' : '仅处理此前本地跳过且未提交过的评论；生成待确认后手动确认，消耗规则匹配结果积分'}</small>`
      : '';
    return `<small class="task-summary">近期记录 ${recent.length} 条 · 近期关键词未命中 ${noKeyword} 条 · 待确认 ${taskPending} 条${pendingHint}</small><small class="task-summary">${escapeHtml(modeHint)}</small>${recheck}`;
  };
  return `<div class="toolbar"><div><p class="eyebrow">运行面板</p><h2>任务与回复队列</h2></div><div class="toolbar-actions"><button class="quiet" data-action="import-demo">导入示例配置</button><button class="primary" data-action="new-task">新建任务</button></div></div><section class="state-strip"><span class="state-icon">i</span><span>采集来自专用 Chrome 的可见页面。自动模式需要当前触达渠道能力已验证；人工发送仍会逐条核对目标。发送结果需要平台响应确认，页面变化本身不会显示为成功。</span></section><section class="table-panel"><table class="task-table"><colgroup><col class="task-col"><col class="source-col"><col class="mode-col"><col class="status-col"><col class="quota-col"><col class="actions-col"></colgroup><thead><tr><th>任务</th><th>来源</th><th>模式</th><th>状态</th><th>今日额度</th><th>操作</th></tr></thead><tbody>${tasks.length ? tasks.map((task) => { const quota = taskQuota(task); return `<tr><td><strong class="task-title">${escapeHtml(task.businessContext || task.url)}</strong><small class="task-url">${escapeHtml(task.url)}</small>${taskSummary(task)}</td><td class="task-meta"><span>${task.source === 'live' ? '直播公屏' : '视频评论'}</span><span>${task.contactMode === 'private' ? '私信' : '评论回复'}</span></td><td class="task-meta">${task.mode === 'auto' ? '自动发送' : '人工确认'}</td><td><span class="status-chip ${escapeHtml(task.status)}">${statusText(task.status)}</span></td><td><small class="task-quota">今日判定 ${quota.generationToday} / ${quota.maxActions}</small><small class="task-quota">今日发送尝试 ${quota.sendAttemptsToday} / ${quota.dailyLimit}</small></td><td><div class="row-actions"><button class="quiet" data-action="open-browser" data-url="${escapeHtml(task.url)}">打开页面</button><button class="quiet" data-action="task-status" data-id="${escapeHtml(task.id)}" data-status="${task.status === 'running' ? 'paused' : 'running'}">${task.status === 'running' ? '暂停' : '启动'}</button><button class="quiet" data-action="edit-task" data-id="${escapeHtml(task.id)}">编辑</button></div></td></tr>`; }).join('') : `<tr><td colspan="6"><div class="empty-state"><h3>还没有任务</h3><p>先创建一个视频或直播任务，再在专用窗口手动登录抖音。</p><button class="primary" data-action="new-task">创建首个任务</button></div></td></tr>`}</tbody></table></section>${pending.length ? `<section class="panel pending-panel"><div class="section-heading"><div><p class="eyebrow">待确认回复</p><h2>请确认发送目标</h2></div></div>${pending.map((item) => `<div class="pending-row"><div><strong>${escapeHtml(item.reply)}</strong><small>${escapeHtml(item.channel === 'private' ? '私信' : item.source === 'live' ? '直播公屏' : '视频评论')} · 生成结果已由授权中心返回</small><small>目标：${escapeHtml((events.find((event) => event.eventKey === item.eventKey)?.authorName) || '未知用户')} · 原评论：${escapeHtml((events.find((event) => event.eventKey === item.eventKey)?.text) || '原文不可用')}</small><small>页面：${escapeHtml((events.find((event) => event.eventKey === item.eventKey)?.roomId) || '未知页面')}</small></div><button class="primary" data-action="confirm" data-id="${escapeHtml(item.actionId)}">确认发送</button></div>`).join('')}</section>` : ''}`;
}

function renderLeads() { const leads = state.data?.leads || []; return `<div class="toolbar"><div><p class="eyebrow">意向沉淀</p><h2>线索</h2></div></div><section class="table-panel"><table><thead><tr><th>用户</th><th>意图</th><th>置信度</th><th>判断依据</th><th>原评论</th></tr></thead><tbody>${leads.length ? leads.map((lead) => `<tr><td>${escapeHtml(lead.authorName)}</td><td>${escapeHtml(lead.intent)}</td><td>${lead.confidence == null ? '--' : `${Math.round(Number(lead.confidence) * 100)}%`}</td><td>${escapeHtml(lead.reason || '授权中心未提供')}</td><td class="wrap">${escapeHtml(lead.text)}</td></tr>`).join('') : `<tr><td colspan="5"><div class="empty-state"><h3>还没有线索</h3><p>匹配到意向客户后会在这里沉淀。</p></div></td></tr>`}</tbody></table></section>`; }
function renderLogs() { const logs = state.data?.logs || []; const events = state.data?.events || []; const recoverable = events.filter((event) => ['evaluation_unknown', 'failed'].includes(event.status)); const labels = { event_observed: '观察到评论', event_judged: '完成意向判断', reply_drafted: '生成回复', send_started: '已提交发送', reply_attempted: '发送待核实', event_skipped: '跳过评论', draft_failed: '生成未完成', draft_recovery_failed: '恢复生成失败' }; return `<div class="toolbar"><div><p class="eyebrow">可追溯记录</p><h2>回复记录</h2></div></div>${recoverable.length ? `<section class="panel pending-panel"><div class="section-heading"><div><p class="eyebrow">可恢复生成</p><h2>网络中断的生成请求</h2><p class="muted">使用原幂等键恢复授权中心结果，不会自动发送。</p></div></div>${recoverable.map((event) => `<div class="pending-row"><div><strong>${escapeHtml(event.text || '原评论')}</strong><small>${escapeHtml(reasonText(event.reason) || '生成结果未确认')}</small></div><button class="quiet" data-action="retry-draft" data-event-key="${escapeHtml(event.eventKey)}">恢复生成</button></div>`).join('')}</section>` : ''}<section class="table-panel"><table><thead><tr><th>时间</th><th>动作</th><th>说明</th></tr></thead><tbody>${logs.length ? logs.map((log) => { const detail = log.detail || {}; const rawReason = detail.reason || detail.code || ''; const description = rawReason ? reasonText(rawReason) : (log.type === 'reply_attempted' ? '平台结果待核实' : '已记录'); return `<tr><td>${escapeHtml(new Date(log.at).toLocaleString())}</td><td>${escapeHtml(labels[log.type] || taskLogLabel(log.type) || '任务状态')}</td><td class="wrap">${escapeHtml(description)}</td></tr>`; }).join('') : `<tr><td colspan="3"><div class="empty-state"><h3>暂无记录</h3><p>任务开始后，采集、判断、生成和发送状态会按顺序留下记录。</p></div></td></tr>`}</tbody></table></section>`; }
function renderCredits() { const ledger = state.ledger || []; const prices = state.data?.license?.features?.prices || {}; return `<div class="toolbar"><div><p class="eyebrow">服务端台账</p><h2>积分</h2></div><button class="quiet" data-action="load-ledger">刷新台账</button></div><section class="credit-grid"><div class="metric"><small>当前余额</small><strong>${state.data?.license?.balance ?? '--'}</strong><span>由授权中心实时返回</span></div><div class="metric"><small>规则模板</small><strong>${prices.evaluateReplyPrice ?? '--'} 积分</strong><span>未命中不扣费</span></div><div class="metric"><small>Agent 意向判断</small><strong>${prices.draftPrice ?? '--'} 积分</strong><span>${state.data?.license?.features?.draft ? '按服务端生成结果计费' : '未配置，当前不可选'}</span></div></section><section class="redeem panel"><form id="redeem-form"><label>兑换码<input name="code" required placeholder="输入授权中心提供的兑换码"></label><button class="primary">兑换积分</button></form></section><section class="table-panel"><table><thead><tr><th>时间</th><th>类型</th><th>变化</th><th>余额</th></tr></thead><tbody>${ledger.length ? ledger.map((row) => `<tr><td>${escapeHtml(formatDate(row.createdAt))}</td><td>${escapeHtml(creditKind(row.kind))}</td><td>${escapeHtml(row.delta ?? '')}</td><td>${escapeHtml(row.balanceAfter ?? '')}</td></tr>`).join('') : `<tr><td colspan="4"><div class="empty-state"><h3>暂时没有台账</h3><p>登录后可从授权中心读取积分明细。</p></div></td></tr>`}</tbody></table></section>`; }
function renderSettings() { const p = state.data?.selectorProfile || {}; return `<div class="toolbar"><div><p class="eyebrow">连接与校准</p><h2>设置</h2></div></div><section class="panel form-panel"><form id="endpoint-form" class="inline-form"><label>授权中心地址<input name="endpoint" type="url" value="${escapeHtml(state.endpoint)}" required></label><button class="primary">保存地址并重新登录</button></form><p class="helper">生产环境必须 HTTPS。修改地址会清除原地址绑定的登录会话。</p></section><section class="panel form-panel"><div class="section-heading"><div><p class="eyebrow">侧车检索</p><h2>按关键词找目标视频</h2><p class="muted">搜索只返回候选，不会自动创建任务或发送；请把确认过的 URL 作为任务目标。</p></div></div><form id="search-form" class="inline-form"><label>关键词<input name="keyword" maxlength="200" required placeholder="例如：我的世界暴雨末日"></label><label>最多结果<input name="maxVideos" type="number" min="1" max="100" value="20"></label><button class="quiet">搜索候选</button></form><div id="search-results" class="helper"></div></section><section class="panel form-panel"><div class="section-heading"><div><p class="eyebrow">选择器校准</p><h2>先打开目标页面，再探测可见节点</h2><p class="muted">可载入一组未验证候选，探测当前页面的可见匹配数和样例。保存前必须由你确认当前目标和回复控件。</p></div><div class="toolbar-actions"><button class="quiet" data-action="load-candidate">载入候选</button><button class="quiet" data-action="probe">探测当前页面</button></div></div><details><summary>高级适配配置</summary><form id="selector-form" class="form-grid"><label>评论节点 CSS<input name="commentNode" value="${escapeHtml(p.commentNode || '')}" placeholder="候选或自定义 CSS"></label><label>评论文本 CSS<input name="commentText" value="${escapeHtml(p.commentText || '')}"></label><label>作者 CSS<input name="commentAuthor" value="${escapeHtml(p.commentAuthor || '')}"></label><label>评论 ID CSS<input name="commentId" value="${escapeHtml(p.commentId || '')}"></label><label>回复输入框 CSS<input name="replyInput" value="${escapeHtml(p.replyInput || '')}"></label><label>发送按钮 CSS<input name="sendButton" value="${escapeHtml(p.sendButton || '')}"></label><label>视频评论回复按钮 CSS<input name="replyButton" value="${escapeHtml(p.replyButton || '')}"></label><div class="form-foot span-2"><button class="primary" type="submit">保存校准结果</button><span id="probe-result" class="helper">${p.verified ? `已记录 ${escapeHtml(p.verifiedAt)}` : '未校准'}</span></div></form></details></section>`; }

function render() {
  renderHeader();
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === state.view));
  const licensed = state.data?.license?.state === 'authorized';
  const sameAccount = state.taskEditor?.license == null || state.taskEditor.license === licenseIdentity(state.data?.license);
  if (state.taskEditor && licensed && sameAccount) return;
  if (state.taskEditor && (!licensed || !sameAccount)) {
    state.taskEditor = null;
    state.draftUrl = '';
  }
  $('#content').innerHTML = (!licensed && state.view !== 'settings') ? renderLogin() : state.view === 'tasks' ? renderTasks() : state.view === 'leads' ? renderLeads() : state.view === 'logs' ? renderLogs() : state.view === 'credits' ? renderCredits() : renderSettings();
  bind();
}

function formDataToTask(form) { const data = new FormData(form); const value = Object.fromEntries(data.entries()); return { ...value, keywords: value.keywords.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean), excludeKeywords: value.excludeKeywords.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean), intervalMs: Number(value.intervalMs), dailyLimit: Number(value.dailyLimit), maxActions: Number(value.maxActions) }; }
function profileFromForm(form) { return Object.fromEntries(new FormData(form).entries()); }
function bind() {
  $('#nav').onclick = (event) => { const button = event.target.closest('[data-view]'); if (!button) return; state.taskEditor = null; state.draftUrl = ''; state.view = button.dataset.view; document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item === button)); render(); };
  $('#refresh').onclick = () => call(window.agentApi.refreshLicense);
  $('#content').onclick = async (event) => { const button = event.target.closest('[data-action]'); if (!button) return; const action = button.dataset.action; if (action === 'new-task') { state.draftUrl = ''; openTaskEditor(); return; } if (action === 'cancel-task') { state.taskEditor = null; state.view = 'tasks'; state.draftUrl = ''; render(); return; } if (action === 'edit-task') { const task = state.data.tasks.find((item) => item.id === button.dataset.id); openTaskEditor(task); return; } if (action === 'import-demo') { await call(window.agentApi.saveTask, { url: 'https://www.douyin.com/video/example', source: 'video', businessContext: '演示配置，不含真实数据', targetCustomer: '待配置', keywords: ['价格'], excludeKeywords: ['投诉'], replyTemplate: '这是演示模板，请先完成配置。', replyInstructions: '演示配置，不会自动发送', mode: 'manual', decisionMode: 'rule', intervalMs: 30000, dailyLimit: 20, maxActions: 20, status: 'stopped' }); notify('示例配置已导入，未创建演示评论或发送记录'); return; } if (action === 'search-open') { await call(window.agentApi.openTarget, button.dataset.url); notify('目标页面已打开；登录后点击启动任务'); return; } if (action === 'search-use') { state.draftUrl = button.dataset.url; state.view = 'tasks'; openTaskEditor({ url: button.dataset.url, source: 'video' }); return; } if (action === 'open-browser') { await call(window.agentApi.openTarget, button.dataset.url); notify('目标页面已打开；登录后点击启动任务'); return; } if (action === 'task-status') { await call(window.agentApi.setTaskStatus, { id: button.dataset.id, status: button.dataset.status }); return; } if (action === 'recheck-skipped') { const taskId = button.dataset.id; if (state.recheckPending.has(taskId)) return; const account = licenseIdentity(state.data?.license); state.recheckPending.add(taskId); button.disabled = true; render(); try { const result = await window.agentApi.recheckSkipped(taskId); await refresh(); if (licenseIdentity(state.data?.license) === account) notify(recheckResultText(result)); } catch (error) { if (licenseIdentity(state.data?.license) === account) { console.error('[desktop-ui]', error); notify(clientError(error), 'error'); } } finally { state.recheckPending.delete(taskId); render(); } return; } if (action === 'confirm') { await call(window.agentApi.confirmAction, button.dataset.id); return; } if (action === 'retry-draft') { await call(window.agentApi.retryDraft, button.dataset.eventKey); return; } if (action === 'load-ledger') { const response = await window.agentApi.getLedger(); state.ledger = Array.isArray(response) ? response : (response.entries || response.items || []); render(); return; } if (action === 'load-candidate') { const form = $('#selector-form'); for (const [key, value] of Object.entries(UNVERIFIED_CANDIDATE)) form.elements[key].value = value; notify('已载入未验证候选，请先探测并确认样例'); return; } if (action === 'probe') { const form = $('#selector-form'); const result = await call(window.agentApi.probeSelectors, profileFromForm(form)); if (result.transport === 'sidecar') { const entries = Object.entries(result.capability || {}).map(([key, item]) => `${key}：${item.implemented ? '已实现' : '未实现'}；自动资格 ${item.autoEligible === true ? '允许' : '未开放'}；验证来源 ${item.validation?.status || item.evidence || '未提供'}`); $('#probe-result').textContent = `外部专用 Chrome 运行组件：${result.verified ? '已实现' : '未声明'}；${entries.join(' ｜ ') || result.diagnostics || '无能力明细'}。页面送达仍须运行时平台响应确认。`; } else $('#probe-result').textContent = `当前可见匹配 评论 ${result.commentNode || 0}，输入框 ${result.replyInput || 0}，发送按钮 ${result.sendButton || 0}，样例 ${result.sample?.join(' / ') || '无'}`; return; } };
  const login = $('#login-form'); if (login) login.onsubmit = async (event) => { event.preventDefault(); const value = Object.fromEntries(new FormData(login).entries()); await call(window.agentApi.login, value); notify('登录成功'); };
  const task = $('#task-form');
  if (task) task.onsubmit = async (event) => {
    event.preventDefault();
    const editor = state.taskEditor;
    if (!editor || editor.submitting) return;
    const submit = task.querySelector('button[type="submit"]');
    editor.submitting = true;
    if (submit) submit.disabled = true;
    try {
      await call(window.agentApi.saveTask, formDataToTask(task));
      if (state.taskEditor === editor) {
        state.taskEditor = null;
        state.draftUrl = '';
        render();
        notify('任务已保存');
      }
    } catch (_error) {
      // call() already reports the user-facing error; keep the draft in place.
    } finally {
      editor.submitting = false;
      if (state.taskEditor === editor && submit) submit.disabled = false;
    }
  };
  const redeem = $('#redeem-form'); if (redeem) redeem.onsubmit = async (event) => { event.preventDefault(); await call(window.agentApi.redeem, new FormData(redeem).get('code')); notify('兑换结果已更新'); };
  const endpoint = $('#endpoint-form'); if (endpoint) endpoint.onsubmit = async (event) => { event.preventDefault(); await call(window.agentApi.setEndpoint, new FormData(endpoint).get('endpoint')); notify('地址已保存，请重新登录'); };
  const search = $('#search-form'); if (search) search.onsubmit = async (event) => { event.preventDefault(); const value = Object.fromEntries(new FormData(search).entries()); const result = await call(window.agentApi.searchTargets, { keyword: value.keyword, maxVideos: Number(value.maxVideos), scrollRounds: 2 }); $('#search-results').innerHTML = result.videos?.length ? result.videos.map((video) => `<p><strong>${escapeHtml(video.title || video.url)}</strong> <button class="quiet" data-action="search-open" data-url="${escapeHtml(video.url)}">在专用 Chrome 打开</button> <button class="quiet" data-action="search-use" data-url="${escapeHtml(video.url)}">带入新任务</button></p>`).join('') : '没有候选结果'; };
  const selectors = $('#selector-form'); if (selectors) selectors.onsubmit = async (event) => { event.preventDefault(); await call(window.agentApi.saveSelectors, profileFromForm(selectors)); notify('选择器已校准并保存'); };
}

window.agentApi.onState((next) => {
  const previousLicense = state.data?.license;
  state.data = next;
  const licensed = next?.license?.state === 'authorized';
  const licenseChanged = Boolean(previousLicense) && (previousLicense.state !== next?.license?.state || licenseIdentity(previousLicense) !== licenseIdentity(next?.license));
  const sameAccount = state.taskEditor?.license == null || state.taskEditor.license === licenseIdentity(next?.license);
  if (licenseChanged || (state.taskEditor && (!licensed || !sameAccount))) {
    render();
    return;
  }
  if (state.taskEditor && licensed && sameAccount) {
    renderHeader();
    return;
  }
  if (state.taskEditor) {
    render();
    return;
  }
  const editing = $('#content')?.querySelector('input:focus, textarea:focus, select:focus');
  if (editing) renderHeader();
  else render();
});
refresh().catch((error) => { console.error('[desktop-ui] initial state', error); notify(clientError(error), 'error'); });
