'use strict';

class ApiError extends Error {
  constructor(message, status = 0, code = 'NETWORK_ERROR', body = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

class ApiClient {
  constructor({ baseUrl, authStore, fetchImpl = globalThis.fetch }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.authStore = authStore;
    this.fetchImpl = fetchImpl;
  }

  async request(method, path, body, timeoutMs = 12000, tokenOverride = null) {
    if (!this.baseUrl) throw new ApiError('授权中心地址未配置', 0, 'API_NOT_CONFIGURED');
    const headers = { Accept: 'application/json' };
    const token = tokenOverride || this.authStore.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new ApiError('授权中心暂时无法连接', 0, 'NETWORK_ERROR', { cause: error.message });
    }
    let parsed = null;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new ApiError('授权中心返回了不可解析的响应', response.status, 'PROTOCOL_ERROR', { cause: error.message });
    }
    if (!response.ok) {
      const code = parsed && (parsed.code || parsed.errorCode) || `HTTP_${response.status}`;
      const message = parsed && (parsed.message || parsed.error) || `授权中心返回 ${response.status}`;
      throw new ApiError(message, response.status, code, parsed);
    }
    return parsed || {};
  }

  login(credentials) {
    return this.request('POST', '/v1/auth/login', credentials);
  }

  me(tokenOverride = null) {
    return this.request('GET', '/v1/me', undefined, 12000, tokenOverride);
  }

  logout(tokenOverride = null) {
    return this.request('POST', '/v1/auth/logout', {}, 12000, tokenOverride);
  }

  ledger(tokenOverride = null) {
    return this.request('GET', '/v1/credits/ledger', undefined, 12000, tokenOverride);
  }

  redeem(body, tokenOverride = null) {
    return this.request('POST', '/v1/credits/redeem', body, 12000, tokenOverride);
  }

  draft(body) {
    return this.request('POST', '/v1/agent/draft', body, 30000);
  }

  evaluate(body) {
    return this.request('POST', '/v1/agent/evaluate', body, 12000);
  }

  plan(body) {
    return this.request('POST', '/v1/agent/plan', body, 30000);
  }

  workflows() {
    return this.request('GET', '/v1/workflows');
  }

  createWorkflowRun(body) {
    return this.request('POST', '/v1/workflow-runs', body, 12000);
  }

  workflowRun(runId) {
    return this.request('GET', `/v1/workflow-runs/${encodeURIComponent(runId)}`);
  }

  checkpointWorkflow(runId, body) {
    return this.request('POST', `/v1/workflow-runs/${encodeURIComponent(runId)}/checkpoints`, body, 12000);
  }

  recoverWorkflow(runId, body) {
    return this.request('POST', `/v1/workflow-runs/${encodeURIComponent(runId)}/recover`, body, 12000);
  }

  resultDecision(runId, body) {
    return this.request('POST', `/v1/workflow-runs/${encodeURIComponent(runId)}/result-decision`, body, 12000);
  }

  platformAccounts(tokenOverride = null) {
    return this.request('GET', '/v1/platform-accounts', undefined, 12000, tokenOverride);
  }

  createPlatformAccount(body, tokenOverride = null) {
    return this.request('POST', '/v1/platform-accounts', body, 12000, tokenOverride);
  }
}

module.exports = { ApiClient, ApiError };
