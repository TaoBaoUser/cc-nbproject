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
const { getAgent, describeProxyError } = require('./proxy-agent');

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

/**
 * 判断请求是否持有本地准入凭证。
 *
 * **为什么代理需要校验来客**：它监听在 127.0.0.1 上，本意是「只有本机能访问」。
 * 但「本机」不等于「本用户」—— 同一台机器上的任何进程、任何账户，只要能连上
 * 这个端口，就能让代理拿**用户真实的 API key** 去发请求并计费。而代理原先刻意
 * 丢弃客户端凭证、无条件换成 profile.apiKey，等于一个对同机全开的中转站。
 *
 * 凭证由 store.js 的 getLocalToken 生成并写进 Claude Code 的 ANTHROPIC_AUTH_TOKEN，
 * 只有本工具与被接管的 Claude Code 知道。
 *
 * 两个头都认：Anthropic 客户端把 ANTHROPIC_AUTH_TOKEN 放在
 * `Authorization: Bearer <token>`，部分实现走 `x-api-key`。
 *
 * 用普通字符串比较而非 timingSafeEqual：这里防的是「同机进程发现端口后顺手白用
 * 你的 key」，不是能反复测量响应时间的远程攻击者 —— 对一个 256 位随机数来说，
 * 猜测成功率与测量精度无关。
 */
function holdsLocalToken(req, token) {
  const headers = req.headers || {};
  const bearer = /^bearer\s+(.+)$/i.exec(headers.authorization || '');
  const viaBearer = bearer ? bearer[1].trim() : '';
  const viaApiKey = typeof headers['x-api-key'] === 'string' ? headers['x-api-key'].trim() : '';
  return viaBearer === token || viaApiKey === token;
}

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
      // 两个监听器都必须显式摘掉。只摘 'error' 是不够的：`listen(port, host, cb)`
      // 把 cb 实现为一次性的 'listening' 监听器，端口被占时它永不触发、
      // 也永不被移除。连续回退 20 次就会在同一个 server 上堆 20 个死监听器，
      // Node 会以 MaxListenersExceededWarning 警告潜在的内存泄漏。
      const onError = (err) => {
        cleanup();
        if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
          attempt += 1;
          tryListen();
        } else {
          reject(err);
        }
      };

      const onListening = () => {
        cleanup();
        // 用 server.address().port 而不是 startPort + attempt：
        // 当传入 0 时由操作系统分配随机端口，直接计算会返回错误的端口号。
        resolve(server.address().port);
      };

      const cleanup = () => {
        server.removeListener('error', onError);
        server.removeListener('listening', onListening);
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(startPort + attempt, host);
    };

    tryListen();
  });
}

/**
 * 创建代理实例。
 *
 * @param {object}   deps
 * @param {Function} deps.getActiveProfile  返回当前选中的供应商，或 null
 * @param {Function} [deps.getLocalToken]   返回本地准入凭证；返回 null/不传则不做校验
 * @param {Function} [deps.onUsage]         每完成一个请求的回调，参数为用量记录
 * @param {Function} [deps.onRequest]       请求开始/结束的回调，供 UI 实时日志使用
 * @param {string}   [deps.host]            监听地址，默认 127.0.0.1
 * @param {number}   [deps.port]            起始端口
 */
