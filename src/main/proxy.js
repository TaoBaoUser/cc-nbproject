'use strict';

/**
 * 代理核心。
 *
 * 设计决策记录见 docs/plans/2026-09-21-cc-nbproject-design.md 第 3.4 / 6 节。
 *
 * 两条贯穿全文件的约束：
 *
 * 1. **不依赖 Electron。** 所有外部依赖通过参数注入（getActiveProfile /
 *    onUsage / onRequest）。这样代理逻辑可以被一个普通 Node 进程直接驱动
 *    和测试 —— 而它是本项目最容易出错、最需要反复调试的部分，每次改一行
 *    都要开 GUI 窗口是不可接受的。
 *
 * 2. **绝不缓冲上游响应。** Anthropic 的 /v1/messages 在 stream:true 时返回
 *    SSE 流，Claude Code 依赖它实现逐字输出。一旦写成 `await res.text()` 之类的
 *    缓冲模式，用户会先看到几十秒空白、然后整段文字突然出现。功能上"能收到
 *    回答"，体验上完全失败 —— 这也是最容易漏测的一类 bug。
 */

const http = require('http');
const https = require('https');
const { StringDecoder } = require('string_decoder');

/**
 * 逐跳首部（hop-by-hop headers）：这些首部只对单次 TCP 连接有意义，
 * 代理必须丢弃而不能转发，否则会破坏下游连接的语义。
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** 非流式响应的累积上限：超过后放弃用量解析，但继续正常转发。 */
const MAX_ACCUMULATE_BYTES = 8 * 1024 * 1024;

