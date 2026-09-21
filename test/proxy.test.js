'use strict';

/**
 * 代理核心的单元测试。
 *
 * 这些测试完全不需要 Electron —— 这正是 proxy.js 做依赖注入的目的
 * （见设计文档 3.4）。跑起来就是 `npm test`，几百毫秒。
 *
 * 测试重点放在两类问题上：
 *   1. 会静默出错的问题（用量算错、鉴权用错 key）—— 功能看起来正常，但结果是错的
 *   2. 会破坏核心体验的问题（把流式响应缓冲成一整块）—— 功能"能用"，但用起来很难受
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const {
  createProxy,
  testUpstream,
  createUsageExtractor,
  normalizeModelMap,
  rewriteModel,
  summarizeUpstreamError,
  holdsLocalToken,
} = require('../src/main/proxy.js');

/** 起一个测试用的假上游服务器，端口交给操作系统随机分配。 */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

/** 通过代理发一个请求，记录响应内容以及数据分几次到达。 */
function requestThroughProxy(
  baseUrl,
  { path = '/v1/messages', method = 'POST', body = '{}', headers = {} } = {}
) {
  return new Promise((resolve, reject) => {
    const target = new URL(baseUrl + path);
    const chunks = [];

    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method,
        headers: { 'content-type': 'application/json', ...headers },
        // 测试里不复用连接，否则 stopServer 会因 keep-alive 连接挂住
        agent: false,
      },
      (res) => {
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            raw: Buffer.concat(chunks),
            body: Buffer.concat(chunks).toString('utf8'),
            chunkCount: chunks.length,
          })
        );
      }
    );

    req.on('error', reject);
    req.end(body);
  });
}

/** 构造一个固定的供应商，指向给定的假上游。 */
function profileFor(baseUrl, overrides = {}) {
  return {
    id: 'p1',
    name: '测试供应商',
    baseUrl,
    apiKey: 'sk-real-key-from-profile',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. SSE 流式转发 —— 整个项目的正确性基石
// ---------------------------------------------------------------------------

test('流式转发：内容逐块透传，且字节级保真', async (t) => {
  const sseEvents = [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"test-model","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好世界"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];

  const upstream = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    // 刻意在事件之间留出间隔，模拟真实的逐字输出。
    // 若代理错误地缓冲了整个响应，这里就只会有一次 data 事件。
    const timer = setInterval(() => {
      if (i >= sseEvents.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(sseEvents[i]);
      i += 1;
    }, 15);
  });

  const usageRecords = [];
  const proxy = createProxy({
    getActiveProfile: () => profileFor(upstream.baseUrl),
    onUsage: (record) => usageRecords.push(record),
    port: 0,
  });
  const proxyPort = await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await stopServer(upstream.server);
  });

  const result = await requestThroughProxy(`http://127.0.0.1:${proxyPort}`);

  assert.equal(result.status, 200);
  // 保真：客户端拿到的内容与上游发出的完全一致（包括多字节中文）
  assert.equal(result.body, sseEvents.join(''));
  // 不是缓冲模式：数据必须是分多次到达的
  assert.ok(
    result.chunkCount > 1,
    `期望数据分多次到达（流式），实际只收到 ${result.chunkCount} 次 —— 代理可能把响应缓冲成了一整块`
  );
  // 用量被正确旁路提取
  assert.equal(usageRecords.length, 1);
  assert.equal(usageRecords[0].inputTokens, 10);
  assert.equal(usageRecords[0].outputTokens, 42);
  assert.equal(usageRecords[0].model, 'test-model');
});

test('用量提取器：多字节字符跨 chunk 边界时仍能正确解析', () => {
  const extractor = createUsageExtractor();
  const full =
    'data: {"type":"message_start","message":{"model":"模型名称","usage":{"input_tokens":7,"output_tokens":0}}}\n\n';
  const buf = Buffer.from(full, 'utf8');

  // 逐字节喂入，强制把每个多字节字符都切成碎片。
  // 若实现里用 chunk.toString() 而不是 StringDecoder，这里就会解析失败。
  for (let i = 0; i < buf.length; i += 1) {
    extractor.feed(buf.subarray(i, i + 1));
  }

  assert.equal(extractor.usage.inputTokens, 7);
  assert.equal(extractor.usage.model, '模型名称');
});

