'use strict';

/**
 * 高保真截图 —— 起真实 Electron，用 CDP 把每个视图截成 PNG。
 *
 * 与 scripts/e2e/run.js 的分工：那个脚本的产物是「通过 / 失败」，这个脚本的
 * 产物是「给人看的图」。两者跑同一套隔离环境与 CDP 办法，但用途与失败语义
 * 不同，所以不合并。
 *
 * 隔离（三处，理由见 scripts/e2e/run.js 文件头）：
 *   1. HOME 指向 mkdtemp 造的假目录 —— 绝不读写用户真实的
 *      ~/.claude/settings.json 与 ~/.cc-nbproject/profiles.json
 *   2. scripts/e2e/app 自带 package.json，userData 落隔离目录 ——
 *      单实例锁与用户正开着的那个应用互不干扰，也不抢 8787
 *   3. CDP 端口默认 9224，与 e2e 的 9223 错开，两者可同时跑
 *
 * 零依赖：Node 全局 fetch + 全局 WebSocket 讲 CDP。
 *
 * 用法：
 *   node scripts/shots.js              # 输出到 docs/screenshots/
 *   node scripts/shots.js --out /tmp/x # 指定输出目录
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const CDP_PORT = Number(process.env.CDP_PORT || 9224);
// 相对 CWD（仓库根）传入 —— spawn 时作为 Electron 的应用目录。
const APP_DIR = 'scripts/e2e/app';

const outIdx = process.argv.indexOf('--out');
const OUT_DIR =
  outIdx > -1 && process.argv[outIdx + 1]
    ? path.resolve(process.argv[outIdx + 1])
    : path.join(PROJECT_ROOT, 'docs', 'screenshots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 假 HOME：造出有内容的界面状态
// ---------------------------------------------------------------------------

/** 三个供应商 —— 够看出卡片列表的排布，又不至于多到溢出首屏。 */
const PROFILES = [
  {
    id: 'p-deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiKey: 'sk-demo-deepseek',
    modelMap: {},
    createdAt: '2026-09-01T00:00:00.000Z',
  },
  {
    id: 'p-kimi',
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    apiKey: 'sk-demo-kimi',
    modelMap: {},
    createdAt: '2026-09-02T00:00:00.000Z',
  },
  {
    id: 'p-glm',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    apiKey: 'sk-demo-glm',
    modelMap: {},
    createdAt: '2026-09-03T00:00:00.000Z',
  },
];

/**
 * 造一个隔离的 HOME，并预置出「装了三个供应商、尚未接管」的界面状态。
 *
 * 刻意不设 usage.jsonl —— 用量页于是显示空态，那正是要截的东西之一。
 * 目录不做清理，交给系统回收（免得脚本里出现任何 rm 类操作）。
 */
function makeFakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnb-shots-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.cc-nbproject'), { recursive: true });

  // 未接管状态：侧边栏于是显示「接管 Claude Code」按钮，而不是「断开接入」
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'sk-real-user-key',
          ANTHROPIC_MODEL: 'deepseek-v4-pro',
        },
      },
      null,
      2
    ) + '\n'
  );

  fs.writeFileSync(
    path.join(home, '.cc-nbproject', 'profiles.json'),
    JSON.stringify(
      {
        version: 1,
        activeId: 'p-deepseek',
        profiles: PROFILES,
        settings: { port: 8787, localToken: 'a'.repeat(64), takeover: null },
      },
      null,
      2
    ) + '\n'
  );

  return home;
}

// ---------------------------------------------------------------------------
// 启动应用 + CDP
// ---------------------------------------------------------------------------

function launchApp(home, quitFlag) {
  const electron = require('electron');
  const env = { ...process.env, HOME: home, E2E_QUIT_FLAG: quitFlag };
  // 这个变量会让 Electron 退化成普通 Node 进程，`app` 直接是 undefined ——
  // 本仓库的开发环境里它被设成了 1，不清掉的话启动会以一句
  // 「Cannot read properties of undefined (reading 'requestSingleInstanceLock')」
  // 失败，看上去像是主进程的 bug。
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electron, [APP_DIR, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log = [];
  child.stdout.on('data', (b) => log.push(b.toString()));
  child.stderr.on('data', (b) => log.push(b.toString()));

  return { child, log };
}

async function waitForPage(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch {
      // 调试端口还没起来，继续等
    }
    await sleep(250);
  }
  throw new Error('等不到渲染进程页面：应用可能没起来，或调试端口没打开');
}

