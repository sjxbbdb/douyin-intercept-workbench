'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('agentApi', {
  getState: () => invoke('agent:get-state'),
  login: (payload) => invoke('agent:login', payload),
  logout: () => invoke('agent:logout'),
  refreshLicense: () => invoke('agent:refresh-license'),
  getEndpoint: () => invoke('agent:get-endpoint'),
  setEndpoint: (value) => invoke('agent:set-endpoint', value),
  getLedger: () => invoke('credits:ledger'),
  saveTask: (payload) => invoke('task:save', payload),
  setTaskStatus: (payload) => invoke('task:set-status', payload),
  recheckSkipped: (taskId) => invoke('task:recheck-skipped', taskId),
  deleteTask: (taskId) => invoke('task:delete', taskId),
  confirmAction: (actionId) => invoke('reply:confirm', actionId),
  retryDraft: (eventKey) => invoke('reply:retry-draft', eventKey),
  redeem: (code) => invoke('credits:redeem', { code }),
  openTarget: (url) => invoke('browser:open', url),
  searchTargets: (payload) => invoke('browser:search', payload),
  closeTarget: () => invoke('browser:close'),
  probeSelectors: (profile) => invoke('selectors:probe', profile),
  saveSelectors: (profile) => invoke('selectors:save', profile),
  onState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('agent:state', listener);
    return () => ipcRenderer.removeListener('agent:state', listener);
  }
});