test('用量提取器：无法解析的片段被跳过，不抛异常', () => {
  const extractor = createUsageExtractor();
  assert.doesNotThrow(() => {
    extractor.feed(Buffer.from('data: 这不是 JSON\n\n', 'utf8'));
    extractor.feed(Buffer.from('data: {"type":"message_stop"}\n\n', 'utf8'));
  });
});

// ---------------------------------------------------------------------------
// 2. 鉴权重写 —— 防止串号与凭证泄露
// ---------------------------------------------------------------------------

test('鉴权：发往上游的是 profile 里的 key，客户端传来的凭证被丢弃', async (t) => {
  let seen = null;
  const upstream = await startServer((req, res) => {
    seen = { authorization: req.headers.authorization, xApiKey: req.headers['x-api-key'] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"usage":{"input_tokens":1,"output_tokens":2}}');
  });

  const proxy = createProxy({
    getActiveProfile: () => profileFor(upstream.baseUrl),
    port: 0,
  });
  const proxyPort = await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await stopServer(upstream.server);
  });

  await requestThroughProxy(`http://127.0.0.1:${proxyPort}`, {
    headers: { authorization: 'Bearer client-supplied-token' },
  });

  assert.equal(seen.authorization, 'Bearer sk-real-key-from-profile');
  assert.equal(seen.xApiKey, 'sk-real-key-from-profile');
});

// ---------------------------------------------------------------------------
// 3. 非流式响应
// ---------------------------------------------------------------------------

test('非流式响应：内容正确转发且用量可提取', async (t) => {
  const payload = JSON.stringify({
    model: 'claude-3-5-haiku-20241022',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 123, output_tokens: 4 },
  });

  const upstream = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  });

  const usageRecords = [];
  const proxy = createProxy({
    getActiveProfile: () => profileFor(upstream.baseUrl),
    onUsage: (r) => usageRecords.push(r),
    port: 0,
  });
  const proxyPort = await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await stopServer(upstream.server);
  });

  const result = await requestThroughProxy(`http://127.0.0.1:${proxyPort}`);

  assert.equal(result.status, 200);
  assert.equal(result.body, payload);
  assert.equal(usageRecords[0].inputTokens, 123);
  assert.equal(usageRecords[0].outputTokens, 4);
});

// ---------------------------------------------------------------------------
// 4. 错误路径 —— 这些必须给出明确的信号，而不是静默挂起
// ---------------------------------------------------------------------------

test('未配置任何供应商时返回 503 并给出可读提示', async (t) => {
  const proxy = createProxy({ getActiveProfile: () => null, port: 0 });
  const proxyPort = await proxy.start();
  t.after(() => proxy.stop());

  const result = await requestThroughProxy(`http://127.0.0.1:${proxyPort}`);

  assert.equal(result.status, 503);
  assert.match(result.body, /no_active_profile/);
});

test('上游不可达时返回 502', async (t) => {
  // 指向一个几乎不可能有服务在监听的端口
  const proxy = createProxy({
    getActiveProfile: () => profileFor('http://127.0.0.1:9'),
    port: 0,
  });
  const proxyPort = await proxy.start();
  t.after(() => proxy.stop());

  const result = await requestThroughProxy(`http://127.0.0.1:${proxyPort}`);

  assert.equal(result.status, 502);
  assert.match(result.body, /upstream_unreachable/);
});

test('baseUrl 非法时返回 500 而不是崩溃', async (t) => {
  const proxy = createProxy({
    getActiveProfile: () => profileFor('这不是一个 URL'),
    port: 0,
  });
  const proxyPort = await proxy.start();
  t.after(() => proxy.stop());

  const result = await requestThroughProxy(`http://127.0.0.1:${proxyPort}`);

  assert.equal(result.status, 500);
  assert.match(result.body, /invalid_base_url/);
});

// ---------------------------------------------------------------------------
// 5. 端口回退
// ---------------------------------------------------------------------------

test('起始端口被占用时自动回退到下一个可用端口', async (t) => {
  const blocker = await startServer((req, res) => res.end('occupied'));

  const proxy = createProxy({ getActiveProfile: () => null, port: blocker.port });
  const actualPort = await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await stopServer(blocker.server);
  });

  assert.notEqual(actualPort, blocker.port, '不应复用已被占用的端口');
  assert.ok(actualPort > blocker.port, '应向上寻找可用端口');
});

