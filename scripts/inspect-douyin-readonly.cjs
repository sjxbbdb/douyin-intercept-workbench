'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const targetUrl = 'https://v.douyin.com/aNdCUl2rQAY/';
const evidenceDir = path.join(__dirname, '..', 'evidence-private', 'electron-ui');
fs.mkdirSync(evidenceDir, { recursive: true });

function visible(node) {
  const rect = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1240, height: 860, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await window.loadURL(targetUrl);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 8_000));
  const evidence = await window.webContents.executeJavaScript(`(() => { const candidates = { commentNode: '[data-e2e="comment-item"], [data-e2e="comment-list"] [role="listitem"]', commentText: '[data-e2e="comment-text"]', commentAuthor: '[data-e2e="comment-author"]', commentId: '[data-comment-id]', replyInput: 'textarea, [contenteditable="true"]', sendButton: 'button', replyButton: 'button' }; const counts = Object.fromEntries(Object.entries(candidates).map(([key, selector]) => [key, Array.from(document.querySelectorAll(selector)).filter(${visible.toString()}).length])); const url = new URL(location.href); url.search = ''; url.hash = ''; return { finalUrl: url.href, title: document.title, readyState: document.readyState, bodyTextLength: document.body?.innerText?.length || 0, visibleCandidateCounts: counts, checkedAt: new Date().toISOString() }; })()`, true);
  fs.writeFileSync(path.join(evidenceDir, 'douyin-readonly.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  const image = await window.webContents.capturePage();
  fs.writeFileSync(path.join(evidenceDir, '09-douyin-readonly.png'), image.toPNG());
  console.log(JSON.stringify({ finalUrl: evidence.finalUrl, title: evidence.title, visibleCandidateCounts: evidence.visibleCandidateCounts }));
  window.destroy();
  app.quit();
}).catch((error) => { console.error(`readonly inspect failed: ${error.message}`); app.quit(); process.exitCode = 1; });
