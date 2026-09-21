'use strict';

/**
 * 代理支持的单元测试。
 *
 * 背景：Node 的 http/https 模块不读系统代理，主进程的请求一律直连。
 * 在需要代理才能访问上游的地区，这会让应用表现成「连不上」，而用户明明开着代理。
 *
 * 这里覆盖两类东西：
 *   1. 纯逻辑 —— 哪些地址不该走代理、代理串怎么解析、优先级怎么排
 *   2. 真的建连 —— 用本机假代理验证 CONNECT 隧道与明文转发确实按协议发出去了
 *
 * 唯一的空白：TLS 握手本身没有在单测里假造（需要自签证书）。那条路径由
 * 真 Electron + 真实上游的端到端验证覆盖，比环回自签更有说服力。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const https = require('https');

const {
  getAgent,
  proxyInfo,
  describeProxyError,
  isLocalHost,
  normalizeProxyUrl,
  fromEnv,
  isBypassed,
  HttpOverProxyAgent,
  HttpsOverProxyAgent,
  HttpsOverProxyAgent: _HttpsAgent,
  __reset,
  __setDetectorForTest,
  __setOverrideForTest,
} = require('../src/main/proxy-agent.js');

/** 起一个假代理。CONNECT 与明文绝对 URI 两种请求都会记进 connects。 */
function startFakeProxy({ connectStatus = 200 } = {}) {
  return new Promise((resolve) => {
    const connects = [];
    const plain = [];
    const server = http.createServer((req, res) => {
      plain.push({ method: req.method, url: req.url, headers: req.headers });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('plain-via-proxy');
    });
    server.on('connect', (req, clientSocket) => {
      connects.push({ url: req.url, headers: req.headers });
      if (connectStatus !== 200) {
        clientSocket.write(`HTTP/1.1 ${connectStatus} Forbidden\r\n\r\n`);
        clientSocket.destroy();
        return;
      }
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      // 不接管后续 TLS，直接断开 —— 本测试只关心 CONNECT 本身发得对不对
      setImmediate(() => clientSocket.destroy());
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, connects, plain, port: server.address().port });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

/** 临时设置环境变量，返回恢复函数。 */
function withEnv(vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

const PROXY_ENV_KEYS = ['CCNB_PROXY', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'];
const NO_PROXY_KEYS = ['CCNB_NO_PROXY', 'NO_PROXY', 'no_proxy'];

function clearProxyEnv() {
  return withEnv(Object.fromEntries([...PROXY_ENV_KEYS, ...NO_PROXY_KEYS].map((k) => [k, undefined])));
}

// ---------------------------------------------------------------- 哪些地址不该走代理

test('本地与内网地址一律直连', () => {
  for (const h of [
    'localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '0.0.0.0',
    '10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.1.1',
    'fc00::1', 'fd12:3456::1', 'printer.local', 'foo.localhost',
  ]) {
    assert.equal(isLocalHost(h), true, `${h} 应当直连`);
  }
  for (const h of [
    'openrouter.ai', 'api.deepseek.com', '8.8.8.8', '172.32.0.1', '172.15.0.1',
    'notlocal.com', 'local.example.com', '203.0.113.9',
  ]) {
    assert.equal(isLocalHost(h), false, `${h} 应当走代理`);
  }
});

test('172.16-172.31 是内网，172.32 不是', () => {
  // 这条边界最容易写错：区间是 172.16.0.0/12，不是整个 172/8
  assert.equal(isLocalHost('172.15.255.255'), false);
  assert.equal(isLocalHost('172.16.0.0'), true);
  assert.equal(isLocalHost('172.31.255.255'), true);
  assert.equal(isLocalHost('172.32.0.0'), false);
});

// ---------------------------------------------------------------- 代理串解析

test('代理串解析：补全协议、拒绝无法支持的协议', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeProxyUrl('https://proxy.example.com:8443'), 'https://proxy.example.com:8443');
  assert.equal(normalizeProxyUrl('  http://127.0.0.1:7890  '), 'http://127.0.0.1:7890');
  // socks 需要额外握手实现 —— 返回 null 让它显式不被支持，而不是被当成直连悄悄放过去
  assert.equal(normalizeProxyUrl('socks5://127.0.0.1:7890'), null);
  assert.equal(normalizeProxyUrl('socks4://127.0.0.1:7890'), null);
  // 没端口就没法连
  assert.equal(normalizeProxyUrl('http://127.0.0.1'), null);
  assert.equal(normalizeProxyUrl(''), null);
  assert.equal(normalizeProxyUrl(null), null);
  assert.equal(normalizeProxyUrl(':::不是地址:::'), null);
});

test('环境变量读取：CCNB_PROXY 优先于通用变量', () => {
  const restore = withEnv({
    CCNB_PROXY: 'http://127.0.0.1:1111',
    HTTPS_PROXY: 'http://127.0.0.1:2222',
    ALL_PROXY: 'http://127.0.0.1:3333',
  });
  try {
    assert.deepEqual(fromEnv(), { url: 'http://127.0.0.1:1111', source: 'env' });
  } finally {
    restore();
  }

  const restore2 = withEnv({ CCNB_PROXY: undefined, HTTPS_PROXY: undefined, https_proxy: undefined, ALL_PROXY: 'http://127.0.0.1:3333', all_proxy: undefined, HTTP_PROXY: undefined, http_proxy: undefined });
  try {
    assert.deepEqual(fromEnv(), { url: 'http://127.0.0.1:3333', source: 'env' });
  } finally {
    restore2();
  }

  const restore3 = withEnv(Object.fromEntries(PROXY_ENV_KEYS.map((k) => [k, undefined])));
  try {
    assert.equal(fromEnv(), null);
  } finally {
    restore3();
  }
});

// ---------------------------------------------------------------- NO_PROXY

test('NO_PROXY 命中的目标直连；* 表示全部直连', () => {
  const restore = clearProxyEnv();
  try {
    process.env.NO_PROXY = 'example.com,internal.corp';
    const proxy = { url: 'http://127.0.0.1:7890' };
    assert.equal(isBypassed('example.com', proxy), true);
    assert.equal(isBypassed('sub.example.com', proxy), true, '子域也算命中');
    assert.equal(isBypassed('internal.corp', proxy), true);
    assert.equal(isBypassed('notexample.com', proxy), false, '不能只是后缀相同');
    assert.equal(isBypassed('openrouter.ai', proxy), false);

    process.env.NO_PROXY = '*';
    assert.equal(isBypassed('openrouter.ai', proxy), true);
  } finally {
    restore();
  }
});

test('系统例外清单（scutil 的 ExceptionsList）也参与直连判断', () => {
  const restore = clearProxyEnv();
  try {
    const proxy = { url: 'http://127.0.0.1:7890', exceptions: ['timestamp.apple.com', '*.local'] };
    assert.equal(isBypassed('timestamp.apple.com', proxy), true);
    assert.equal(isBypassed('openrouter.ai', proxy), false);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------- getAgent 的组合逻辑

test('getAgent：没代理时返回 undefined（走 Node 默认直连）', () => {
  const restore = clearProxyEnv();
  try {
    __reset();
    // 用注入的探测函数固定住「没有代理」，不受跑测试这台机器的真实设置影响
    __setDetectorForTest(() => null);
    assert.equal(getAgent('openrouter.ai', true), undefined);
    assert.deepEqual(proxyInfo(), { enabled: false, url: null, source: null });
  } finally {
    __reset();
    restore();
  }
});

test('getAgent：有代理时远端返回 agent，本地返回 undefined', () => {
  const restore = clearProxyEnv();
  try {
    __setDetectorForTest(() => ({ url: 'http://127.0.0.1:7890', source: 'system' }));
    assert.ok(getAgent('openrouter.ai', true) instanceof https.Agent);
    assert.ok(getAgent('api.deepseek.com', false) instanceof http.Agent);
    // 本地地址即便配了代理也必须直连 —— 否则本地供应商和测试用的假上游全废
    assert.equal(getAgent('127.0.0.1', false), undefined);
    assert.equal(getAgent('localhost', true), undefined);
    assert.deepEqual(proxyInfo(), { enabled: true, url: 'http://127.0.0.1:7890', source: 'system' });
  } finally {
    __reset();
    restore();
  }
});

test('getAgent：同一个代理只建一个 agent（连接可复用）', () => {
  const restore = clearProxyEnv();
  try {
    __setDetectorForTest(() => ({ url: 'http://127.0.0.1:7890', source: 'system' }));
    assert.equal(getAgent('openrouter.ai', true), getAgent('api.openai.com', true));
    // 不同协议栈不能混用
    assert.notEqual(getAgent('openrouter.ai', true), getAgent('openrouter.ai', false));
  } finally {
    __reset();
    restore();
  }
});

// ---------------------------------------------------------------- 真的建连

test('明文 http 目标经代理：request line 必须是绝对 URI', async () => {
  const fake = await startFakeProxy();
  try {
    const agent = new HttpOverProxyAgent(`http://user:pw@127.0.0.1:${fake.port}`);
    const body = await new Promise((resolve, reject) => {
      const req = http.request(
        { protocol: 'http:', hostname: 'example.invalid', port: 80, path: '/hello?x=1', method: 'GET', agent },
        (res) => {
          let t = '';
          res.on('data', (d) => (t += d));
          res.on('end', () => resolve(t));
        }
      );
      req.on('error', reject);
      req.end();
    });

    assert.equal(body, 'plain-via-proxy');
    assert.equal(fake.plain.length, 1);
    assert.equal(fake.plain[0].url, 'http://example.invalid/hello?x=1');
    assert.equal(fake.plain[0].headers.host, 'example.invalid');
    assert.equal(
      fake.plain[0].headers['proxy-authorization'],
      `Basic ${Buffer.from('user:pw').toString('base64')}`,
      '代理认证要带上'
    );
  } finally {
    await stopServer(fake.server);
  }
});

test('https 目标经代理：先 CONNECT 到目标 host:port', async () => {
  const fake = await startFakeProxy();
  try {
    const agent = new HttpsOverProxyAgent(`http://127.0.0.1:${fake.port}`);
    await new Promise((resolve) => {
      const req = https.request(
        { hostname: 'blocked.example.com', port: 443, path: '/', method: 'GET', agent },
        () => resolve()
      );
      // 假代理在 CONNECT 之后立刻断开，TLS 必然失败 —— 这里只关心 CONNECT 发对了
      req.on('error', () => resolve());
      req.end();
    });

    assert.equal(fake.connects.length, 1, '应当发出一次 CONNECT');
    assert.equal(fake.connects[0].url, 'blocked.example.com:443');
  } finally {
    await stopServer(fake.server);
  }
});

test('https 目标经代理：非 443 端口要如实写进 CONNECT', async () => {
  const fake = await startFakeProxy();
  try {
    const agent = new HttpsOverProxyAgent(`http://127.0.0.1:${fake.port}`);
    await new Promise((resolve) => {
      const req = https.request(
        { hostname: 'api.example.com', port: 8443, path: '/', method: 'GET', agent },
        () => resolve()
      );
      req.on('error', () => resolve());
      req.end();
    });
    assert.equal(fake.connects[0].url, 'api.example.com:8443');
  } finally {
    await stopServer(fake.server);
  }
});

test('代理拒绝建隧道时，错误要能认出是代理的问题', async () => {
  const fake = await startFakeProxy({ connectStatus: 403 });
  try {
    const agent = new HttpsOverProxyAgent(`http://127.0.0.1:${fake.port}`);
    const err = await new Promise((resolve) => {
      const req = https.request(
        { hostname: 'blocked.example.com', port: 443, path: '/', method: 'GET', agent },
        () => resolve(null)
      );
      req.on('error', resolve);
      req.end();
    });

    assert.ok(err, '应当报错');
    assert.equal(err.isProxyError, true, '要标记成代理错误，否则用户会去查 baseUrl 和 key');
    assert.equal(err.proxyStage, 'reject');
    const text = describeProxyError(err);
    assert.match(text, /拒绝建立隧道（HTTP 403）/);
    assert.match(text, /放行规则/, '代理被拒 ≠ 代理没开，建议不能给错');
    assert.doesNotMatch(text, /代理没有在运行/);
  } finally {
    await stopServer(fake.server);
  }
});

test('代理没开时：ECONNREFUSED 且错误指向代理', async () => {
  // 挑一个几乎不可能有人监听的端口
  const agent = new HttpsOverProxyAgent('http://127.0.0.1:1');
  const err = await new Promise((resolve) => {
    const req = https.request(
      { hostname: 'blocked.example.com', port: 443, path: '/', method: 'GET', agent },
      () => resolve(null)
    );
    req.on('error', resolve);
    req.end();
  });

  assert.ok(err);
  assert.equal(err.isProxyError, true);
  const text = describeProxyError(err);
  assert.match(text, /代理没有在运行/);
  assert.match(text, /CCNB_PROXY/, '要告诉用户还有手动指定这条路');
});

test('describeProxyError 对非代理错误返回 null（不能把普通网络错误说成代理问题）', () => {
  assert.equal(describeProxyError(new Error('socket hang up')), null);
  assert.equal(describeProxyError(null), null);
  assert.equal(describeProxyError({ code: 'ECONNREFUSED' }), null);
});

test('手动指定的代理优先于自动探测', () => {
  const restore = clearProxyEnv();
  try {
    __setDetectorForTest(() => ({ url: 'http://127.0.0.1:7890', source: 'system' }));
    __setOverrideForTest('http://127.0.0.1:9999');
    assert.deepEqual(proxyInfo(), { enabled: true, url: 'http://127.0.0.1:9999', source: 'manual' });

    __setOverrideForTest(null); // 显式直连
    assert.deepEqual(proxyInfo(), { enabled: false, url: null, source: null });
  } finally {
    __reset();
    restore();
  }
});

// 保持导入被使用（HttpsOverProxyAgent 在本文件里通过别名引用了一次）
void _HttpsAgent;
