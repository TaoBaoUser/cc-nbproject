'use strict';

// 让主进程发出的上游请求走系统代理。
//
// 为什么需要它：Node 的 http/https 模块既不读 macOS 的「网络」设置，也不读
// HTTPS_PROXY 环境变量（除非显式开启），所以主进程的请求永远直连。当上游
// 按来源地区做限制时（例如 OpenRouter 的 openai/* 一族模型），直连会被直接
// 拒绝，而用户明明开着代理 —— 应用里表现成「连不上」，很难自查。

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { execFileSync } = require('child_process');

// 系统代理可能被随时打开或关掉，探测结果缓存一小段时间即可，
// 既不会每次请求都去起一个 scutil 子进程，也不会永远停在启动时的答案上。
const DETECT_TTL_MS = 60_000;

// 连代理本身的超时。只用于建立 CONNECT 隧道这一段，隧道一通就撤掉，
// 避免长回答（模型思考时长时间无数据）被误判成超时。
const CONNECT_TIMEOUT_MS = 15_000;

/** 本地回环与内网地址永远直连 —— 把它们交给代理是错的。 */
function isLocalHost(hostname) {
  if (!hostname) return false;
  const h = String(hostname)
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  // .local 是 mDNS 局域网域名；.localhost 按 RFC 6761 也指向本机
  if (h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // 链路本地
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // IPv6 唯一本地地址 fc00::/7
  return false;
}

/** 把用户/系统给出的代理串规整成 URL；不认识的协议返回 null。 */
function normalizeProxyUrl(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!u.hostname || !u.port) return null;
  // socks 需要额外实现握手，这里不接 —— 宁可明确不支持，也不要悄悄直连
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  return `${u.protocol}//${u.host}`;
}

function proxyAuthHeader(proxyUrl) {
  const u = new URL(proxyUrl);
  if (!u.username) return {};
  const raw = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
  return { 'proxy-authorization': `Basic ${Buffer.from(raw).toString('base64')}` };
}

function readEnv(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim()) return String(v).trim();
  }
  return null;
}

// 环境变量里代理只认这几个字段，其余（如 NO_PROXY 命中）交给 isBypassed 判断
function fromEnv() {
  const raw = readEnv(
    'CCNB_PROXY',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
    'HTTP_PROXY',
    'http_proxy'
  );
  const url = normalizeProxyUrl(raw);
  if (!url) return null;
  return { url, source: 'env' };
}

// macOS：系统「网络 → 代理」的设置。scutil 的输出是稳定可解析的。
function fromScutil() {
  let out;
  try {
    out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 });
  } catch {
    return null;
  }
  const on = /HTTPS?Enable\s*:\s*1/.test(out);
  const host = (out.match(/\bHTTPSProxy\s*:\s*(\S+)/) ||
    out.match(/\bHTTPProxy\s*:\s*(\S+)/) ||
    [])[1];
  const port = (out.match(/\bHTTPSPort\s*:\s*(\d+)/) ||
    out.match(/\bHTTPPort\s*:\s*(\d+)/) ||
    [])[1];
  if (!on || !host || !port) return null;
  const url = normalizeProxyUrl(`${host}:${port}`);
  if (!url) return null;

  // 系统自己的例外清单也照单收下，省得去代理打内网地址
  const exceptions = [];
  const re = /^\s*\d+\s*:\s*(\S+)\s*$/gm;
  let m;
  while ((m = re.exec(out))) exceptions.push(m[1]);

  return { url, source: 'system', exceptions };
}

function detect() {
  return fromEnv() || (process.platform === 'darwin' ? fromScutil() : null);
}

let detectorOverride = null;
let cached = null; // { at, value }
let override; // undefined=未干预；null=强制直连；字符串=手动指定

// 探测入口留一层间接，测试可以整段替换掉，不去碰真实的 scutil / 环境变量
function detectEffective() {
  return detectorOverride ? detectorOverride() : detect();
}

/** 返回当前应当使用的代理，没有则返回 null。 */
function current() {
  if (override !== undefined) {
    return override === null ? null : { url: override, source: 'manual' };
  }
  const now = Date.now();
  if (cached && now - cached.at < DETECT_TTL_MS) return cached.value;
  const value = detectEffective();
  cached = { at: now, value };
  return value;
}