// ---------------------------------------------------------------------------
// 6. 路径拼接 —— baseUrl 带路径前缀时最容易出错
// ---------------------------------------------------------------------------

test('上游 baseUrl 带路径前缀时，请求路径被正确拼接', async (t) => {
  let seenPath = null;
  const upstream = await startServer((req, res) => {
    seenPath = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"usage":{"input_tokens":1,"output_tokens":1}}');
  });

  const proxy = createProxy({
    // 模拟 https://api.deepseek.com/anthropic 这种带前缀的端点
    getActiveProfile: () => profileFor(`${upstream.baseUrl}/anthropic`),
    port: 0,
  });
  const proxyPort = await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await stopServer(upstream.server);
  });

  await requestThroughProxy(`http://127.0.0.1:${proxyPort}`, { path: '/v1/messages' });

  assert.equal(seenPath, '/anthropic/v1/messages');
});

// ---------------------------------------------------------------------------
// 7. 连接测试的失败分类 —— 不同原因对应完全不同的用户操作
// ---------------------------------------------------------------------------

test('连接测试：认证失败被识别为 auth_failed', async (t) => {
  const upstream = await startServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"invalid api key"}}');
  });
  t.after(() => stopServer(upstream.server));

  const result = await testUpstream(profileFor(upstream.baseUrl));

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'auth_failed');
});

test('连接测试：模型名问题与端点问题被区分开', async (t) => {
  const upstream = await startServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"model not found"}}');
  });
  t.after(() => stopServer(upstream.server));

  const result = await testUpstream(profileFor(upstream.baseUrl));

  assert.equal(result.ok, false);
  // 端点通了、凭证也过了，只是模型名不对 —— 用户该去改模型而非改 key
  assert.equal(result.kind, 'model_not_found');
});

test('连接测试：网络不可达被识别为 network_error', async () => {
  const result = await testUpstream(profileFor('http://127.0.0.1:9'), { timeoutMs: 3000 });

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'network_error');
});

test('连接测试：成功时返回延迟', async (t) => {
  const upstream = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"content":[],"usage":{"input_tokens":1,"output_tokens":1}}');
  });
  t.after(() => stopServer(upstream.server));

  const result = await testUpstream(profileFor(upstream.baseUrl));

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'ok');
  assert.ok(result.durationMs >= 0);
});

// ---------------------------------------------------------------------------
// 8. 模型映射 —— 换了供应商就得换模型名的那些场景
// ---------------------------------------------------------------------------

test('normalizeModelMap：无映射时返回 null，让调用方走快路径', () => {
  assert.equal(normalizeModelMap(undefined), null);
  assert.equal(normalizeModelMap(null), null);
  assert.equal(normalizeModelMap({}), null);
  // 全是无效项，等价于没配
  assert.equal(normalizeModelMap({ '': 'x', a: '' }), null);
  // 类型不对时不能抛错 —— 配置文件可能被手工改坏
  assert.equal(normalizeModelMap([['a', 'b']]), null);
  assert.equal(normalizeModelMap('a=b'), null);
});

test('normalizeModelMap：过滤无效项，保留有效项', () => {
  const map = normalizeModelMap({ a: 'b', '': 'c', d: '', e: 123, f: null });
  assert.deepEqual(map, { a: 'b' });
});

test('rewriteModel：命中规则时替换 model 字段，其余字段原样保留', () => {
  const payload = Buffer.from(
    JSON.stringify({
      model: 'deepseek-v4-pro',
      max_tokens: 8,
      messages: [{ role: 'user', content: '你好，世界' }],
    }),
    'utf8'
  );

  const result = rewriteModel(payload, { 'deepseek-v4-pro': 'deepseek/deepseek-v4-pro' });

  assert.equal(result.from, 'deepseek-v4-pro');
  assert.equal(result.to, 'deepseek/deepseek-v4-pro');

  const parsed = JSON.parse(result.body.toString('utf8'));
  assert.equal(parsed.model, 'deepseek/deepseek-v4-pro');
  assert.equal(parsed.max_tokens, 8);
  // 多字节正文必须完整保留
  assert.equal(parsed.messages[0].content, '你好，世界');
});

