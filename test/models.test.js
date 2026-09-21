'use strict';

/**
 * 模型列表拉取的单元测试。
 *
 * 这个功能的价值全在**边界**上：接口可能不存在、可能返回非 JSON、
 * 可能返回一堆用不上的形状。正常路径（OpenRouter 返回 200）反而是最不需要测的 ——
 * 真正决定用户体验的是"拉不到时会发生什么"。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { requestModels, createModelFetcher, normalizeModels } = require('../src/main/models.js');

/** 起一个假的供应商端点。handler 收到 (req, res)，并可通过 req.seenPath 读到请求路径。 */
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

// ---------------------------------------------------------------------------
// 1. 响应形状的容错
// ---------------------------------------------------------------------------

test('normalizeModels：容忍三种响应形状', () => {
  const expected = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ];

  // OpenAI / OpenRouter
  assert.deepEqual(
    normalizeModels({
      data: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
    }),
    expected
  );
  // 部分 Anthropic 兼容实现
  assert.deepEqual(
    normalizeModels({
      models: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
    }),
    expected
  );
  // 直接给数组
  assert.deepEqual(
    normalizeModels([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ]),
    expected
  );
});

test('normalizeModels：字符串数组、缺 name、缺 id 都能应付', () => {
  assert.deepEqual(normalizeModels(['a', 'b']), [
    { id: 'a', name: 'a' },
    { id: 'b', name: 'b' },
  ]);
  // 没有 name 就用 id 顶上，不要让 UI 出现空白选项
  assert.deepEqual(normalizeModels([{ id: 'a' }]), [{ id: 'a', name: 'a' }]);
  // 没有 id 的条目直接丢弃
  assert.deepEqual(normalizeModels([{ name: '无 id' }, { id: 'b' }]), [{ id: 'b', name: 'b' }]);
});

test('normalizeModels：认不出来的形状返回空数组而不是抛错', () => {
  assert.deepEqual(normalizeModels(null), []);
  assert.deepEqual(normalizeModels({}), []);
  assert.deepEqual(normalizeModels({ result: 'ok' }), []);
  assert.deepEqual(normalizeModels('一段文本'), []);
});

// ---------------------------------------------------------------------------
// 2. 失败分类 —— 每种对应完全不同的用户操作
// ---------------------------------------------------------------------------

test('拉取：成功时返回模型列表', async (t) => {
  const upstream = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[{"id":"vendor/model-a","name":"Model A"}]}');
  });
  t.after(() => stopServer(upstream.server));

  const result = await requestModels({ baseUrl: upstream.baseUrl });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models, [{ id: 'vendor/model-a', name: 'Model A' }]);
});

test('拉取：404 归为 unsupported，而不是当成错误', async (t) => {
  // 这正是 DeepSeek 的真实行为 —— 它没有 /v1/models 接口。
  // 归类为 unsupported 才能让 UI 说"请手动填写"，而不是弹一个吓人的错误。
  const upstream = await startServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"not found"}}');
  });
  t.after(() => stopServer(upstream.server));

  const result = await requestModels({ baseUrl: upstream.baseUrl });

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'unsupported');
});

test('拉取：401 归为 auth_failed', async (t) => {
  const upstream = await startServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"invalid api key"}}');
  });
  t.after(() => stopServer(upstream.server));

  const result = await requestModels({ baseUrl: upstream.baseUrl, apiKey: 'sk-bad' });

  assert.equal(result.kind, 'auth_failed');
});

test('拉取：200 但不是 JSON，同样归为 unsupported', async (t) => {
  // 有些网关会把未知路径回落到一个 HTML 首页，状态码却是 200
  const upstream = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html>Welcome</html>');
  });
  t.after(() => stopServer(upstream.server));

  const result = await requestModels({ baseUrl: upstream.baseUrl });

  assert.equal(result.kind, 'unsupported');
});

test('拉取：接口有响应但列表为空时归为 empty', async (t) => {
  const upstream = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[]}');
  });
  t.after(() => stopServer(upstream.server));

  const result = await requestModels({ baseUrl: upstream.baseUrl });

  assert.equal(result.kind, 'empty');
});