function createProxy({
  getActiveProfile,
  getLocalToken = null,
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

    // 准入校验。见 holdsLocalToken 与 store.js 的 getLocalToken。
    //
    // getLocalToken() 会读 profiles.json，因此**必须假设它会抛** —— 与下面几行的
    // getActiveProfile() 是同一类风险。这一处曾经漏掉过：用户手工把那个文件
    // 编辑坏（或磁盘写了一版半截文件）之后，异常会穿透 http 请求监听器，
    // 整个应用连同正在跑的代理一起消失，而对面只看到连接被重置。
    //
    // 抛错时**拒绝服务，而不是降级为「不校验」**。后者不是容错而是漏洞：
    // 代理会拿用户的真实 key 转发任何来客的请求，于是「把 profiles.json 弄坏」
    // 就成了同机任意进程绕过准入校验的办法。宁可回一条可读的 500。
    let localToken = null;
    try {
      localToken = typeof getLocalToken === 'function' ? getLocalToken() : null;
    } catch (err) {
      onRequest({ phase: 'error', error: err.message, profileName: null });
      sendJson(clientRes, 500, {
        type: 'error',
        error: {
          type: 'config_unreadable',
          message: `读取本地准入凭证失败：${err.message}`,
        },
      });
      return;
    }

    if (localToken && !holdsLocalToken(clientReq, localToken)) {
      sendJson(clientRes, 401, {
        type: 'error',
        error: {
          type: 'unauthorized',
          message: '缺少或不匹配的本地准入凭证。本代理只服务于被 cc-nbproject 接管的 Claude Code。',
        },
      });
      return;
    }

    let profile;
    try {
      profile = getActiveProfile();
    } catch (err) {
      // 配置文件损坏（profiles.json 不是合法 JSON）时，这个异常绝不能穿透
      // http 请求监听器 —— 那会变成主进程的未捕获异常，整个应用连同正在跑的
      // 代理一起消失，而客户端只是连接被重置、拿不到任何可解释的响应。
      // 转成一条 500，让用户看到原因，也让应用活着把界面上的提示显示出来。
      onRequest({ phase: 'error', error: err.message, profileName: null });
      sendJson(clientRes, 500, {
        type: 'error',
        error: {
          type: 'config_unreadable',
          message: `读取供应商配置失败：${err.message}`,
        },
      });
      return;
    }

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
          // 系统开着代理时走代理；本地/内网地址与没代理时这里是 undefined，即直连
          agent: getAgent(upstreamUrl.hostname, isTls),
        },
        onUpstreamResponse
      );
      upstreamReqRef = upstreamReq;

      upstreamReq.on('error', (err) => {
        const proxyNote = describeProxyError(err);
        onRequest({ phase: 'error', error: proxyNote || err.message, profileName: profile.name });
        if (clientRes.headersSent) {
          clientRes.destroy();
          return;
        }
        sendJson(clientRes, 502, {
          type: 'error',
          error: {
            type: proxyNote ? 'proxy_unreachable' : 'upstream_unreachable',
            message: proxyNote || `无法连接供应商「${profile.name}」：${err.message}`,
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

    // 先创建、再监听，但失败时**必须**把 server 清回去。
    // 否则下一次 start() 会命中上面那行 `if (server) return actualPort`，
    // 直接返回 null —— 既不报错也不重新监听，界面上的「重试」按钮于是点不动。
    const candidate = http.createServer(handleRequest);
    server = candidate;
    try {
      actualPort = await listenWithFallback(candidate, port, host);
    } catch (err) {
      server = null;
      actualPort = null;
      // 半开的实例要关掉，否则它持有的 handle 会拖住进程退出
      try {
        candidate.close();
      } catch {
        // 从未成功监听，close 可能直接抛错，忽略
      }
      throw err;
    }
    return actualPort;
  }

  /**
   * 停止监听。
   *
   * `server.close()` 要等**所有已建立的连接结束**才回调。代理给 Claude Code
   * 服务的那条转发路径没有任何超时，用户正开着会话（SSE 长连接）时这个等待
   * 没有上界 —— 而退出流程会 await 它，表现为「关掉窗口后应用再也退不掉」。
   *
   * 所以这里给 close 加一个有界的等待，超时后主动掐掉存量连接。
   */
  async function stop({ timeoutMs = 2000 } = {}) {
    if (!server) return;
    const closing = server;
    // 先清引用：close() 可能永远不回调，留着的话之后的 start() 会被挡住
    server = null;
    actualPort = null;

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (typeof closing.closeAllConnections === 'function') {
          closing.closeAllConnections();
        }
        resolve();
      }, timeoutMs);

      closing.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
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
 * 从上游的错误响应体里取 error.type。
 *
 * 403 有两种完全不同的含义，只能靠这个字段区分开：
 *   permission_error      → 模型在该地区/该账号下不可用（key 本身是好的）
 *   authentication_error  → 凭证问题
 * 只看状态码会把两者混为一谈。
 */
function pickErrorType(text) {
  try {
    const json = JSON.parse(text);
    const type = json && json.error && json.error.type;
    return typeof type === 'string' ? type : null;
  } catch {
    return null;
  }
}

/**
 * 把一次探测的失败响应归类。
 *
 * 401 与 403 必须分开。以前两者一律归成 auth_failed，于是 OpenRouter 回的
 * 「该模型在你的地区不可用」（403 + permission_error）被显示成
 * 「认证失败，请检查 API key」—— 用户拿着一个完全正常的 key 反复自查，
 * 而真正的问题是他探测的那个模型在自己所在地区没开放。
 */
function classifyFailure(status, text, durationMs) {
  const summary = summarizeUpstreamError(text);

  if (status === 401) {
    return {
      ok: false,
      kind: 'auth_failed',
      status,
      durationMs,
      message: '认证失败，请检查 API key',
    };
  }

  if (status === 403) {
    const type = pickErrorType(text);
    const isPermissionOrRegion =
      type === 'permission_error' || /region|not available|permission|地区/i.test(summary);
    if (isPermissionOrRegion) {
      // 保留上游原话：里面通常带着 region、model 这类可供搜索的关键词
      return {
        ok: false,
        kind: 'model_unavailable',
        status,
        durationMs,
        message: summary.slice(0, 500),
      };
    }
    return {
      ok: false,
      kind: 'auth_failed',
      status,
      durationMs,
      message: '认证失败，请检查 API key',
    };
  }

  // 400/404 常见于模型名不对，但说明端点和凭证已经通过了校验
  const looksLikeModelIssue = /model|模型/i.test(text);
  return {
    ok: false,
    kind: looksLikeModelIssue ? 'model_not_found' : 'upstream_error',
    status,
    durationMs,
    // 保留上游原话而不是自造一句，否则用户拿不到可搜索的关键词
    message: summary.slice(0, 500),
  };
}

/** 向指定上游发一次最小请求，探测某个模型名。从不抛错，失败也以普通对象返回。 */
function probeOnce({ upstreamUrl, basePath, transport, isTls, profile, model, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const body = JSON.stringify({
      model,
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
        agent: getAgent(upstreamUrl.hostname, isTls),
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
          resolve(classifyFailure(res.statusCode, text, durationMs));
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
        // 代理自己连不上时，得说清是代理的问题 —— 否则用户会去查 baseUrl 和 key
        message: describeProxyError(err) || err.message,
      });
    });

    req.end(body);
  });
}