test('rewriteModel：不需要改写时返回 null，避免无谓的重新序列化', () => {
  const body = (model) => Buffer.from(JSON.stringify({ model }), 'utf8');
  const map = { a: 'b' };

  // 未命中规则
  assert.equal(rewriteModel(body('c'), map), null);
  // 映射到自己
  assert.equal(rewriteModel(body('a'), { a: 'a' }), null);
  // 没有 model 字段
  assert.equal(rewriteModel(Buffer.from('{"x":1}', 'utf8'), map), null);
  assert.equal(rewriteModel(Buffer.from('{"model":123}', 'utf8'), map), null);
  // 根本不是 JSON
  assert.equal(rewriteModel(Buffer.from('not json', 'utf8'), map), null);
  assert.equal(rewriteModel(Buffer.alloc(0), map), null);
});

test('模型映射（端到端）：发往上游的是映射后的模型名', async (t) => {
  let seen = null;
  const upstream = await startServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen = {
        raw: Buffer.concat(chunks).toString('utf8'),
        contentLength: req.headers['content-length'],
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"usage":{"input_tokens":1,"output_tokens":1}}');
    });
  });

  const events = [];
  const proxy = createProxy({
    getActiveProfile: () =>
      profileFor(upstream.baseUrl, { modelMap: { 'deepseek-v4-pro': 'deepseek/deepseek-v4-pro' } }),
    onRequest: (e) => events.push(e),
    port: 0,
  });
  const proxyPort = await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await stopServer(upstream.server);
  });

  await requestThroughProxy(`http://127.0.0.1:${proxyPort}`, {
    body: JSON.stringify({ model: 'deepseek-v4-pro', max_tokens: 8 }),
  });

  assert.equal(JSON.parse(seen.raw).model, 'deepseek/deepseek-v4-pro');
  // content-length 必须按改写后的字节数重算：目标名通常比源名长，
  // 若沿用原始长度，上游会截断请求体或直接挂起等待剩余字节。
  assert.equal(Number(seen.contentLength), Buffer.byteLength(seen.raw));
  // UI 日志要能看到映射命中，否则用户无从判断规则有没有生效
  assert.ok(events.some((e) => e.phase === 'rewrite'));
});

test('模型映射：未命中的模型名原样转发', async (t) => {
  let seen = null;
  const upstream = await startServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"usage":{"input_tokens":1,"output_tokens":1}}');
    });
  });

  const proxy = createProxy({
    getActiveProfile: () =>
      profileFor(upstream.baseUrl, { modelMap: { 'deepseek-v4-pro': 'deepseek/deepseek-v4-pro' } }),
    port: 0,
  });
  const proxyPort = await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await stopServer(upstream.server);
  });

  // Claude Code 会同时发主模型和后台小任务模型；只配了主模型的映射时，
  // 小任务模型必须原样透传，而不是被丢弃或改错。
  await requestThroughProxy(`http://127.0.0.1:${proxyPort}`, {
    body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 8 }),
  });

  assert.equal(JSON.parse(seen).model, 'deepseek-flash');
});

test('模型映射：非 JSON 请求体不被解析也不被破坏', async (t) => {
  let seen = null;
  const upstream = await startServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  const proxy = createProxy({
    // 两条路径都要验：配了映射走缓冲路径，没配走透传路径
    getActiveProfile: () => profileFor(upstream.baseUrl, { modelMap: { a: 'b' } }),
    port: 0,
  });
  const proxyPort = await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await stopServer(upstream.server);
  });

  await requestThroughProxy(`http://127.0.0.1:${proxyPort}`, { body: '这是纯文本，不是 JSON' });

  assert.equal(seen, '这是纯文本，不是 JSON');
});

test('summarizeUpstreamError：从各家不同形状的错误体里抽出可读信息', () => {
  // Anthropic / OpenRouter 风格
  assert.equal(
    summarizeUpstreamError('{"error":{"message":"model not found"}}'),
    'model not found'
  );
  // 部分兼容实现直接给 message
  assert.equal(summarizeUpstreamError('{"message":"invalid model"}'), 'invalid model');
  // 不是 JSON —— 必须退回原文，绝不能因为解析失败就把信息丢掉
  assert.equal(summarizeUpstreamError('gateway timeout'), 'gateway timeout');
  // 是 JSON 但没有可用的消息字段 —— 同样退回原文
  assert.equal(summarizeUpstreamError('{"code":500}'), '{"code":500}');
});

