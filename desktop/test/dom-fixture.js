'use strict';

const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const { collectorScript, probeScript, replyScript } = require('../src/lib/browser-bridge');

const fixture = `<!doctype html><html><body>
<div id="root-composer"><textarea class="editor"></textarea><button class="send">root send</button></div>
<div class="comment" data-comment-id="a1"><span class="author">相同作者</span><span class="text">价格多少</span><button class="reply">回复</button></div>
<div class="comment" data-comment-id="a2"><span class="author">相同作者</span><span class="text">发货多久</span><button class="reply">回复</button></div>
<div class="comment" data-comment-id="hidden" style="display:none"><span class="author">隐藏作者</span><span class="text">价格隐藏</span><button class="reply">回复</button></div>
<script>
window.sent = [];
document.querySelectorAll('.comment').forEach((node) => node.querySelector('.reply').addEventListener('click', () => setTimeout(() => {
  const editor = document.createElement('textarea'); editor.className = 'editor'; node.appendChild(editor);
  const send = document.createElement('button'); send.className = 'send'; send.textContent = 'target send'; send.addEventListener('click', () => window.sent.push(node.dataset.commentId)); node.appendChild(send);
}, 80)));
</script></body></html>`;

async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fixture)}`);
  const profile = { commentNode: '.comment', commentId: '[data-comment-id]', commentText: '.text', commentAuthor: '.author', replyInput: 'textarea.editor', sendButton: 'button.send', replyButton: 'button.reply' };
  const probe = await win.webContents.executeJavaScript(probeScript(profile), true);
  assert.equal(probe.commentNode, 2);
  const first = await win.webContents.executeJavaScript(collectorScript(profile, 'video'), true);
  assert.equal(first.events.length, 2);
  const second = await win.webContents.executeJavaScript(collectorScript(profile, 'video'), true);
  assert.equal(second.events.length, 0);
  const target = first.events.find((event) => event.id === 'a1');
  const result = await win.webContents.executeJavaScript(replyScript(profile, '已收到，欢迎咨询', 'video', { id: target.id, text: target.text, authorName: target.authorName, roomId: 'data://fixture' }), true);
  assert.equal(result.status, 'blocked');
  const actualRoom = await win.webContents.executeJavaScript('location.origin + location.pathname');
  const sent = await win.webContents.executeJavaScript(replyScript(profile, '已收到，欢迎咨询', 'video', { id: target.id, text: target.text, authorName: target.authorName, roomId: actualRoom }), true);
  assert.equal(sent.status, 'unknown');
  const sentIds = await win.webContents.executeJavaScript('window.sent');
  assert.deepEqual(sentIds, ['a1']);
  await win.webContents.executeJavaScript("document.querySelector('[data-comment-id=\\\"a2\\\"] .reply').disabled = true");
  const disabled = await win.webContents.executeJavaScript(replyScript(profile, '二次回复', 'video', { id: 'a2', text: '发货多久', authorName: '相同作者', roomId: actualRoom }), true);
  assert.equal(disabled.status, 'blocked');
  win.destroy();
  app.quit();
  console.log('PASS DOM fixture collector/reply guards');
}

run().catch((error) => { console.error(error); app.quit(); process.exitCode = 1; });
