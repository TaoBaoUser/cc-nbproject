'use strict';

/**
 * 拉取供应商的模型列表。设计记录见 docs/plans/2026-09-21-cc-nbproject-design.md 第 6.6 节。
 *
 * **为什么这件事不能由渲染进程直接做**：渲染进程的 CSP 里写着 `connect-src 'none'`，
 * 它本来就不允许发起网络请求（见 index.html）。那是刻意的隔离边界，
 * 不该为了一个便利功能破例。
 *
 * **为什么它只能是"辅助"而不能是唯一路径**：`/v1/models` 不属于 Anthropic 兼容规范，
 * 覆盖面无任何保证 —— 实测 OpenRouter 有（200，446 个模型），DeepSeek 没有（404）。
 * 所以调用方必须准备好"拉不到就让用户手写"这条路。
 */

const http = require('http');
const https = require('https');

// 复用 proxy.js 里的错误摘要：各家错误体形状不一，这里要处理的是同一类问题。
// proxy.js 不依赖本模块，因此不构成循环依赖。
const { summarizeUpstreamError } = require('./proxy');
const { getAgent, describeProxyError } = require('./proxy-agent');

const DEFAULT_TIMEOUT_MS = 20000;

/** 模型列表的缓存时长。OpenRouter 那份有 738KB，每次开编辑框都重下没道理。 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * 从各家不同形状的响应里抽出 `{id, name}` 数组。
 *
 * 至少要容忍三种形状，因为"兼容"在这里是各说各话：
 *   - `{ data: [...] }`  —— OpenAI / OpenRouter
 *   - `{ models: [...] }` —— 部分 Anthropic 兼容实现
 *   - `[...]`            —— 少数直接返回数组
 * 数组元素本身也可能是字符串或对象，一并容忍。
 */
function normalizeModels(payload) {
  let list = null;
  if (Array.isArray(payload)) {
    list = payload;
  } else if (payload && Array.isArray(payload.data)) {
    list = payload.data;
  } else if (payload && Array.isArray(payload.models)) {
    list = payload.models;
  }
  if (!list) return [];

  const out = [];
  for (const item of list) {
    const id = typeof item === 'string' ? item : item && item.id;
    if (typeof id !== 'string' || !id) continue;
    const name = item && typeof item.name === 'string' && item.name ? item.name : id;
    out.push({ id, name });
  }
  return out;
}

/**
 * 向供应商请求一次模型列表。不含缓存 —— 缓存由 createModelFetcher 负责。
 *
 * @returns {Promise<{ok:true, models:Array}|{ok:false, kind:string, status?:number, message:string}>}
 *   kind 取值：invalid_url / unsupported / auth_failed / upstream_error / network_error / empty
 *   `unsupported` 是最重要的一种：它表示"这个供应商没有该接口"，
 *   调用方应当据此退回到手工输入，而不是当成错误弹给用户。
 */
function requestModels({ baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(baseUrl);
    } catch {
      resolve({ ok: false, kind: 'invalid_url', message: 'baseUrl 不是合法 URL' });
      return;
    }

    const isTls = target.protocol === 'https:';
    const transport = isTls ? https : http;
    // 与 proxy.js 相同的路径拼接规则：baseUrl 自带路径前缀时要接在它后面，
    // 否则 https://openrouter.ai/api 会丢掉 /api。
    const basePath = target.pathname.replace(/\/+$/, '');

    const startedAt = Date.now();
    const headers = { accept: 'application/json', 'accept-encoding': 'identity' };
    if (apiKey) {
      // 与 proxy.js 一致地同时带上两种鉴权头，覆盖不同实现的偏好
      headers['x-api-key'] = apiKey;
      headers.authorization = `Bearer ${apiKey}`;
    }

    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isTls ? 443 : 80),
        path: basePath + '/v1/models',
        method: 'GET',
        headers,
        agent: getAgent(target.hostname, isTls),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode;

          if (status === 401 || status === 403) {
            resolve({
              ok: false,
              kind: 'auth_failed',
              status,
              message: '认证失败，请检查 API key',
            });
            return;
          }
          // 404 不是错误，是"这里没有这个接口"。单独归类，好让 UI 给出正确指引。
          if (status === 404) {
            resolve({
              ok: false,
              kind: 'unsupported',
              status,
              message: '该供应商没有 /v1/models 接口',
            });
            return;
          }
          if (status < 200 || status >= 300) {
            resolve({
              ok: false,
              kind: 'upstream_error',
              status,
              message: summarizeUpstreamError(text),
            });
            return;
          }

          let payload;
          try {
            payload = JSON.parse(text);
          } catch {
            // 200 但不是 JSON —— 多半是返回了一个 HTML 页面，同样视为"没有该接口"
            resolve({
              ok: false,
              kind: 'unsupported',
              status,
              message: '返回的不是 JSON，无法解析出模型列表',
            });
            return;
          }

          const models = normalizeModels(payload);
          if (models.length === 0) {
            resolve({
              ok: false,
              kind: 'empty',
              status,
              message: '接口有响应，但里面没有任何模型',
            });
            return;
          }

          resolve({ ok: true, models, durationMs: Date.now() - startedAt });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
    });

    req.on('error', (err) => {
      resolve({ ok: false, kind: 'network_error', message: describeProxyError(err) || err.message });
    });

    req.end();
  });
}

/**
 * 带缓存的拉取器。
 *
 * 缓存键里带上 apiKey 的尾部几个字符：不同 key 能看到的模型范围可能不同，
 * 只按 baseUrl 缓存会在用户换 key 后给出过期的结果。
 */
function createModelFetcher({ ttlMs = DEFAULT_TTL_MS } = {}) {
  const cache = new Map();

  return {
    async fetchModels({ baseUrl, apiKey, timeoutMs, force = false }) {
      const key = `${baseUrl || ''}::${apiKey ? apiKey.slice(-8) : ''}`;
      const now = Date.now();

      if (!force) {
        const hit = cache.get(key);
        if (hit && now - hit.at < ttlMs) {
          return { ...hit.result, cached: true };
        }
      }

      const result = await requestModels({ baseUrl, apiKey, timeoutMs });
      // 只缓存成功的结果。失败可能是暂时的（网络抖动、key 还没填好），
      // 把失败也缓存起来会让用户改完 key 重试时仍然拿到旧结论。
      if (result.ok) cache.set(key, { at: now, result });
      return result;
    },

    /** 供测试与"换供应商"场景清空缓存 */
    clear() {
      cache.clear();
    },

    get size() {
      return cache.size;
    },
  };
}

module.exports = { requestModels, createModelFetcher, normalizeModels };