test('模型映射：连接测试用映射后的目标模型名探测', async (t) => {
  let seenModel = null;
  const upstream = await startServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seenModel = JSON.parse(Buffer.concat(chunks).toString('utf8')).model;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"content":[],"usage":{"input_tokens":1,"output_tokens":1}}');
    });
  });
  t.after(() => stopServer(upstream.server));

  const result = await testUpstream(
    profileFor(upstream.baseUrl, { modelMap: { 'deepseek-v4-pro': 'deepseek/deepseek-v4-pro' } })
  );

  // 若用源名去测，供应商必然回 model_not_found，会把正确的配置误报为错误
  assert.equal(result.ok, true);
  assert.equal(seenModel, 'deepseek/deepseek-v4-pro');
});

// ---------------------------------------------------------------------------
// 9. 逐个候选探测 —— 第一条映射不可用时，不该把整份配置判成坏的
//
// 起因：OpenRouter 用户的映射第一条是图像模型，而该模型被地区封锁（403
// permission_error）。旧实现固定取第一条的目标名去探测，于是「key、地址、
// 映射全对」的一份配置被显示成「认证失败，请检查 API key」。
// ---------------------------------------------------------------------------

test('连接测试：403 的 permission_error 不再被误报成认证失败', async (t) => {
  const upstream = await startServer((req, res) => {
    // OpenRouter 地区封锁的真实响应形状
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'permission_error',
          message: 'This model is not available in your region.',
          error_type: 'permission_denied',
        },
      })
    );
  });
  t.after(() => stopServer(upstream.server));

  const result = await testUpstream(profileFor(upstream.baseUrl));

  assert.equal(result.ok, false);
  // key 是好的，问题在那个模型；报成 auth_failed 会让用户去反复换 key
  assert.equal(result.kind, 'model_unavailable');
});

test('连接测试：403 但不是权限问题时仍然是认证失败', async (t) => {
  const upstream = await startServer((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end('{"error":{"type":"authentication_error","message":"invalid token"}}');
  });
  t.after(() => stopServer(upstream.server));

  const result = await testUpstream(profileFor(upstream.baseUrl));

  assert.equal(result.kind, 'auth_failed');
});

test('连接测试：第一条候选不可用时，自动改试下一条并测通', async (t) => {
  const seenModels = [];
  const upstream = await startServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const model = JSON.parse(Buffer.concat(chunks).toString('utf8')).model;
      seenModels.push(model);
      if (model === 'openai/gpt-5.4-image-2') {
        // 这条在用户所在地区被封锁 —— 但整份配置本身完全正确
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end('{"error":{"type":"permission_error","message":"not available in your region"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"content":[],"usage":{"input_tokens":1,"output_tokens":1}}');
    });
  });
  t.after(() => stopServer(upstream.server));

  const result = await testUpstream(
    profileFor(upstream.baseUrl, {
      modelMap: {
        'gpt-5.4-image-2': 'openai/gpt-5.4-image-2',
        'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
      },
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.probedModel, 'deepseek/deepseek-v4-pro');
  // 第一条确实试过、也确实失败了，然后才轮到第二条
  assert.deepEqual(seenModels, ['openai/gpt-5.4-image-2', 'deepseek/deepseek-v4-pro']);
});

test('连接测试：全部候选都失败时，逐条结论都被保留下来', async (t) => {
  const upstream = await startServer((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end('{"error":{"type":"permission_error","message":"not available in your region"}}');
  });
  t.after(() => stopServer(upstream.server));

  const result = await testUpstream(
    profileFor(upstream.baseUrl, { modelMap: { a: 'vendor/a', b: 'vendor/b' } })
  );

  assert.equal(result.ok, false);
  // 清一色是模型不可用 —— 结论就该落在模型上，而不是 key 上
  assert.equal(result.kind, 'model_unavailable');
  assert.deepEqual(result.tried, ['vendor/a', 'vendor/b']);
  assert.deepEqual(
    result.failures.map((f) => f.model),
    ['vendor/a', 'vendor/b']
  );
});

test('连接测试：混合失败时，认证问题优先于模型问题', async (t) => {
  const upstream = await startServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const model = JSON.parse(Buffer.concat(chunks).toString('utf8')).model;
      if (model === 'vendor/a') {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end('{"error":{"type":"permission_error","message":"region"}}');
        return;
      }
      // 另一个候选直说 key 不对 —— 这是全盘性问题，先让用户去查 key
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"invalid api key"}}');
    });
  });
  t.after(() => stopServer(upstream.server));

  const result = await testUpstream(
    profileFor(upstream.baseUrl, { modelMap: { a: 'vendor/a', b: 'vendor/b' } })
  );

  assert.equal(result.kind, 'auth_failed');
});