async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  // 顺序要紧，别调换：先 Page 域，再 Runtime 域。理由见 scripts/e2e/run.js
  // 的 waitForDocumentCommit —— 在 Electron 42~44 上反过来的话，
  // Runtime.enable 会挂在 frame 的初始空文档上，打出一串上游噪音。
  await send('Page.enable');
  await send('Runtime.enable');

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text
      );
    }
    return result.result.value;
  };

  return { ws, send, evaluate };
}

/** 等界面把主进程状态拉回来 —— 在那之前截到的是空壳。 */
const waitForReady = (evaluate) =>
  evaluate(`
    for (let i = 0; i < 60; i++) {
      const url = document.querySelector('#proxy-url')?.textContent?.trim();
      const card = document.querySelector('#provider-list .card');
      if (url && url !== '—' && card) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  `);

// ---------------------------------------------------------------------------
// 截图原语
// ---------------------------------------------------------------------------

let shotCount = 0;

async function shot(send, name, label) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(data, 'base64');
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, buf);
  shotCount += 1;
  console.log(
    `  ✓ ${label} → ${path.relative(PROJECT_ROOT, file)} (${Math.round(buf.length / 1024)}KB)`
  );
}

/** 点侧边栏导航项。data-view 是 Sidebar.tsx 里写死的属性，别改成按文案匹配。 */
const goView = (view) => `
  const btn = document.querySelector('[data-view="${view}"]');
  if (!btn) throw new Error('找不到导航项：${view}');
  btn.click();
  await new Promise((r) => setTimeout(r, 450));
`;

/** 点一个按钮：按 id 找，或按可见文本找。 */
const clickButton = (selector, text) => `
  const el = ${
    text
      ? `[...document.querySelectorAll('${selector}')].find((b) => b.textContent.trim() === '${text}')`
      : `document.querySelector('${selector}')`
  };
  if (!el) throw new Error('找不到按钮：${text || selector}');
  el.click();
  await new Promise((r) => setTimeout(r, 500));
`;

const reload = async (client) => {
  await client.send('Page.reload');
  await sleep(1200);
  await waitForReady(client.evaluate);
};

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const home = makeFakeHome();
  console.log(`假 HOME：${home}`);
  console.log(`输出目录：${path.relative(PROJECT_ROOT, OUT_DIR)}\n`);

  // 信号文件名带时间戳：复用同一个 home 时避免读到自己上次留下的文件
  const quitFlag = path.join(home, `quit-${Date.now()}`);
  const { child, log } = launchApp(home, quitFlag);

  let exited = false;
  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });

  console.log('起 Electron…');
  try {
    const page = await waitForPage();
    const client = await connect(page);

    if (!(await waitForReady(client.evaluate))) {
      throw new Error('界面没能把主进程状态拉回来 —— 可能白屏了');
    }

    console.log('开始截图：');
    await shot(client.send, '01-providers', '供应商视图');

    await client.evaluate(goView('logs'));
    await shot(client.send, '02-logs', '日志视图（空态）');

    await client.evaluate(goView('usage'));
    await shot(client.send, '03-usage', '用量视图（空态）');

    // 弹窗要开着截，截完 reload 复位，免得影响下一张
    await reload(client);
    await client.evaluate(clickButton('#btn-setup'));
    await shot(client.send, '04-setup-modal', '接管弹窗');

    await reload(client);
    await client.evaluate(clickButton('.card-actions .btn', '编辑'));
    await shot(client.send, '05-profile-modal', '供应商编辑弹窗');

    console.log(`\n共 ${shotCount} 张。`);
  } finally {
    // 走真实退出路径（与应用自己调 app.quit() 同一条），而不是直接 kill ——
    // 这样 before-quit 上的还原逻辑会被执行，跟真实使用一致。
    if (!exited) {
      fs.writeFileSync(quitFlag, '1');
      const raced = await Promise.race([
        exitPromise.then(() => 'exited'),
        sleep(10000).then(() => 'timeout'),
      ]);
      if (raced === 'timeout') {
        console.log('\n应用没在 10 秒内退出，强制结束。');
        console.log(log.join('').slice(-2000));
        child.kill();
      }
    }
  }
}

main().catch((err) => {
  console.error('\n截图失败：', err.message);
  process.exit(1);
});
