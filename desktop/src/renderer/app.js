'use strict';

const state = { view: 'tasks', data: null, ledger: [], endpoint: '', draftUrl: '', taskEditor: null, recheckPending: new Set(), search: { keyword: '', maxVideos: 20, minRelevance: 0, cursor: '', result: null, loading: false }, knowledge: { sets: [], documents: [], selectedSetId: '', results: [], loading: false, error: '', loadedFor: '' }, workflowSubmitting: new Set() };
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
  $('#page-title').textContent = ({ agent: 'Agent', tasks: '任务 / 恢复', search: '找视频', comments: '评论区', live: '直播间', knowledge: '话术库', leads: '线索', logs: '回复记录', credits: '积分', settings: '设置' }[state.view] || '任务 / 恢复');
}

function renderAgent() {
  const messages = Array.isArray(state.data?.chat) ? state.data.chat : [];
  const accountRuns = Array.isArray(state.data?.workflowAccounts) ? state.data.workflowAccounts : [];
  const runs = accountRuns.length ? accountRuns.map((item) => ({ ...(item.run || {}), platformAccountId: item.platformAccountId })) : (state.data?.workflow?.runs || []);
  const sets = Array.isArray(state.knowledge?.sets) ? state.knowledge.sets : [];
  const knowledgeOptions = sets.length ? `<option value="">不绑定话术库</option>${sets.map((set) => `<option value="${escapeHtml(set.id)}" ${set.id === state.knowledge.selectedSetId ? 'selected' : ''}>${escapeHtml(set.name)}（v${escapeHtml(set.version)}）</option>`).join('')}` : '<option value="">暂无话术库（可在话术库页创建）</option>';
  return `<div class="toolbar"><div><p class="eyebrow">固定流程入口</p><h2>Agent 对话</h2><p class="muted">Agent 只负责理解意图并选择已注册流程；流程开始后不会重新调用模型或改变步骤。</p></div></div><section class="panel chat-panel"><div class="chat-history">${messages.length ? messages.map((item) => `<div class="chat-bubble ${item.role === 'user' ? 'user' : 'assistant'}"><small>${item.role === 'user' ? '你' : 'Agent'} · ${escapeHtml(formatDate(item.at))}</small><p>${escapeHtml(item.content)}</p></div>`).join('') : '<div class="empty-state"><h3>还没有对话</h3><p>例如：帮我按固定流程处理一批待确认线索。</p></div>'}</div><form id="agent-chat-form" class="chat-composer"><label class="sr-only" for="agent-message">告诉 Agent 你要做什么</label><textarea id="agent-message" name="message" maxlength="4000" required placeholder="告诉 Agent 你要做什么"></textarea><label class="chat-knowledge">话术库<select name="knowledgeSetId" ${sets.length ? '' : 'disabled'}>${knowledgeOptions}</select></label><button class="primary" type="submit">分析并进入固定流程</button></form></section><section class="table-panel"><table><thead><tr><th>流程实例</th><th>状态</th><th>当前步骤</th><th>异常/人工原因</th><th>操作</th></tr></thead><tbody>${runs.length ? runs.map((run) => { const reason = run.humanWait?.reason || run.lastError?.reason || run.lastError?.message || run.failure?.message || ''; const recovery = ['WAITING_HUMAN', 'UNKNOWN', 'PAUSED'].includes(run.status) ? `<button class="quiet" data-action="resume-workflow" data-id="${escapeHtml(run.runId)}" data-platform-account-id="${escapeHtml(run.platformAccountId || '')}">人工检查后继续</button>` : ''; const manual = ['WAITING_HUMAN', 'UNKNOWN', 'PAUSED'].includes(run.status) && (run.lastError?.code === 'SEND_EVIDENCE_REQUIRED' || run.checkpoint?.reason === 'server_send_evidence_required' || run.checkpoint?.phase === 'send') ? `<button class="quiet" data-action="manual-complete-workflow" data-id="${escapeHtml(run.runId)}" data-platform-account-id="${escapeHtml(run.platformAccountId || '')}">人工确认已处理</button>` : ''; return `<tr><td>${escapeHtml(run.platformAccountId ? `[${run.platformAccountId}] ` : '')}${escapeHtml(`${run.workflowId}@${run.version}`)}</td><td><span class="status-chip">${escapeHtml(run.status)}</span></td><td>${escapeHtml(run.currentStep ?? '--')}</td><td>${escapeHtml(reason || '—')}</td><td>${recovery}${manual}</td></tr>`; }).join('') : '<tr><td colspan="5"><div class="empty-state"><p>暂无流程实例</p></div></td></tr>'}</tbody></table></section>`;
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
function renderCredits() { const ledger = state.ledger || []; const prices = state.data?.license?.features?.prices || {}; const workflowPrices = prices.workflows || {}; return `<div class="toolbar"><div><p class="eyebrow">服务端台账</p><h2>积分</h2></div><button class="quiet" data-action="load-ledger">刷新台账</button></div><section class="credit-grid"><div class="metric"><small>当前余额</small><strong>${state.data?.license?.balance ?? '--'}</strong><span>由授权中心实时返回</span></div><div class="metric"><small>规则模板</small><strong>${prices.evaluateReplyPrice ?? '--'} 积分</strong><span>未命中不扣费</span></div><div class="metric"><small>Agent 意向判断</small><strong>${prices.draftPrice ?? '--'} 积分</strong><span>${state.data?.license?.features?.draft ? '按服务端生成结果计费' : '未配置，当前不可选'}</span></div><div class="metric"><small>固定流程</small><strong>视频 ${workflowPrices['video.search'] ?? '--'} · 评论 ${workflowPrices['comment.batch'] ?? '--'} · 直播 ${workflowPrices['live.batch'] ?? '--'}</strong><span>预留、结算和释放均由授权中心决定</span></div></section><section class="redeem panel"><form id="redeem-form"><label>兑换码<input name="code" required placeholder="输入授权中心提供的兑换码"></label><button class="primary">兑换积分</button></form></section><section class="table-panel"><table><thead><tr><th>时间</th><th>类型</th><th>变化</th><th>余额</th></tr></thead><tbody>${ledger.length ? ledger.map((row) => `<tr><td>${escapeHtml(formatDate(row.createdAt))}</td><td>${escapeHtml(creditKind(row.kind))}</td><td>${escapeHtml(row.delta ?? '')}</td><td>${escapeHtml(row.balanceAfter ?? '')}</td></tr>`).join('') : `<tr><td colspan="4"><div class="empty-state"><h3>暂时没有台账</h3><p>登录后可从授权中心读取积分明细。</p></div></td></tr>`}</tbody></table></section>`; }
function renderSearchResults(result = state.search.result) {
  if (!result) return '';
  const videos = Array.isArray(result.videos) ? result.videos : [];
  const status = String(result.status || 'unknown');
  const cursor = result.cursor || result.platformCursor || '';
  const summary = `状态：${escapeHtml(status)} · 本页 ${videos.length} 条 · 相关度阈值 ${escapeHtml(state.search.minRelevance)} · ${result.hasMore === true ? '还有下一页' : '没有更多页'}`;
  const rows = videos.map((video) => `<p><strong>${escapeHtml(video.title || video.desc || video.url)}</strong>${video.relevance?.score != null || video.relevanceScore != null ? ` <small>相关度 ${escapeHtml(video.relevance?.score ?? video.relevanceScore)}</small>` : ''} <button class="quiet" data-action="search-open" data-url="${escapeHtml(video.url)}">在专用 Chrome 打开</button> <button class="quiet" data-action="search-use" data-url="${escapeHtml(video.url)}">带入评论区任务</button></p>`).join('');
  const next = result.hasMore === true && cursor ? `<button class="quiet" data-action="search-next" ${state.search.loading ? 'disabled' : ''}>${state.search.loading ? '读取中…' : '读取下一页'}</button>` : '';
  return `<div class="search-summary">${summary}</div>${rows || '<p>没有候选结果</p>'}${next}`;
}
function platformAccountOptions() { const accounts = state.data?.platformAccounts || []; const selected = state.data?.platformAccountId || ''; return accounts.length ? accounts.map((account) => `<option value="${escapeHtml(account.id)}" ${account.id === selected ? 'selected' : ''}>${escapeHtml(account.displayName || account.accountRef || account.id)}</option>`).join('') : '<option value="">暂无平台账号</option>'; }
function workflowForm(kind) { const live = kind === 'live'; const sets = Array.isArray(state.knowledge?.sets) ? state.knowledge.sets : []; const knowledgeOptions = sets.length ? `<option value="">使用手动模板</option>${sets.map((set) => `<option value="${escapeHtml(set.id)}" ${set.id === state.knowledge.selectedSetId ? 'selected' : ''}>${escapeHtml(set.name)}（v${escapeHtml(set.version)}）</option>`).join('')}` : '<option value="">暂无话术库</option>'; return `<section class="panel form-panel workflow-panel"><div class="section-heading"><div><p class="eyebrow">固定流程入口</p><h2>${live ? '直播间批量互动' : '评论区批量触达'}</h2><p class="muted">启动前由授权中心签发计划；未验证发送能力会暂停并要求人工检查。</p></div></div><form id="${kind}-workflow-form" class="form-grid"><label class="span-2">目标 URL<input name="url" type="url" required placeholder="https://www.douyin.com/..."></label><label>关键词<input name="keywords" required placeholder="价格，怎么买"></label><label>排除词<input name="excludeKeywords" placeholder="投诉，退款"></label><label>话术库<select name="knowledgeSetId">${knowledgeOptions}</select></label><label class="span-2">公开回复模板<textarea name="publicReply" required placeholder="您好，欢迎咨询……"></textarea></label><label class="span-2">私信模板<textarea name="privateReply" required placeholder="您好，我把详细信息发给您……"></textarea></label>${live ? '<label>监听窗口（秒）<input name="windowSeconds" type="number" min="1" max="3600" value="300" required></label>' : '<label>评论读取上限<input name="maxComments" type="number" min="1" max="1000" value="50" required></label>'}<label>发送上限<input name="maxSends" type="number" min="1" max="100" value="10" required></label><label>抖音账号<select name="platformAccountId">${platformAccountOptions()}</select></label><div class="form-foot span-2"><span class="helper">选择话术库后，授权中心会在流程边界检索并冻结公屏/私信话术；缺少证据时转人工。</span><button class="primary" type="submit">启动固定流程</button></div></form></section>`; }
function renderComments() { return `<div class="toolbar"><div><p class="eyebrow">公开评论与私信</p><h2>评论区</h2></div></div>${workflowForm('comments')}`; }
function renderLive() { return `<div class="toolbar"><div><p class="eyebrow">直播公屏与私信</p><h2>直播间</h2></div></div>${workflowForm('live')}`; }
function renderSearchPage() { const search = state.search || {}; return `<div class="toolbar"><div><p class="eyebrow">侧车检索</p><h2>找视频</h2><p class="muted">只返回候选视频，不会自动创建任务或发送。</p></div></div><section class="panel form-panel"><form id="search-form" class="inline-form"><label>关键词<input name="keyword" maxlength="200" required placeholder="例如：我的世界暴雨末日" value="${escapeHtml(search.keyword || '')}"></label><label>最多结果<input name="maxVideos" type="number" min="1" max="100" value="${escapeHtml(search.maxVideos || 20)}"></label><label>最低相关度<input name="minRelevance" type="number" min="0" max="100" value="${escapeHtml(search.minRelevance || 0)}"></label><button class="primary">搜索候选</button></form><div id="search-results" class="helper">${renderSearchResults()}</div></section>`; }
function renderKnowledge() { const k = state.knowledge; const sets = Array.isArray(k.sets) ? k.sets : []; const docs = Array.isArray(k.documents) ? k.documents : []; return `<div class="toolbar"><div><p class="eyebrow">固定话术与资料</p><h2>话术库</h2><p class="muted">知识集和文档只用于检索预览；发送前仍需人工确认。</p></div><button class="quiet" data-action="knowledge-refresh">刷新</button></div><section class="panel form-panel"><div class="section-heading"><h3>知识集</h3><span class="helper">${escapeHtml(k.error || '')}</span></div><form id="knowledge-set-form" class="inline-form"><label>名称<input name="name" maxlength="100" required placeholder="例如：婚礼摄影话术"></label><label>描述<input name="description" maxlength="1000" placeholder="适用产品和边界"></label><button class="primary">新建知识集</button></form><label class="knowledge-select">当前知识集<select id="knowledge-set-select" name="knowledgeSetId" ${sets.length ? '' : 'disabled'}>${sets.length ? sets.map((set) => `<option value="${escapeHtml(set.id)}" ${set.id === k.selectedSetId ? 'selected' : ''}>${escapeHtml(set.name)}（v${escapeHtml(set.version)}）</option>`).join('') : '<option>暂无知识集</option>'}</select></label></section><section class="panel form-panel"><h3>添加文档</h3><form id="knowledge-document-form" class="form-grid"><label>标题<input name="title" maxlength="300" required></label><label>元数据 JSON<input name="metadata" placeholder="{}"></label><label class="span-2">内容<textarea name="content" maxlength="200000" required placeholder="粘贴经过确认的产品资料或话术"></textarea></label><div class="form-foot span-2"><span class="helper">文档会按服务端规则分块，原文不会写入本地日志。</span><button class="primary" type="submit" ${k.selectedSetId ? '' : 'disabled'}>添加文档</button></div></form>${docs.length ? `<div class="knowledge-docs">${docs.map((doc) => `<p><strong>${escapeHtml(doc.title)}</strong><small>v${escapeHtml(doc.version)} · ${escapeHtml(doc.chunkCount || '')} 块</small></p>`).join('')}</div>` : '<p class="helper">当前知识集还没有文档。</p>'}</section><section class="panel form-panel"><h3>检索预览</h3><form id="knowledge-retrieve-form" class="inline-form"><label>问题<input name="query" required placeholder="用户问：套餐怎么收费？"></label><label>返回条数<input name="topK" type="number" min="1" max="20" value="5"></label><button class="quiet" type="submit" ${k.selectedSetId ? '' : 'disabled'}>检索</button></form><div class="knowledge-results">${k.results.length ? k.results.map((row) => `<article><strong>${escapeHtml(row.title)}</strong><p>${escapeHtml(row.text)}</p><small>相关度 ${escapeHtml(Number(row.score || 0).toFixed(3))}</small></article>`).join('') : '<p class="helper">输入问题查看匹配片段。</p>'}</div></section>`; }

// Settings intentionally contains connection and adapter controls; video search lives in its own page.
function renderSettings() { const p = state.data?.selectorProfile || {}; return `<div class="toolbar"><div><p class="eyebrow">连接与校准</p><h2>设置</h2></div></div><section class="panel form-panel"><form id="endpoint-form" class="inline-form"><label>授权中心地址<input name="endpoint" type="url" value="${escapeHtml(state.endpoint)}" required></label><button class="primary">保存地址并重新登录</button></form><p class="helper">生产环境必须 HTTPS。修改地址会清除原地址绑定的登录会话。</p></section><section class="panel form-panel"><div class="section-heading"><div><p class="eyebrow">选择器校准</p><h2>先打开目标页面，再探测可见节点</h2><p class="muted">可载入一组未验证候选，探测当前页面的可见匹配数和样例。</p></div><div class="toolbar-actions"><button class="quiet" data-action="load-candidate">载入候选</button><button class="quiet" data-action="probe">探测当前页面</button></div></div><details><summary>高级适配配置</summary><form id="selector-form" class="form-grid"><label>评论节点 CSS<input name="commentNode" value="${escapeHtml(p.commentNode || '')}"></label><label>评论文本 CSS<input name="commentText" value="${escapeHtml(p.commentText || '')}"></label><label>作者 CSS<input name="commentAuthor" value="${escapeHtml(p.commentAuthor || '')}"></label><label>评论 ID CSS<input name="commentId" value="${escapeHtml(p.commentId || '')}"></label><label>回复输入框 CSS<input name="replyInput" value="${escapeHtml(p.replyInput || '')}"></label><label>发送按钮 CSS<input name="sendButton" value="${escapeHtml(p.sendButton || '')}"></label><label>视频评论回复按钮 CSS<input name="replyButton" value="${escapeHtml(p.replyButton || '')}"></label><div class="form-foot span-2"><button class="primary" type="submit">保存校准结果</button><span id="probe-result" class="helper">${p.verified ? `已记录 ${escapeHtml(p.verifiedAt)}` : '未校准'}</span></div></form></details></section><section hidden aria-hidden="true"><form id="search-form"><input name="keyword"><input name="maxVideos" value="20"><input name="minRelevance" value="0"><button>搜索候选</button></form><div id="search-results">${renderSearchResults()}</div></section>`; }

function injectPlatformAccountPanel() {
  if (state.view !== 'settings' || document.querySelector('#platform-account-panel')) return;
  const endpointPanel = document.querySelector('#endpoint-form')?.closest('.panel');
  if (!endpointPanel) return;
  const accounts = state.data?.platformAccounts || [];
  const selected = state.data?.platformAccountId || '';
  const panel = document.createElement('section');
  panel.id = 'platform-account-panel';
  panel.className = 'panel form-panel';
  panel.innerHTML = `<div class="section-heading"><div><p class="eyebrow">抖音账号隔离</p><h2>平台账号</h2><p class="muted">每个平台账号使用独立的任务数据、浏览器会话和 sidecar 端口。</p></div><button class="quiet" type="button" data-platform-action="refresh">刷新</button></div><form id="platform-account-select-form" class="inline-form"><label>当前账号<select name="platformAccountId" ${accounts.length ? '' : 'disabled'}>${accounts.length ? accounts.map((account) => `<option value="${escapeHtml(account.id)}" ${account.id === selected ? 'selected' : ''}>${escapeHtml(account.displayName || account.accountRef || account.id)}</option>`).join('') : '<option>暂无平台账号</option>'}</select></label><button class="primary" type="submit" ${accounts.length ? '' : 'disabled'}>切换账号</button></form><form id="platform-account-create-form" class="inline-form"><label>账号标识<input name="accountRef" maxlength="200" required placeholder="抖音号或商家账号标识"></label><label>显示名称<input name="displayName" maxlength="200" placeholder="例如：主账号"></label><button class="quiet" type="submit">新增账号</button></form>`;
  endpointPanel.parentElement.insertBefore(panel, endpointPanel);
  panel.querySelector('[data-platform-action="refresh"]').onclick = async () => { await call(window.agentApi.listPlatformAccounts); };
  panel.querySelector('#platform-account-select-form').onsubmit = async (event) => { event.preventDefault(); const value = new FormData(event.currentTarget).get('platformAccountId'); if (value) await call(window.agentApi.selectPlatformAccount, value); };
  panel.querySelector('#platform-account-create-form').onsubmit = async (event) => { event.preventDefault(); const value = Object.fromEntries(new FormData(event.currentTarget).entries()); await call(window.agentApi.createPlatformAccount, { platform: 'douyin', accountRef: value.accountRef, displayName: value.displayName }); };
}

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
  $('#content').innerHTML = (!licensed && state.view !== 'settings') ? renderLogin() : state.view === 'agent' ? renderAgent() : state.view === 'tasks' ? renderTasks() : state.view === 'search' ? renderSearchPage() : state.view === 'comments' ? renderComments() : state.view === 'live' ? renderLive() : state.view === 'knowledge' ? renderKnowledge() : state.view === 'leads' ? renderLeads() : state.view === 'logs' ? renderLogs() : state.view === 'credits' ? renderCredits() : renderSettings();
  bind();
  injectPlatformAccountPanel();
}