test('连接测试：两条规则指向同一个目标名时只探测一次', async (t) => {
  let requestCount = 0;
  const upstream = await startServer((req, res) => {
    req.on('data', () => {
      // 扔掉请求体即可
    });
    req.on('end', () => {
      requestCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"content":[]}');
    });
  });
  t.after(() => stopServer(upstream.server));

  await testUpstream(
    profileFor(upstream.baseUrl, { modelMap: { x: 'same/model', y: 'same/model' } })
  );

  assert.equal(requestCount, 1);
});

// ---------------------------------------------------------------------------
// 8. 本地准入凭证
//
// 代理监听在 127.0.0.1 上，但「本机」不等于「本用户」：同一台机器上的任何进程
// 都能连 127.0.0.1:8787，而代理原先刻意丢弃客户端凭证、无条件换成 profile.apiKey，
// 等于一个敞开的中转站 —— 别人可以借它白用用户的真实 key。
// ---------------------------------------------------------------------------

/** 测试用的本地准入凭证。 */
const LOCAL_TOKEN = 'a1b2c3d4'.repeat(8);

test('holdsLocalToken：Bearer 与 x-api-key 两种带法都认，其余一律拒绝', () => {
  const req = (headers) => ({ headers });

  assert.equal(holdsLocalToken(req({ authorization: `Bearer ${LOCAL_TOKEN}` }), LOCAL_TOKEN), true);
  assert.equal(holdsLocalToken(req({ authorization: `bearer ${LOCAL_TOKEN}` }), LOCAL_TOKEN), true);
  assert.equal(holdsLocalToken(req({ 'x-api-key': LOCAL_TOKEN }), LOCAL_TOKEN), true);

  assert.equal(holdsLocalToken(req({}), LOCAL_TOKEN), false);
  assert.equal(holdsLocalToken(req({ authorization: 'Bearer 别的值' }), LOCAL_TOKEN), false);
  assert.equal(holdsLocalToken(req({ 'x-api-key': '别的值' }), LOCAL_TOKEN), false);
  // 少了 Bearer 前缀就不是一个合法的 Authorization 头
  assert.equal(holdsLocalToken(req({ authorization: LOCAL_TOKEN }), LOCAL_TOKEN), false);
  // 空值绝不能等同于「放行」
  assert.equal(holdsLocalToken(req({ 'x-api-key': '' }), LOCAL_TOKEN), false);
  assert.equal(holdsLocalToken(req({ authorization: 'Bearer ' }), LOCAL_TOKEN), false);
});

test('准入：没带凭证的请求被 401 挡下，且根本不会消耗用户的真实 key', async (t) => {
  let upstreamHits = 0;
  const upstream = await startServer((req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"content":[]}');
  });

  const proxy = createProxy({
    getActiveProfile: () => profileFor(upstream.baseUrl),
    getLocalToken: () => LOCAL_TOKEN,
    port: 0,
  });
  const proxyPort = await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await stopServer(upstream.server);
  });

  const denied = await requestThroughProxy(`http://127.0.0.1:${proxyPort}`);

  assert.equal(denied.status, 401);
  assert.match(denied.body, /unauthorized/);
  // 这一条才是要点：被挡下的请求一次上游都没打过去
  assert.equal(upstreamHits, 0);
});

test('准入：带上正确凭证即放行，且发往上游的仍是 profile 里的真实 key', async (t) => {
  let seenAuth = null;
  const upstream = await startServer((req, res) => {
    seenAuth = req.headers['x-api-key'] || req.headers.authorization || null;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"content":[]}');
  });

  const proxy = createProxy({
    getActiveProfile: () => profileFor(upstream.baseUrl),
    getLocalToken: () => LOCAL_TOKEN,
    port: 0,
  });
  const proxyPort = await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await stopServer(upstream.server);
  });

  for (const headers of [
    { authorization: `Bearer ${LOCAL_TOKEN}` },
    { 'x-api-key': LOCAL_TOKEN },
  ]) {
    const ok = await requestThroughProxy(`http://127.0.0.1:${proxyPort}`, { headers });
    assert.equal(ok.status, 200);
  }

  // 准入凭证只是门票：它绝不能代替真实 key 被转发出去。
  // 否则「改用随机凭证」就退化成了换个名字的公开常量。
  assert.notEqual(seenAuth, LOCAL_TOKEN);
  assert.match(seenAuth, /sk-real-key-from-profile/);
});