function filterHeaders(rawHeaders, alsoDrop = []) {
  const out = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (alsoDrop.includes(lower)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * SSE 用量提取器。
 *
 * 可以从响应内容中读出 token 用量，而不必自己估算 —— Anthropic 的响应自带：
 *   - message_start 事件：message.usage.input_tokens
 *   - message_delta 事件：usage.output_tokens（累计值）
 *
 * 为什么要自己做增量解析，而不能等响应结束后一次性解析：
 * 因为我们同时还要把数据转发给客户端，数据是边到边走的，没有"结束后"
 * 这个时机可用。事件可能跨 chunk 边界到达，所以必须维护一个残留缓冲。
 */
function createUsageExtractor() {
  // 用 StringDecoder 而非 chunk.toString()：后者在 UTF-8 字符跨越 chunk 边界时
  // 会把一个多字节字符截断成乱码，导致 JSON.parse 失败、用量静默丢失。
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const usage = { inputTokens: null, outputTokens: null, model: null };

  function handleEvent(rawEvent) {
    // 一个 SSE 事件可能由多行 data: 组成，需拼接
    const payload = rawEvent
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');

    if (!payload || payload === '[DONE]') return;

    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      // 无法解析的片段直接跳过：用量统计是旁路功能，
      // 绝不能因为解析失败而影响主流程的转发。
      return;
    }

    if (json.type === 'message_start' && json.message) {
      if (json.message.model) usage.model = json.message.model;
      const u = json.message.usage;
      if (u) {
        if (typeof u.input_tokens === 'number') usage.inputTokens = u.input_tokens;
        if (typeof u.output_tokens === 'number') usage.outputTokens = u.output_tokens;
      }
    }

    if (json.type === 'message_delta' && json.usage) {
      // message_delta 里的 output_tokens 是累计值，直接覆盖
      if (typeof json.usage.output_tokens === 'number') {
        usage.outputTokens = json.usage.output_tokens;
      }
      if (typeof json.usage.input_tokens === 'number') {
        usage.inputTokens = json.usage.input_tokens;
      }
    }
  }

  return {
    usage,
    feed(chunk) {
      buffer += decoder.write(chunk);
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        handleEvent(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
      // 防御：万一上游发来的不是标准 SSE（永远不出现空行），
      // 缓冲会无限增长。超过 1MB 仍未构成完整事件就丢弃，避免内存泄漏。
      if (buffer.length > 1024 * 1024) buffer = '';
    },
  };
}

/**
 * 归一化模型映射表，过滤掉空值与非字符串项。
 *
 * 返回 null 表示「没有配置映射」，调用方据此走不缓冲请求体的快路径 ——
 * 这是本功能不影响现有供应商性能的关键。
 */
function normalizeModelMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [from, to] of Object.entries(raw)) {
    if (typeof from === 'string' && from && typeof to === 'string' && to) {
      out[from] = to;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 改写请求体里的 model 字段。
 *
 * 为什么需要它：不同供应商对同一个模型的叫法不一样。Claude Code 发出的是
 * 它自己配置里的模型名（例如 deepseek-v4-pro），而 OpenRouter 要求
 * vendor/model 形式（例如 deepseek/deepseek-v4-pro）。少了这层映射，
 * 切换供应商时模型名就对不上，请求会被上游直接拒绝 —— 表现为"换了供应商
 * 就用不了"，而且报错信息通常不会指向真正的原因。
 *
 * 返回 null 表示无需改写（不是 JSON / 没有 model 字段 / 未命中映射规则），
 * 此时调用方应原样转发原始字节，避免无谓的重新序列化。
 */
function rewriteModel(payload, modelMap) {
  let json;
  try {
    json = JSON.parse(payload.toString('utf8'));
  } catch {
    // 不是 JSON，例如某些探测请求 —— 原样转发
    return null;
  }
  if (!json || typeof json.model !== 'string') return null;

  const mapped = modelMap[json.model];
  if (!mapped || mapped === json.model) return null;

  const from = json.model;
  json.model = mapped;
  // 重新序列化会改变空白/键序，但语义等价，上游不关心
  return { body: Buffer.from(JSON.stringify(json), 'utf8'), from, to: mapped };
}

/** 判断响应是否为 SSE 流。依据是 content-type，而非请求体里的 stream 字段。 */
function isEventStream(headers) {
  const ct = headers['content-type'] || '';
  return ct.includes('text/event-stream');
}

/**
 * 在指定端口上启动监听，端口被占用时自动向上寻找下一个可用端口。
 *
 * 为什么要做这个：8787 是个普通端口，用户机器上可能已被别的程序占用。
 * 如果启动失败就退出，用户只会看到一个没头没尾的错误，很难自行排查。
 * 自动回退并记下实际端口，体验好得多。
 */
function listenWithFallback(server, startPort, host, maxAttempts = 20) {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryListen = () => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
          attempt += 1;
          tryListen();
        } else {
          reject(err);
        }
      };

      server.once('error', onError);
      server.listen(startPort + attempt, host, () => {
        server.removeListener('error', onError);
        // 用 server.address().port 而不是 startPort + attempt：
        // 当传入 0 时由操作系统分配随机端口，直接计算会返回错误的端口号。
        resolve(server.address().port);
      });
    };

    tryListen();
  });
}

/**
 * 创建代理实例。
 *
 * @param {object}   deps
 * @param {Function} deps.getActiveProfile  返回当前选中的供应商，或 null
 * @param {Function} [deps.onUsage]         每完成一个请求的回调，参数为用量记录
 * @param {Function} [deps.onRequest]       请求开始/结束的回调，供 UI 实时日志使用
 * @param {string}   [deps.host]            监听地址，默认 127.0.0.1
 * @param {number}   [deps.port]            起始端口
 */
