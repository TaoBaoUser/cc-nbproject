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

const { createProxy, testUpstream, createUsageExtractor } = require('../src/main/proxy.js');

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
function requestThroughProxy(baseUrl, { path = '/v1/messages', method = 'POST', body = '{}', headers = {} } = {}) {
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
  return { id: 'p1', name: '测试供应商', baseUrl, apiKey: 'sk-real-key-from-profile', ...overrides };
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