/**
 * 所有候选都失败时，挑一条最能指导用户行动的结论。
 *
 * 优先级而不是「取第一个」：auth_failed 与 network_error 是全盘性的问题，
 * 任何一条命中就说明故障不在模型名上，先让用户去查 key / baseUrl；
 * 只有当失败的候选清一色是模型相关时，才把话题引到模型上去。
 */
const CONCLUSION_PRIORITY = [
  'auth_failed',
  'network_error',
  'model_unavailable',
  'model_not_found',
  'upstream_error',
];

function pickConclusion({ failures, tried, durationMs }) {
  const allSameKind = failures.every((f) => f.kind === failures[0].kind);
  const picked = allSameKind
    ? failures[0]
    : CONCLUSION_PRIORITY.map((k) => failures.find((f) => f.kind === k)).find(Boolean) ||
      failures[0];

  return {
    ok: false,
    kind: picked.kind,
    status: picked.status,
    durationMs,
    message: picked.message,
    probedModel: picked.model,
    tried,
    // 逐条留证：用户配了三条映射时，能一眼看出是哪几条不通、分别为什么
    failures: failures.map((f) => ({
      model: f.model,
      kind: f.kind,
      status: f.status,
      message: f.message,
    })),
  };
}

/**
 * 连接测试：向指定供应商发一个最小的真实请求，验证端点可达、凭证有效。
 *
 * 为什么不用 GET /v1/models 之类的轻量接口：Anthropic 兼容实现的覆盖面参差不齐，
 * /v1/models 未必存在，而 /v1/messages 是所有兼容实现都必须支持的。
 *
 * 返回值区分了几种失败原因，因为对用户的行动指引完全不同：
 *   - 认证失败 → 去检查 API key
 *   - 模型不存在 / 模型在地区不可用 → key 大概率是好的，去查模型名或换个模型
 *   - 网络不可达 → 去检查 baseUrl 和网络
 */
async function testUpstream(
  profile,
  { timeoutMs = 20000, model = 'claude-3-5-haiku-20241022' } = {}
) {
  const startedAt = Date.now();

  let upstreamUrl;
  try {
    upstreamUrl = new URL(profile.baseUrl);
  } catch {
    return { ok: false, kind: 'invalid_url', message: 'baseUrl 不是合法 URL', durationMs: 0 };
  }

  const isTls = upstreamUrl.protocol === 'https:';
  const transport = isTls ? https : http;
  const basePath = upstreamUrl.pathname.replace(/\/+$/, '');

  /*
   * 逐个探测候选模型，哪个通就用哪个。
   *
   * 为什么不只取第一条：映射是用户按用途分组配的，第一条完全可能是图像模型、
   * 该账号下没权限的模型、或只在部分地区开放的模型。以前固定取第一条的目标名，
   * 于是「配置完全正确」会被那一个不可用的模型误报成「认证失败」——
   * 用户拿着好 key 反复自查，而真正能用的模型就排在第二条。
   *
   * 配了映射就用映射的「目标」名（那才是真正会发给上游的名字）；
   * 没配就用默认探测名。
   */
  const map = normalizeModelMap(profile.modelMap);
  const mappedTargets = map ? [...new Set(Object.values(map))] : [];
  const candidates = mappedTargets.length > 0 ? mappedTargets : [model];

  const tried = [];
  const failures = [];
  // 全部候选共享一个总预算，与原来单次请求的时长上限一致 ——
  // 否则映射配了十条，最坏情况要卡 200 秒。
  const deadline = startedAt + timeoutMs;

  for (const candidate of candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const result = await probeOnce({
      upstreamUrl,
      basePath,
      transport,
      isTls,
      profile,
      model: candidate,
      timeoutMs: remaining,
    });
    tried.push(candidate);

    if (result.ok) {
      // durationMs 报整体耗时：前面试失败的那几次，用户也是实打实等了的
      return {
        ...result,
        durationMs: Date.now() - startedAt,
        probedModel: candidate,
        tried,
      };
    }
    failures.push({ model: candidate, ...result });
  }

  if (failures.length === 0) {
    // 只会在预算一开始就耗尽（timeoutMs 被设成极小值）时发生
    return {
      ok: false,
      kind: 'network_error',
      durationMs: Date.now() - startedAt,
      message: '请求发出前预算就已耗尽',
      tried,
    };
  }

  return pickConclusion({ failures, tried, durationMs: Date.now() - startedAt });
}

module.exports = {
  createProxy,
  testUpstream,
  classifyFailure,
  createUsageExtractor,
  filterHeaders,
  holdsLocalToken,
  normalizeModelMap,
  rewriteModel,
  summarizeUpstreamError,
};