function createProxy({
  getActiveProfile,
  onUsage = () => {},
  onRequest = () => {},
  host = '127.0.0.1',
  port = 8787,
} = {}) {
  if (typeof getActiveProfile !== 'function') {
    throw new TypeError('createProxy 需要一个 getActiveProfile 函数');
  }

  let server = null;
  let actualPort = null;

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function handleRequest(clientReq, clientRes) {
    const startedAt = Date.now();
    const profile = getActiveProfile();

    if (!profile) {
      sendJson(clientRes, 503, {
        type: 'error',
        error: {
          type: 'no_active_profile',
          message: '尚未配置任何供应商，请在 cc-nbproject 中添加并激活一个供应商。',
        },
      });
      return;
    }

    let upstreamUrl;
    try {
      upstreamUrl = new URL(profile.baseUrl);
    } catch {
      sendJson(clientRes, 500, {
        type: 'error',
        error: {
          type: 'invalid_base_url',
          message: `供应商「${profile.name}」的 baseUrl 不是合法 URL`,
        },
      });
      return;
    }

    const isTls = upstreamUrl.protocol === 'https:';
    const transport = isTls ? https : http;

    // 拼接上游路径：baseUrl 自带路径（如 https://api.deepseek.com/anthropic）
    // 时，要把请求路径接在它后面，否则会打到错误的位置。
    const basePath = upstreamUrl.pathname.replace(/\/+$/, '');
    const targetPath = basePath + clientReq.url;

    /** 构造发往上游的请求头。bodyLength 非 null 时用于设置精确的 content-length。 */
    const buildHeaders = (bodyLength) => {
      const headers = filterHeaders(clientReq.headers, [
        // 丢弃客户端凭证，改用 profile 里存的真实 key
        'authorization',
        'x-api-key',
        // 强制要求未压缩的响应体
        'accept-encoding',
        // 长度由我们自己重新计算
        'content-length',
      ]);
      headers.host = upstreamUrl.host;

      if (profile.apiKey) {
        // 同时设置两种鉴权头：不同供应商对 x-api-key 与 Bearer 的支持不一，
        // 都带上可覆盖绝大多数 Anthropic 兼容实现。
        headers['x-api-key'] = profile.apiKey;
        headers.authorization = `Bearer ${profile.apiKey}`;
      }
      // 请求 identity：如果让上游返回 gzip，我们旁路解析用量时就必须先解压，
      // 复杂度和出错面都会上升。LLM 的响应以文本为主，放弃压缩的代价很小。
      headers['accept-encoding'] = 'identity';

      if (bodyLength !== null) {
        headers['content-length'] = bodyLength;
      }
      return headers;
    };

    // 在响应回调里需要访问它，用于客户端提前断开时掐掉上游请求
    let upstreamReqRef = null;

    const onUpstreamResponse = (upstreamRes) => {
      const status = upstreamRes.statusCode;
      const responseHeaders = filterHeaders(upstreamRes.headers, ['content-length']);

      // 上游若无视 accept-encoding 仍返回压缩内容，放弃用量解析但照常转发。
      const encoded = Boolean(
        upstreamRes.headers['content-encoding'] &&
        upstreamRes.headers['content-encoding'] !== 'identity'
      );

      clientRes.writeHead(status, responseHeaders);

      const streaming = isEventStream(upstreamRes.headers) && !encoded;
      const extractor = streaming ? createUsageExtractor() : null;
      let accumulated = encoded ? null : Buffer.alloc(0);
      let accumulatedBytes = 0;
      // 记录是否已向客户端写过数据。v0.2 的故障转移要靠它判断
      // 当前请求处于"可安全重试"还是"已不可挽回"的阶段。
      let bytesSent = 0;
      let settled = false;

      upstreamRes.on('data', (chunk) => {
        bytesSent += chunk.length;

        if (streaming) {
          extractor.feed(chunk);
        } else if (accumulated && accumulatedBytes + chunk.length <= MAX_ACCUMULATE_BYTES) {
          accumulated = Buffer.concat([accumulated, chunk]);
          accumulatedBytes += chunk.length;
        } else {
          // 超出上限，放弃解析用量，但转发继续
          accumulated = null;
        }

        // 流式转发 + 背压处理：客户端消费不过来时暂停上游，
        // 否则内存里会堆积整个响应。
        const flushed = clientRes.write(chunk);
        if (!flushed) {
          upstreamRes.pause();
          clientRes.once('drain', () => upstreamRes.resume());
        }
      });

      upstreamRes.on('end', () => {
        if (settled) return;
        settled = true;
        clientRes.end();

        let usage = extractor ? extractor.usage : null;
        if (!usage && accumulated) {
          usage = parseNonStreamingUsage(accumulated);
        }

        onUsage({
          ts: new Date().toISOString(),
          profileId: profile.id,
          profileName: profile.name,
          model: (usage && usage.model) || null,
          inputTokens: (usage && usage.inputTokens) ?? null,
          outputTokens: (usage && usage.outputTokens) ?? null,
          status,
          durationMs: Date.now() - startedAt,
        });

        onRequest({
          phase: 'end',
          status,
          durationMs: Date.now() - startedAt,
          profileName: profile.name,
          bytesSent,
        });
      });

      upstreamRes.on('error', (err) => {
        if (settled) return;
        settled = true;
        onRequest({ phase: 'error', error: err.message, profileName: profile.name });
        // 响应头已经发出去了，无法再改状态码，只能断开
        clientRes.destroy();
      });

      // 客户端提前断开（用户按了 Esc）：及时掐掉上游请求，别让 token 白烧
      clientRes.on('close', () => {
        if (!settled) {
          settled = true;
          upstreamRes.destroy();
          if (upstreamReqRef) upstreamReqRef.destroy();
        }
      });
    };

    /** 把请求体发往上游。bodyBuffer 为 null 表示直接透传客户端请求流。 */
    const sendUpstream = (bodyBuffer) => {
      const upstreamReq = transport.request(
        {
          protocol: upstreamUrl.protocol,
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port || (isTls ? 443 : 80),
          path: targetPath,
          method: clientReq.method,
          headers: buildHeaders(bodyBuffer ? Buffer.byteLength(bodyBuffer) : null),
        },
        onUpstreamResponse
      );
      upstreamReqRef = upstreamReq;

      upstreamReq.on('error', (err) => {
        onRequest({ phase: 'error', error: err.message, profileName: profile.name });
        if (clientRes.headersSent) {
          clientRes.destroy();
          return;
        }
        sendJson(clientRes, 502, {
          type: 'error',
          error: {
            type: 'upstream_unreachable',
            message: `无法连接供应商「${profile.name}」：${err.message}`,
          },
        });
      });

      if (bodyBuffer) {
        upstreamReq.end(bodyBuffer);
      } else {
        clientReq.pipe(upstreamReq);
      }
    };

    onRequest({
      phase: 'start',
      method: clientReq.method,
      path: clientReq.url,
      profileName: profile.name,
    });

    const modelMap = normalizeModelMap(profile.modelMap);

    if (!modelMap) {
      // 快路径：不需要改写模型名，请求体原样透传，不在内存里过一遍。
      sendUpstream(null);
      return;
    }

    // 慢路径：要改写请求体里的 model 字段，必须先完整读出请求体。
    // 这条路径会缓冲请求体（通常几十 KB 到几 MB），是「模型映射」的必要代价，
    // 因此只对配置了映射的供应商启用。
    const chunks = [];
    clientReq.on('data', (chunk) => chunks.push(chunk));
    clientReq.on('end', () => {
      const original = Buffer.concat(chunks);
      const rewritten = rewriteModel(original, modelMap);
      if (rewritten) {
        onRequest({
          phase: 'rewrite',
          from: rewritten.from,
          to: rewritten.to,
          profileName: profile.name,
        });
        sendUpstream(rewritten.body);
      } else {
        sendUpstream(original);
      }
    });
  }

  async function start() {
    if (server) return actualPort;
    server = http.createServer(handleRequest);
    actualPort = await listenWithFallback(server, port, host);
    return actualPort;
  }

  async function stop() {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
    server = null;
    actualPort = null;
  }

  return {
    start,
    stop,
    get port() {
      return actualPort;
    },
    get host() {
      return host;
    },
    get baseUrl() {
      return actualPort ? `http://${host}:${actualPort}` : null;
    },
  };
}

