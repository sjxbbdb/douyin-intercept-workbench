'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const { JsonStore } = require('./json-store');

class AuthStore {
  constructor(userDataPath, safeStorage) {
    this.safeStorage = safeStorage;
    this.store = new JsonStore(`${userDataPath}/auth.json`, () => ({ deviceId: crypto.randomUUID(), token: null, license: null, endpoint: null }));
  }

  getDevice() {
    const state = this.store.get();
    return { id: state.deviceId, name: os.hostname().slice(0, 80) || 'Windows 工作台' };
  }

  getToken() {
    const state = this.store.get();
    if (!state.token) return null;
    try {
      return this.safeStorage.decryptString(Buffer.from(state.token, 'base64'));
    } catch (error) {
      console.warn('[auth-store] token decrypt failed; clearing local token', error.message);
      this.clear();
      return null;
    }
  }

  setSession(token, license, endpoint) {
    if (typeof token !== 'string' || !token) throw new TypeError('token is required');
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存授权会话');
    const encrypted = this.safeStorage.encryptString(token).toString('base64');
    this.store.update((state) => ({ ...state, token: encrypted, license: license || null, endpoint: endpoint || state.endpoint || null }));
  }

  setLicense(license) {
    this.store.update((state) => ({ ...state, license: license || null }));
  }

  setEndpoint(endpoint) {
    this.store.update((state) => ({ ...state, endpoint: endpoint || null }));
  }

  getLicense() {
    return this.store.get().license || null;
  }

  clear() {
    this.store.update((state) => ({ ...state, token: null, license: null }));
  }
}

module.exports = { AuthStore };