/** 命中了 NO_PROXY / 系统例外清单？ */
function isBypassed(hostname, proxy) {
  const h = String(hostname || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (!h) return false;
  const lists = [
    readEnv('CCNB_NO_PROXY', 'NO_PROXY', 'no_proxy'),
    ((proxy && proxy.exceptions) || []).join(','),
  ];
  const patterns = lists
    .filter(Boolean)
    .join(',')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (patterns.includes('*')) return true;
  return patterns.some((p) => {
    const bare = p.replace(/^\./, '').replace(/:\d+$/, '');
    // 形如 192.168.0.0/16 的网段交给 isLocalHost 处理，这里只做域名后缀匹配
    if (bare.includes('/')) return false;
    return h === bare || h.endsWith(`.${bare}`);
  });
}

/** 明文 http 目标经代理：把 request line 换成绝对 URI，连接指向代理。 */
class HttpOverProxyAgent extends http.Agent {
  constructor(proxyUrl, opts) {
    super({ keepAlive: true, ...opts });
    this.proxyUrl = proxyUrl;
    this.proxy = new URL(proxyUrl);
    this.authHeaders = proxyAuthHeader(proxyUrl);
  }

  createConnection(options, callback) {
    const port = Number(this.proxy.port) || (this.proxy.protocol === 'https:' ? 443 : 80);
    let socket;
    if (this.proxy.protocol === 'https:') {
      // 代理本身也走 TLS（少见，但得支持）
      socket = tls.connect(
        { host: this.proxy.hostname, port, servername: this.proxy.hostname },
        () => callback(null, socket)
      );
    } else {
      socket = net.connect({ host: this.proxy.hostname, port }, () => callback(null, socket));
    }
    socket.once('error', (err) => callback(markProxyError(err, this.proxyUrl)));
  }

  addRequest(req, options) {
    // 明文目标走代理时，request line 必须是绝对 URI（RFC 7230 5.3.2）
    if (typeof options.path === 'string' && !/^https?:\/\//i.test(options.path)) {
      options.path = `${options.protocol}//${options.host}${options.path}`;
      req.path = options.path;
    }
    // Node 各版本 options 里未必带 headers，直接设在 request 上最稳
    const auth = this.authHeaders['proxy-authorization'];
    if (auth && !req.getHeader('proxy-authorization')) {
      req.setHeader('Proxy-Authorization', auth);
    }
    super.addRequest(req, options);
  }
}

/** https 目标经代理：先 CONNECT 打隧道，再在隧道上做 TLS。 */
class HttpsOverProxyAgent extends https.Agent {
  constructor(proxyUrl, opts) {
    super({ keepAlive: true, ...opts });
    this.proxyUrl = proxyUrl;
    this.proxy = new URL(proxyUrl);
    this.authHeaders = proxyAuthHeader(proxyUrl);
  }

  createConnection(options, callback) {
    const host = options.host || options.hostname;
    const port = options.port || 443;
    const authority = `${host}:${port}`;
    const isTlsProxy = this.proxy.protocol === 'https:';
    const transport = isTlsProxy ? https : http;

    const connectReq = transport.request({
      host: this.proxy.hostname,
      port: Number(this.proxy.port) || (isTlsProxy ? 443 : 80),
      method: 'CONNECT',
      path: authority,
      headers: { host: authority, ...this.authHeaders },
    });

    connectReq.setTimeout(CONNECT_TIMEOUT_MS, () => {
      connectReq.destroy(new Error(`连接超时（${CONNECT_TIMEOUT_MS}ms 内没建好隧道）`));
    });

    connectReq.once('connect', (res, socket) => {
      socket.setTimeout(0); // 隧道已建立，后续超时交给调用方
      if (res.statusCode !== 200) {
        socket.destroy();
        return callback(
          markProxyError(
            new Error(`拒绝建立隧道（HTTP ${res.statusCode}）`),
            this.proxyUrl,
            'reject'
          )
        );
      }
      // 只挑 TLS 认识的那几个键传下去 —— options 里还带着 path、headers 等
      // http 专用字段，整个丢给 tls.connect 会把 path 当成 unix socket 路径。
      const tlsSocket = tls.connect(
        { ...pickTlsOptions(options), socket, servername: options.servername || host },
        () => callback(null, tlsSocket)
      );
      tlsSocket.once('error', (err) => callback(err));
    });

    connectReq.once('error', (err) => callback(markProxyError(err, this.proxyUrl, 'connect')));
    connectReq.end();
  }
}

const TLS_OPTION_KEYS = [
  'ca',
  'cert',
  'key',
  'pfx',
  'passphrase',
  'rejectUnauthorized',
  'servername',
  'minVersion',
  'maxVersion',
  'ciphers',
  'secureProtocol',
  'ALPNProtocols',
  'checkServerIdentity',
  'crl',
  'dhparam',
  'ecdhCurve',
  'honorCipherOrder',
  'sessionIdContext',
  'sigalgs',
  'secureContext',
];

function pickTlsOptions(options) {
  const out = {};
  for (const k of TLS_OPTION_KEYS) {
    if (options[k] !== undefined) out[k] = options[k];
  }
  return out;
}

function markProxyError(err, proxyUrl, stage) {
  err.isProxyError = true;
  err.proxyUrl = proxyUrl;
  err.proxyStage = stage; // 'connect' = 连不上代理；'reject' = 代理明确拒绝
  return err;
}

const agentCache = new Map();

function agentFor(proxyUrl, isTls) {
  const key = `${isTls ? 'https' : 'http'}|${proxyUrl}`;
  let agent = agentCache.get(key);
  if (!agent) {
    agent = isTls ? new HttpsOverProxyAgent(proxyUrl) : new HttpOverProxyAgent(proxyUrl);
    agentCache.set(key, agent);
  }
  return agent;
}

/**
 * 取该目标应当使用的 agent。返回 undefined 表示走 Node 默认行为（直连）。
 * 直接把这个值塞进 request 的 options.agent 即可。
 */
function getAgent(hostname, isTls) {
  if (isLocalHost(hostname)) return undefined;
  const proxy = current();
  if (!proxy) return undefined;
  if (isBypassed(hostname, proxy)) return undefined;
  return agentFor(proxy.url, isTls !== false);
}

/** 供界面/诊断使用：当前生效的代理与它的来源。 */
function proxyInfo() {
  const proxy = current();
  if (!proxy) return { enabled: false, url: null, source: null };
  return { enabled: true, url: proxy.url, source: proxy.source };
}

/**
 * 把代理相关的错误翻译成用户能照着做的一句话；非代理错误返回 null。
 *
 * 「连不上代理」和「代理拒绝」要分开说：前者是代理没开，后者是代理开着但
 * 不放行这个地址（规则没覆盖、需要认证等）。给错建议会让用户白查半天。
 */
function describeProxyError(err) {
  if (!err || !err.isProxyError) return null;
  if (err.proxyStage === 'reject') {
    return `代理 ${err.proxyUrl} ${err.message} —— 该地址可能不在代理的放行规则里，或代理需要认证`;
  }
  const cause = err.code === 'ECONNREFUSED' ? '代理没有在运行' : err.message;
  return `代理 ${err.proxyUrl} 不可用（${cause}）—— 请检查代理是否已启动，或设置 CCNB_PROXY 指定别的地址`;
}

/** 测试用：清掉缓存与手动设置。 */
function __reset() {
  cached = null;
  override = undefined;
  detectorOverride = null;
  agentCache.clear();
}

/** 测试用：绕过真实探测，直接指定探测结果。 */
function __setDetectorForTest(fn) {
  __reset();
  detectorOverride = fn;
}

/** 测试用：手动指定代理（等同于 CCNB_PROXY）。传 null 表示强制直连。 */
function __setOverrideForTest(url) {
  __reset();
  override = url === null ? null : normalizeProxyUrl(url);
}

module.exports = {
  getAgent,
  proxyInfo,
  describeProxyError,
  isLocalHost,
  normalizeProxyUrl,
  fromEnv,
  fromScutil,
  isBypassed,
  HttpOverProxyAgent,
  HttpsOverProxyAgent,
  __reset,
  __setDetectorForTest,
  __setOverrideForTest,
};