/** 从非流式响应体中提取用量。 */
function parseNonStreamingUsage(buffer) {
  try {
    const json = JSON.parse(buffer.toString('utf8'));
    const u = json.usage;
    if (!u) return null;
    return {
      model: json.model || null,
      inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : null,
      outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : null,
    };
  } catch {
    return null;
  }
}

/**
 * 从上游的错误响应里抽出可读信息。
 *
 * 各家供应商的错误体形状不一（`{error:{message}}` / `{message}` / 纯文本），
 * 直接原样丢给用户是一大坨 JSON，关键字被挤在中间；而那句话往往正是
 * 唯一的线索（例如「你发的模型名是 xxx，我不认识」）。
 * 解析不出来就退回原文，绝不因为解析失败而丢掉信息。
 */
function summarizeUpstreamError(text) {
  try {
    const json = JSON.parse(text);
    const message = json && json.error && json.error.message;
    if (typeof message === 'string' && message) return message;
    if (json && typeof json.message === 'string' && json.message) return json.message;
  } catch {
    // 不是 JSON —— 用原文
  }
  return text;
}

/**
 * 连接测试：向指定供应商发一个最小的真实请求，验证端点可达、凭证有效。
 *
 * 为什么不用 GET /v1/models 之类的轻量接口：Anthropic 兼容实现的覆盖面参差不齐，
 * /v1/models 未必存在，而 /v1/messages 是所有兼容实现都必须支持的。
 *
 * 返回值区分了几种失败原因，因为对用户的行动指引完全不同：
 *   - 认证失败 → 去检查 API key
 *   - 模型不存在 → key 大概率是好的，去检查模型名
 *   - 网络不可达 → 去检查 baseUrl 和网络
 */