test('拉取：网络不可达归为 network_error', async () => {
  const result = await requestModels({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 3000 });

  assert.equal(result.kind, 'network_error');
});

test('拉取：baseUrl 非法归为 invalid_url，而不是崩掉', async () => {
  const result = await requestModels({ baseUrl: '这不是一个 URL' });

  assert.equal(result.kind, 'invalid_url');
});

// ---------------------------------------------------------------------------
// 3. 请求本身 —— 路径与鉴权
// ---------------------------------------------------------------------------

test('拉取：baseUrl 带路径前缀时，请求路径正确拼接', async (t) => {
  let seenPath = null;
  const upstream = await startServer((req, res) => {
    seenPath = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[{"id":"m"}]}');
  });
  t.after(() => stopServer(upstream.server));

  // 这正是 OpenRouter 的形状：https://openrouter.ai/api
  await requestModels({ baseUrl: `${upstream.baseUrl}/api` });

  assert.equal(seenPath, '/api/v1/models');
});

test('拉取：带上 profile 的凭证，且两种鉴权头都给', async (t) => {
  let seen = null;
  const upstream = await startServer((req, res) => {
    seen = { auth: req.headers.authorization, key: req.headers['x-api-key'] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[{"id":"m"}]}');
  });
  t.after(() => stopServer(upstream.server));

  await requestModels({ baseUrl: upstream.baseUrl, apiKey: 'sk-test' });

  assert.equal(seen.auth, 'Bearer sk-test');
  assert.equal(seen.key, 'sk-test');
});

// ---------------------------------------------------------------------------
// 4. 缓存 —— 446 个模型有 738KB，每次开编辑框都重下没道理
// ---------------------------------------------------------------------------

test('缓存：第二次拉取命中缓存，不再打到上游', async (t) => {
  let hits = 0;
  const upstream = await startServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[{"id":"m"}]}');
  });
  t.after(() => stopServer(upstream.server));

  const fetcher = createModelFetcher();
  const first = await fetcher.fetchModels({ baseUrl: upstream.baseUrl });
  const second = await fetcher.fetchModels({ baseUrl: upstream.baseUrl });

  assert.equal(hits, 1, '第二次不应再请求上游');
  assert.equal(first.cached, undefined);
  assert.equal(second.cached, true);
  assert.deepEqual(second.models, first.models);
});

test('缓存：force 可以绕过缓存强制重拉', async (t) => {
  let hits = 0;
  const upstream = await startServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[{"id":"m"}]}');
  });
  t.after(() => stopServer(upstream.server));

  const fetcher = createModelFetcher();
  await fetcher.fetchModels({ baseUrl: upstream.baseUrl });
  await fetcher.fetchModels({ baseUrl: upstream.baseUrl, force: true });

  assert.equal(hits, 2);
});

test('缓存：失败结果不被缓存 —— 改完 key 重试必须真的重试', async (t) => {
  // 若把失败也缓存起来，用户填好 API key 再点一次，拿到的还是上一次的
  // auth_failed，会以为改了没用，陷入死循环。
  let hits = 0;
  const upstream = await startServer((req, res) => {
    hits += 1;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"invalid api key"}}');
  });
  t.after(() => stopServer(upstream.server));

  const fetcher = createModelFetcher();
  await fetcher.fetchModels({ baseUrl: upstream.baseUrl, apiKey: 'sk-a' });
  await fetcher.fetchModels({ baseUrl: upstream.baseUrl, apiKey: 'sk-a' });

  assert.equal(hits, 2);
  assert.equal(fetcher.size, 0, '失败的结果不该进缓存');
});

test('缓存：换了 API key 不会命中另一个 key 的缓存', async (t) => {
  let hits = 0;
  const upstream = await startServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[{"id":"m"}]}');
  });
  t.after(() => stopServer(upstream.server));

  const fetcher = createModelFetcher();
  await fetcher.fetchModels({ baseUrl: upstream.baseUrl, apiKey: 'sk-aaaaaaaa' });
  await fetcher.fetchModels({ baseUrl: upstream.baseUrl, apiKey: 'sk-bbbbbbbb' });

  // 不同 key 能看到的模型范围可能不同，只按 baseUrl 缓存会给出过期结果
  assert.equal(hits, 2);
});