function formDataToTask(form) { const data = new FormData(form); const value = Object.fromEntries(data.entries()); return { ...value, keywords: value.keywords.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean), excludeKeywords: value.excludeKeywords.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean), intervalMs: Number(value.intervalMs), dailyLimit: Number(value.dailyLimit), maxActions: Number(value.maxActions) }; }
function profileFromForm(form) { return Object.fromEntries(new FormData(form).entries()); }
async function runSearch({ reset = false } = {}) {
  const form = $('#search-form');
  if (!form || state.search.loading) return;
  const value = Object.fromEntries(new FormData(form).entries());
  const keyword = String(value.keyword || '').trim();
  const maxVideos = Math.max(1, Math.min(100, Number(value.maxVideos) || 20));
  const minRelevance = Math.max(0, Math.min(100, Number(value.minRelevance) || 0));
  if (!keyword) return;
  if (reset) state.search = { ...state.search, cursor: '', result: null };
  state.search = { ...state.search, keyword, maxVideos, minRelevance, loading: true };
  const output = $('#search-results');
  if (output) output.innerHTML = '正在读取候选…';
  try {
    const result = await call(window.agentApi.searchTargets, { keyword, maxVideos, minRelevance, scrollRounds: 2, cursor: state.search.cursor || undefined });
    state.search = { ...state.search, result: result || null, cursor: result?.cursor || result?.platformCursor || '', loading: false };
    if ($('#search-results')) $('#search-results').innerHTML = renderSearchResults(result || {});
  } catch (error) {
    state.search.loading = false;
    if ($('#search-results')) $('#search-results').innerHTML = `<p>搜索未完成：${escapeHtml(clientError(error))}</p>`;
  }
}
async function loadKnowledge({ force = false } = {}) {
  const identity = licenseIdentity(state.data?.license) || '';
  if (!identity || (!force && state.knowledge.loadedFor === identity) || state.knowledge.loading) return;
  state.knowledge.loading = true;
  try {
    const response = await window.agentApi.knowledgeListSets();
    const sets = Array.isArray(response) ? response : (response.knowledgeSets || response.sets || []);
    state.knowledge.sets = sets;
    if (!sets.some((set) => set.id === state.knowledge.selectedSetId)) state.knowledge.selectedSetId = sets[0]?.id || '';
    if (state.knowledge.selectedSetId) {
      const docsResponse = await window.agentApi.knowledgeListDocuments(state.knowledge.selectedSetId);
      state.knowledge.documents = Array.isArray(docsResponse) ? docsResponse : (docsResponse.documents || []);
    } else state.knowledge.documents = [];
    state.knowledge.error = '';
    state.knowledge.loadedFor = identity;
    if (state.view === 'knowledge' && !$('#content')?.querySelector('input:focus, textarea:focus, select:focus')) render();
  } catch (error) { state.knowledge.error = clientError(error); notify(state.knowledge.error, 'error'); }
  finally { state.knowledge.loading = false; }
}
function bindWorkflowForm(kind) {
  const form = $(`#${kind}-workflow-form`);
  if (!form) return;
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (state.workflowSubmitting.has(kind)) return;
    const value = Object.fromEntries(new FormData(form).entries());
    const params = { url: String(value.url || '').trim(), keywords: String(value.keywords || '').split(/[，,\n]/).map((item) => item.trim()).filter(Boolean), excludeKeywords: String(value.excludeKeywords || '').split(/[，,\n]/).map((item) => item.trim()).filter(Boolean), publicReply: String(value.publicReply || ''), privateReply: String(value.privateReply || ''), maxSends: Math.max(1, Number(value.maxSends) || 10) };
    if (kind === 'comments') params.maxComments = Math.max(1, Number(value.maxComments) || 50);
    else params.windowSeconds = Math.max(1, Number(value.windowSeconds) || 300);
    state.workflowSubmitting.add(kind);
    const submit = form.querySelector('button[type="submit"]'); if (submit) { submit.disabled = true; submit.textContent = '正在启动…'; }
    try {
      const workflowId = kind === 'comments' ? 'comment.batch' : 'live.batch';
      let replyPlan = null;
      if (value.knowledgeSetId) {
        replyPlan = await call(window.agentApi.prepareReplyPlan, { workflowId, version: '1', params, knowledgeSetId: value.knowledgeSetId, query: params.keywords.join('、'), targets: [] });
        if (replyPlan?.status === 'WAITING_HUMAN' || replyPlan?.status === 'UNKNOWN') { notify(replyPlan.status === 'UNKNOWN' ? '话术生成结果未知，请查询原幂等请求后再继续' : '话术库没有足够证据，已转人工确认', 'error'); return; }
      }
      await call(window.agentApi.startWorkflow, { workflowId, version: '1', params, replyPlan, platformAccountId: value.platformAccountId || undefined }); notify('固定流程已提交；未验证发送会暂停等待人工检查');
    }
    catch (_error) { /* call() already displays a safe error and leaves inputs intact. */ }
    finally { state.workflowSubmitting.delete(kind); if (submit) { submit.disabled = false; submit.textContent = '启动固定流程'; } }
  };
}
function bind() {
  $('#nav').onclick = (event) => { const button = event.target.closest('[data-view]'); if (!button) return; state.taskEditor = null; state.draftUrl = ''; state.view = button.dataset.view; document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item === button)); render(); };
  $('#refresh').onclick = () => call(window.agentApi.refreshLicense);
  bindWorkflowForm('comments');
  bindWorkflowForm('live');
  if (state.view === 'knowledge' || state.view === 'agent') loadKnowledge();
  $('#content').onclick = async (event) => { const button = event.target.closest('[data-action]'); if (!button) return; const action = button.dataset.action; if (action === 'knowledge-refresh') { state.knowledge.loadedFor = ''; await loadKnowledge({ force: true }); return; } if (action === 'new-task') { state.draftUrl = ''; openTaskEditor(); return; } if (action === 'cancel-task') { state.taskEditor = null; state.view = 'tasks'; state.draftUrl = ''; render(); return; } if (action === 'edit-task') { const task = state.data.tasks.find((item) => item.id === button.dataset.id); openTaskEditor(task); return; } if (action === 'import-demo') { await call(window.agentApi.saveTask, { url: 'https://www.douyin.com/video/example', source: 'video', businessContext: '演示配置，不含真实数据', targetCustomer: '待配置', keywords: ['价格'], excludeKeywords: ['投诉'], replyTemplate: '这是演示模板，请先完成配置。', replyInstructions: '演示配置，不会自动发送', mode: 'manual', decisionMode: 'rule', intervalMs: 30000, dailyLimit: 20, maxActions: 20, status: 'stopped' }); notify('示例配置已导入，未创建演示评论或发送记录'); return; } if (action === 'search-pool') { const form = $('#search-form'); const value = Object.fromEntries(new FormData(form).entries()); const keyword = String(value.keyword || '').trim(); const minRelevance = Math.max(0, Math.min(100, Number(value.minRelevance) || 0)); const result = await call(window.agentApi.searchPool, { keyword: keyword || undefined, limit: 200, minRelevance }); state.search = { ...state.search, keyword, minRelevance, cursor: '', result: { ...(result || {}), status: result?.status || 'ok', hasMore: false } }; if ($('#search-results')) $('#search-results').innerHTML = renderSearchResults(state.search.result); return; } if (action === 'search-next') { await runSearch(); return; } if (action === 'search-open') { await call(window.agentApi.openTarget, button.dataset.url); notify('目标页面已打开；登录后点击启动任务'); return; } if (action === 'search-use') { state.draftUrl = button.dataset.url; state.view = 'comments'; render(); const form = $('#comments-workflow-form'); if (form) form.elements.url.value = button.dataset.url; return; } if (action === 'open-browser') { await call(window.agentApi.openTarget, button.dataset.url); notify('目标页面已打开；登录后点击启动任务'); return; } if (action === 'task-status') { await call(window.agentApi.setTaskStatus, { id: button.dataset.id, status: button.dataset.status }); return; } if (action === 'recheck-skipped') { const taskId = button.dataset.id; if (state.recheckPending.has(taskId)) return; const account = licenseIdentity(state.data?.license); state.recheckPending.add(taskId); button.disabled = true; render(); try { const result = await window.agentApi.recheckSkipped(taskId); await refresh(); if (licenseIdentity(state.data?.license) === account) notify(recheckResultText(result)); } catch (error) { if (licenseIdentity(state.data?.license) === account) { console.error('[desktop-ui]', error); notify(clientError(error), 'error'); } } finally { state.recheckPending.delete(taskId); render(); } return; } if (action === 'confirm') { await call(window.agentApi.confirmAction, button.dataset.id); return; } if (action === 'retry-draft') { await call(window.agentApi.retryDraft, button.dataset.eventKey); return; } if (action === 'load-ledger') { const response = await window.agentApi.getLedger(); state.ledger = Array.isArray(response) ? response : (response.entries || response.ledger || response.items || []); render(); return; } if (action === 'load-candidate') { const form = $('#selector-form'); for (const [key, value] of Object.entries(UNVERIFIED_CANDIDATE)) form.elements[key].value = value; notify('已载入未验证候选，请先探测并确认样例'); return; } if (action === 'probe') { const form = $('#selector-form'); const result = await call(window.agentApi.probeSelectors, profileFromForm(form)); if (result.transport === 'sidecar') { const entries = Object.entries(result.capability || {}).map(([key, item]) => `${key}：${item.implemented ? '已实现' : '未实现'}；自动资格 ${item.autoEligible === true ? '允许' : '未开放'}；验证来源 ${item.validation?.status || item.evidence || '未提供'}`); $('#probe-result').textContent = `外部专用 Chrome 运行组件：${result.verified ? '已实现' : '未声明'}；${entries.join(' ｜ ') || result.diagnostics || '无能力明细'}。页面送达仍须运行时平台响应确认。`; } else $('#probe-result').textContent = `当前可见匹配 评论 ${result.commentNode || 0}，输入框 ${result.replyInput || 0}，发送按钮 ${result.sendButton || 0}，样例 ${result.sample?.join(' / ') || '无'}`; return; } };
  if (!$('#content').dataset.workflowBound) {
    $('#content').dataset.workflowBound = '1';
    $('#content').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-action="resume-workflow"]');
      if (button) {
        await call(window.agentApi.resumeWorkflow, { runId: button.dataset.id, platformAccountId: button.dataset.platformAccountId || undefined });
        notify('流程已按原检查点继续');
        return;
      }
      const manual = event.target.closest('[data-action="manual-complete-workflow"]');
      if (!manual) return;
      const note = window.prompt('请确认你已在抖音页面人工处理完成，并记录简短说明：', '已人工检查页面并确认处理完成')
        ?.trim();
      if (!note) return;
      await call(window.agentApi.manualCompleteWorkflow, { runId: manual.dataset.id, platformAccountId: manual.dataset.platformAccountId || undefined, note });
      notify('已记录人工确认，积分和审计已由授权端处理');
    });
  }
  const chat = $('#agent-chat-form'); if (chat) chat.onsubmit = async (event) => { event.preventDefault(); const form = new FormData(chat); const message = String(form.get('message') || '').trim(); if (!message) return; const knowledgeSetId = String(form.get('knowledgeSetId') || '').trim(); const submit = chat.querySelector('button[type="submit"]'); if (submit) submit.disabled = true; try { await call(window.agentApi.chat, { message, context: knowledgeSetId ? { knowledgeSetId, knowledgeQuery: message } : {} }); notify('Agent 已选择固定流程并记录运行状态'); } finally { if (submit) submit.disabled = false; } };
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
  const search = $('#search-form'); if (search) search.onsubmit = async (event) => { event.preventDefault(); await runSearch({ reset: true }); };
  const knowledgeSet = $('#knowledge-set-form'); if (knowledgeSet) knowledgeSet.onsubmit = async (event) => { event.preventDefault(); const value = Object.fromEntries(new FormData(knowledgeSet).entries()); const submit = knowledgeSet.querySelector('button'); if (submit) { submit.disabled = true; submit.textContent = '创建中…'; } try { await window.agentApi.knowledgeCreateSet({ name: value.name, description: value.description || '' }); state.knowledge.loadedFor = ''; await loadKnowledge({ force: true }); notify('知识集已创建'); } catch (error) { notify(clientError(error), 'error'); } finally { if (submit) { submit.disabled = false; submit.textContent = '新建知识集'; } } };
  const knowledgeSelect = $('#knowledge-set-select'); if (knowledgeSelect) knowledgeSelect.onchange = async () => { state.knowledge.selectedSetId = knowledgeSelect.value; state.knowledge.documents = []; state.knowledge.results = []; if (state.knowledge.selectedSetId) { try { const response = await window.agentApi.knowledgeListDocuments(state.knowledge.selectedSetId); state.knowledge.documents = Array.isArray(response) ? response : (response.documents || []); render(); } catch (error) { notify(clientError(error), 'error'); } } else render(); };
  const knowledgeDocument = $('#knowledge-document-form'); if (knowledgeDocument) knowledgeDocument.onsubmit = async (event) => { event.preventDefault(); if (!state.knowledge.selectedSetId) return; const value = Object.fromEntries(new FormData(knowledgeDocument).entries()); let metadata = {}; try { metadata = value.metadata ? JSON.parse(value.metadata) : {}; } catch (_error) { notify('元数据必须是合法 JSON', 'error'); return; } const submit = knowledgeDocument.querySelector('button'); if (submit) { submit.disabled = true; submit.textContent = '添加中…'; } try { await window.agentApi.knowledgeAddDocument({ knowledgeSetId: state.knowledge.selectedSetId, title: value.title, content: value.content, metadata }); const response = await window.agentApi.knowledgeListDocuments(state.knowledge.selectedSetId); state.knowledge.documents = Array.isArray(response) ? response : (response.documents || []); knowledgeDocument.reset(); render(); notify('文档已添加'); } catch (error) { notify(clientError(error), 'error'); } finally { if (submit) { submit.disabled = false; submit.textContent = '添加文档'; } } };
  const knowledgeRetrieve = $('#knowledge-retrieve-form'); if (knowledgeRetrieve) knowledgeRetrieve.onsubmit = async (event) => { event.preventDefault(); if (!state.knowledge.selectedSetId) return; const value = Object.fromEntries(new FormData(knowledgeRetrieve).entries()); const submit = knowledgeRetrieve.querySelector('button'); if (submit) { submit.disabled = true; submit.textContent = '检索中…'; } try { const response = await window.agentApi.knowledgeRetrieve({ knowledgeSetId: state.knowledge.selectedSetId, query: value.query, topK: Math.max(1, Math.min(20, Number(value.topK) || 5)) }); state.knowledge.results = Array.isArray(response) ? response : (response.results || []); render(); } catch (error) { notify(clientError(error), 'error'); } finally { if (submit) { submit.disabled = false; submit.textContent = '检索'; } } };
  const selectors = $('#selector-form'); if (selectors) selectors.onsubmit = async (event) => { event.preventDefault(); await call(window.agentApi.saveSelectors, profileFromForm(selectors)); notify('选择器已校准并保存'); };
}

window.agentApi.onState((next) => {
  const previousLicense = state.data?.license;
  state.data = next;
  const licensed = next?.license?.state === 'authorized';
  const licenseChanged = Boolean(previousLicense) && (previousLicense.state !== next?.license?.state || licenseIdentity(previousLicense) !== licenseIdentity(next?.license));
  if (licenseChanged) { state.knowledge = { sets: [], documents: [], selectedSetId: '', results: [], loading: false, error: '', loadedFor: '' }; }
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