async function testUpstream(
  profile,
  { timeoutMs = 20000, model = 'claude-3-5-haiku-20241022' } = {}
) {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let upstreamUrl;
    try {
      upstreamUrl = new URL(profile.baseUrl);
    } catch {
      resolve({ ok: false, kind: 'invalid_url', message: 'baseUrl 不是合法 URL', durationMs: 0 });
      return;
    }

    const isTls = upstreamUrl.protocol === 'https:';
    const transport = isTls ? https : http;
    const basePath = upstreamUrl.pathname.replace(/\/+$/, '');

    // 配了模型映射时，用映射的「目标」名去探测。
    // 因为真正会被发给上游的是目标名，用源名去测只会得到一个必然失败的
    // model_not_found —— 那会把「配置正确」误报成「配置有问题」，
    // 比不测更糟。取第一条规则的目标名即可：它们指向同一个供应商。
    const map = normalizeModelMap(profile.modelMap);
    const probeModel = map ? Object.values(map)[0] : model;

    const body = JSON.stringify({
      model: probeModel,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });

    const req = transport.request(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (isTls ? 443 : 80),
        path: basePath + '/v1/messages',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'accept-encoding': 'identity',
          'x-api-key': profile.apiKey || '',
          authorization: `Bearer ${profile.apiKey || ''}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const durationMs = Date.now() - startedAt;
          const text = Buffer.concat(chunks).toString('utf8');

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, kind: 'ok', status: res.statusCode, durationMs });
            return;
          }

          if (res.statusCode === 401 || res.statusCode === 403) {
            resolve({
              ok: false,
              kind: 'auth_failed',
              status: res.statusCode,
              durationMs,
              message: '认证失败，请检查 API key',
            });
            return;
          }

          // 400/404 常见于模型名不对，但说明端点和凭证已经通过了校验
          const summary = summarizeUpstreamError(text);
          const looksLikeModelIssue = /model|模型/i.test(text);
          resolve({
            ok: false,
            kind: looksLikeModelIssue ? 'model_not_found' : 'upstream_error',
            status: res.statusCode,
            durationMs,
            // 保留上游原话而不是自造一句，否则用户拿不到可搜索的关键词
            message: summary.slice(0, 500),
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
    });

    req.on('error', (err) => {
      resolve({
        ok: false,
        kind: 'network_error',
        durationMs: Date.now() - startedAt,
        message: err.message,
      });
    });

    req.end(body);
  });
}

module.exports = {
  createProxy,
  testUpstream,
  createUsageExtractor,
  filterHeaders,
  normalizeModelMap,
  rewriteModel,
  summarizeUpstreamError,
};