test('准入：未配置凭证时不校验（测试与旧行为兼容）', async (t) => {
  const upstream = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"content":[]}');
  });

  const proxy = createProxy({ getActiveProfile: () => profileFor(upstream.baseUrl), port: 0 });
  const proxyPort = await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await stopServer(upstream.server);
  });

  const result = await requestThroughProxy(`http://127.0.0.1:${proxyPort}`);
  assert.equal(result.status, 200);
});

// ---------------------------------------------------------------------------
// 9. 生命周期：起不来要能重试，关得掉要有时限
// ---------------------------------------------------------------------------

test('读取供应商配置抛错时返回 500 config_unreadable，而不是让主进程崩掉', async (t) => {
  const proxy = createProxy({
    getActiveProfile: () => {
      throw new Error('配置文件损坏，无法解析');
    },
    port: 0,
  });
  const proxyPort = await proxy.start();
  t.after(() => proxy.stop());

  const result = await requestThroughProxy(`http://127.0.0.1:${proxyPort}`);

  // 这个异常若穿透 http 监听器，会变成主进程的未捕获异常 ——
  // 整个应用连同代理一起消失，而客户端只看到连接被重置
  assert.equal(result.status, 500);
  assert.match(result.body, /config_unreadable/);
  assert.match(result.body, /配置文件损坏/);
});

test('启动失败后状态被清空，再次 start() 仍会真的重试而不是静默返回 null', async () => {
  // 192.0.2.0/24 是 TEST-NET-1，本机不可能绑定成功
  const proxy = createProxy({ getActiveProfile: () => null, host: '192.0.2.1', port: 8787 });

  await assert.rejects(() => proxy.start());
  assert.equal(proxy.port, null);
  assert.equal(proxy.baseUrl, null);

  // 关键回归点：失败时若不把 server 清回去，第二次 start() 会命中
  // `if (server) return actualPort` 直接返回 null —— 不报错也不重试，
  // 界面上那个「重试」按钮于是点不动
  await assert.rejects(() => proxy.start());
});

test('停止代理：有连接挂着时也在超时内返回，不会把退出流程拖死', async (t) => {
  // 一个永不响应的上游，用来制造一条挂住的长连接
  const upstream = await startServer(() => {
    // 故意不响应
  });
  t.after(async () => {
    upstream.server.closeAllConnections?.();
    await stopServer(upstream.server);
  });

  const proxy = createProxy({ getActiveProfile: () => profileFor(upstream.baseUrl), port: 0 });
  const proxyPort = await proxy.start();

  const hanging = http.request({
    hostname: '127.0.0.1',
    port: proxyPort,
    path: '/v1/messages',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    agent: false,
  });
  hanging.on('error', () => {
    // 被 closeAllConnections 掐断是预期结果
  });
  hanging.end('{}');
  await new Promise((resolve) => setTimeout(resolve, 120));

  const startedAt = Date.now();
  await proxy.stop({ timeoutMs: 200 });
  const elapsed = Date.now() - startedAt;

  // server.close() 要等所有连接结束才回调，而转发路径没有超时 ——
  // 没有这个上界的话，退出流程会 await 到天荒地老
  assert.ok(elapsed < 1500, `stop() 应在超时附近返回，实际用了 ${elapsed}ms`);
  assert.equal(proxy.port, null);
  assert.equal(proxy.baseUrl, null);
  hanging.destroy();
});

test('停止后再启动：能重新监听（退出流程与重试共用同一条路径）', async (t) => {
  const proxy = createProxy({ getActiveProfile: () => null, port: 0 });

  const first = await proxy.start();
  await proxy.stop();
  assert.equal(proxy.port, null);

  const second = await proxy.start();
  t.after(() => proxy.stop());

  assert.ok(second > 0, '停止后必须能重新启动');
  assert.equal(proxy.baseUrl, `http://127.0.0.1:${second}`);
  assert.notEqual(first, undefined);
});
