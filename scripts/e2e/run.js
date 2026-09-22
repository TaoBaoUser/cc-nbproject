'use strict';

/**
 * 「接管与还原」的真 Electron 端到端检查。
 *
 * **为什么单测全绿还得跑这个**（docs/plans/2026-09-21-接管与还原-prd.md 第 4 节
 * 「一条不可绕过的规矩」）：
 *
 *   - `npx tsc --noEmit` / `npm run lint` / `npm test` 全绿，证明不了渲染进程能渲染、
 *     也证明不了生命周期钩子在真的 Electron 里会触发。本项目已经吃过两次
 *     「代码一跑就崩、lint 却全绿」的亏（见 scripts/smoke.js 的文件头）。
 *   - 本项工作最关键的一条断言 —— 「退出时自动还原」—— 挂在 `before-quit` 上。
 *     而 `before-quit` 到底会不会在 `app.quit()` 路径上触发、`preventDefault()`
 *     之后 `app.exit(0)` 会不会形成退出死循环，**只有真起一个 Electron 才知道**。
 *
 * 与 smoke.js 的分工：那个脚本驱动**用户正在使用的那份配置**，因此只碰一个
 * 一次性供应商；这个脚本从头到尾跑在 `mkdtemp` 造出的隔离 HOME 里，
 * **完全不接触用户真实的 `~/.claude/settings.json` 与 `~/.cc-nbproject/`**。
 *
 * 零依赖：Node 全局 fetch + 全局 WebSocket 直接讲 CDP（与 scripts/smoke.js 同一套办法）。
 *
 * 用法：
 *   node scripts/e2e/run.js
 * 退出码 0 表示全部场景通过。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// __dirname 是 scripts/e2e，因此要退两层才回到仓库根。
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
// 相对 CWD（仓库根）传入 —— spawn 时作为 Electron 的应用目录。
const APP_DIR = 'scripts/e2e/app';

/** 本次「安装」的本地准入凭证。预置进 profiles.json，好断言写进 Claude Code 的是它。 */
const LOCAL_TOKEN = 'a'.repeat(64);

/** 上游地址指向一个不会有人监听的端口 —— 本检查不需要真的转发成功。 */
const UPSTREAM_URL = 'http://127.0.0.1:19999';

/** 一份形状真实的用户配置：受管键 + 模型键 + 非 env 的其它设置。 */
const USER_SETTINGS = {
  env: {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'sk-real-user-key',
    ANTHROPIC_MODEL: 'deepseek-v4-pro',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
  },
  permissions: { allow: ['Bash(ls:*)'] },
};

const problems = [];
const notes = [];

function expect(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    problems.push(label);
    console.log(`  ✗ ${label}`);
  }
  return Boolean(cond);
}

function note(text) {
  notes.push(text);
  console.log(`  · ${text}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 隔离环境
// ---------------------------------------------------------------------------

let homeCounter = 0;

/**
 * 造一个隔离的 HOME。
 *
 * 目录不做清理，交给系统回收 —— 免得检查脚本里出现任何 rm 类操作。
 */
function makeFakeHome({ withSettings = true } = {}) {
  homeCounter += 1;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `ccnb-e2e-${homeCounter}-`));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.cc-nbproject'), { recursive: true });

  if (withSettings) writeSettings(home, USER_SETTINGS);

  fs.writeFileSync(
    path.join(home, '.cc-nbproject', 'profiles.json'),
    JSON.stringify(
      {
        version: 1,
        activeId: 'p-e2e',
        profiles: [
          {
            id: 'p-e2e',
            name: 'E2E 上游',
            baseUrl: UPSTREAM_URL,
            apiKey: 'sk-upstream-key',
            modelMap: {},
            createdAt: '2026-09-22T00:00:00.000Z',
          },
        ],
        settings: { port: 8787, localToken: LOCAL_TOKEN, takeover: null },
      },
      null,
      2
    ) + '\n'
  );

  return home;
}

const claudeSettingsPath = (home) => path.join(home, '.claude', 'settings.json');
const storePath = (home) => path.join(home, '.cc-nbproject', 'profiles.json');

function writeSettings(home, content) {
  fs.writeFileSync(claudeSettingsPath(home), JSON.stringify(content, null, 2) + '\n');
}

const settingsExists = (home) => fs.existsSync(claudeSettingsPath(home));

function readSettings(home) {
  return JSON.parse(fs.readFileSync(claudeSettingsPath(home), 'utf8'));
}

function readTakeoverState(home) {
  return JSON.parse(fs.readFileSync(storePath(home), 'utf8')).settings.takeover;
}

/** 目录里由本工具产生的备份文件名。 */
function backups(home) {
  return fs.readdirSync(path.join(home, '.claude')).filter((n) => n.includes('.bak.'));
}

// ---------------------------------------------------------------------------
// 启动应用 + CDP
// ---------------------------------------------------------------------------

/** 启动被测应用。走的是生产入口，一行都不替换。 */
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

/**
 * 开 Runtime 域之前，先确认已经挂在**真正提交的那份文档**上。
 *
 * 这个顺序不是随手写的，是本仓库踩过的坑。在 Electron 42~44 上，若 `Runtime.enable`
 * 是挂在页面 target 上的**第一条**命令，它会逼出一个脚本上下文，而该上下文会落在
 * frame 的「初始空文档」上 —— 空文档没有 startup data，sandbox bundle 第一行就解构
 * 失败，打出（一次命中恰好两条）：
 *
 *   Electron sandboxed_renderer.bundle.js script failed to run
 *   TypeError: Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null.
 *
 * 这是**上游问题**（electron#54149；修复 PR #54155 于 2026-09-21 合入 44-x-y，
 * 而当前锁定的 44.4.3 尚未包含），且只波及那个空文档 —— 随后提交的文档照常拿到
 * bundle 与 preload，所以 41 条功能断言全过、只剩这两条噪音，看着才像「偶发」。
 *
 * `Page.enable` 不逼出脚本上下文，且会等到 frame 就绪（实测在慢机器上被压住几十毫秒，
 * 在「导航迟迟不提交」的复现里有数秒）。把它排在 `Runtime.enable` 前面，后者就落到
 * 已提交的文档上了。实测（本机 CPU 加压到 N-1 核）：旧顺序 9 次里 8 次报错，调换后
 * 15 次一次没再出现。
 *
 * 这层检查本身也是有用的断言：若 frame 迟迟不显示 index.html，说明挂错了 target，
 * 应当直接失败，而不是继续跑一堆没有意义的断言。
 */
async function waitForDocumentCommit(send, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { frameTree } = await send('Page.getFrameTree');
    if ((frameTree?.frame?.url ?? '').includes('index.html')) return;
    await sleep(10);
  }
  throw new Error('等不到页面文档提交：调试目标出现了，但首个导航始终没落地');
}

async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const pageProblems = [];

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    // 渲染进程里任何未捕获的异常都要被抓出来 —— 白屏就是这么被发现的
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageProblems.push('未捕获异常：' + (d.exception?.description || d.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      pageProblems.push(
        'console.error：' + msg.params.args.map((a) => a.value ?? a.description).join(' ')
      );
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  // 顺序要紧，别调换：先 Page 域，再 Runtime 域。理由见 waitForDocumentCommit。
  await send('Page.enable');
  await waitForDocumentCommit(send);
  await send('Runtime.enable');

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      return {
        __error: result.exceptionDetails.exception?.description || result.exceptionDetails.text,
      };
    }
    return result.result.value;
  };

  return { ws, send, evaluate, pageProblems };
}

/** 点一个按钮（按可见文本找），等一小会儿让 React 收敛。 */
const clickByText = (client, selector, text) => `
  const btn = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find((b) => b.textContent.trim() === ${JSON.stringify(text)});
  if (!btn) throw new Error('找不到按钮：' + ${JSON.stringify(text)});
  btn.click();
  await new Promise((r) => setTimeout(r, 300));
`;

const waitFor = async (client, expr, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.evaluate(`return Boolean(${expr});`)) return true;
    await sleep(200);
  }
  return false;
};

/** 侧边栏接管状态行的三态。 */
const takeStateExpr = `document.querySelector('#claude-line')?.dataset.claudeState ?? null`;

// ---------------------------------------------------------------------------
// 一个「应用会话」：起应用 → 交给回调 → 按真实退出路径关掉
// ---------------------------------------------------------------------------

let sessionCounter = 0;

async function withApp(home, fn) {
  // 信号文件名必须每次都不同：同一个 home 上会先后跑好几个场景，
  // 沿用同一个名字的话，第二次启动会看到上一次留下的文件 —— 应用刚起来
  // 就立刻退出，表现为「等不到渲染进程页面」。
  sessionCounter += 1;
  const quitFlag = path.join(home, `quit-flag-${sessionCounter}`);
  const { child, log } = launchApp(home, quitFlag);

  let exited = false;
  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });

  let client = null;
  try {
    const page = await waitForPage();
    client = await connect(page);
    // 等界面把主进程状态拉回来（两个 effect 都是异步的）
    await waitFor(client, takeStateExpr, 8000);
    return await fn(client, home);
  } finally {
    if (client) {
      for (const p of client.pageProblems) problems.push(`[渲染进程] ${p}`);
    }

    // 走真实退出路径：让应用自己调 app.quit()，与 Cmd+Q 同一条路。
    // 从页面上 window.close() 走的是 window-all-closed，验不到 before-quit。
    if (!exited) {
      fs.writeFileSync(quitFlag, '1');
      const raced = await Promise.race([
        exitPromise.then(() => 'exited'),
        sleep(10000).then(() => 'timeout'),
      ]);
      if (raced === 'timeout') {
        // 退出流程卡住（例如 before-quit 里 await 了一个永不结束的 promise）
        problems.push('应用在 10 秒内没有退出，退出流程可能被卡住了');
        child.kill('SIGKILL');
        await exitPromise;
      }
    }

    if (client) client.ws.close();

    // 主进程在还原失败时会弹一个原生对话框并卡住；这里从日志上先认出来，
    // 免得只看到一句「10 秒内没有退出」。
    if (log.join('').includes('还原 Claude Code 配置失败')) {
      problems.push('主进程报告「还原 Claude Code 配置失败」');
    }
  }
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

async function scenarioMainFlow(home) {
  console.log('\n【场景 1】接入 → 退出自动还原');

  await withApp(home, async (client) => {
    const state0 = await client.evaluate(`return ${takeStateExpr};`);
    expect(state0 === 'off', `初始状态是「未接管」（实际 ${state0}）`);

    // 打开接管弹窗
    await client.evaluate(`
      const btn = document.querySelector('#btn-setup');
      if (!btn) throw new Error('侧边栏没有「接管 Claude Code」按钮');
      btn.click();
      await new Promise((r) => setTimeout(r, 500));
    `);

    const modalOk = await waitFor(client, `document.querySelector('#modal-root .modal')`);
    expect(modalOk, '接管弹窗打开了');

    const modal = await client.evaluate(`
      const m = document.querySelector('#modal-root .modal');
      if (!m) return null;
      return {
        标题: m.querySelector('h2')?.textContent ?? null,
        正文: m.textContent,
        表格: [...m.querySelectorAll('.diff-table tbody tr')].map((tr) =>
          [...tr.querySelectorAll('td')].map((td) => td.textContent)
        ),
      };
    `);

    expect(modal?.标题 === '接管 Claude Code', `弹窗标题正确（实际 ${modal?.标题}）`);
    expect(modal?.正文?.includes('一次性授权'), '弹窗说明了「一次授权、之后自动」的语义');
    expect(
      modal?.正文?.includes('不再打算打开本应用') && modal?.正文?.includes('断开接入'),
      '弹窗给出了「以后不打算再打开本应用就先断开」的告警'
    );
    expect(
      modal?.正文?.includes('本地准入凭证'),
      '弹窗说明了写入的是本地准入凭证而不是用户的真实 key'
    );
    expect(
      modal?.表格?.some(([key, , to]) => key === 'ANTHROPIC_BASE_URL' && to.includes('127.0.0.1')),
      '改动对照表里能看到 ANTHROPIC_BASE_URL 的新值'
    );
    expect(
      modal?.表格?.some(([, from]) => from.includes('api.deepseek.com')),
      '改动对照表里能看到当前值'
    );

    // 确认接管
    await client.evaluate(clickByText(client, '#modal-root .modal-actions button', '确认接管'));

    const doneOk = await waitFor(
      client,
      `document.querySelector('#modal-root .modal h2')?.textContent === '已接管'`
    );
    expect(doneOk, '「已接管」结果页出现了');

    const doneText = await client.evaluate(
      `return document.querySelector('#modal-root .modal')?.textContent ?? '';`
    );
    expect(doneText.includes('.bak.') || doneText.includes('备份'), '结果页交代了备份的去向');

    // 关掉弹窗，看侧边栏
    await client.evaluate(clickByText(client, '#modal-root .modal-actions button', '好'));
    await sleep(400);

    const state1 = await client.evaluate(`return ${takeStateExpr};`);
    expect(state1 === 'active', `侧边栏切到「已接管」（实际 ${state1}）`);

    const baseUrl = await client.evaluate(`return (await window.ccnb.getProxyStatus()).baseUrl;`);
    note(`本次代理实听地址：${baseUrl}`);
    if (baseUrl !== 'http://127.0.0.1:8787') {
      note('8787 被占用、代理已漂移 —— 写进配置的必须是实听地址，这正是要验的分支');
    }

    // ---- 文件层面的断言：这才是真正要证明的东西 ----
    const after = readSettings(home);
    expect(
      after.env.ANTHROPIC_BASE_URL === baseUrl,
      `文件里的 ANTHROPIC_BASE_URL 是实听地址（写进去的是 ${after.env.ANTHROPIC_BASE_URL}）`
    );
    expect(
      after.env.ANTHROPIC_AUTH_TOKEN === LOCAL_TOKEN,
      '文件里的 ANTHROPIC_AUTH_TOKEN 是本次安装的随机凭证，不是公开占位符'
    );
    expect(
      after.env.ANTHROPIC_AUTH_TOKEN !== 'cc-nbproject-managed',
      '没有退回到老版本的公开占位符'
    );
    expect(
      after.env.ANTHROPIC_MODEL === 'deepseek-v4-pro' &&
        after.env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'deepseek-flash',
      '模型相关配置项原样未动'
    );
    expect(
      JSON.stringify(after.permissions) === JSON.stringify(USER_SETTINGS.permissions),
      'env 之外的内容原样未动'
    );

    const baks = backups(home);
    expect(baks.length === 1, `恰好产生一个备份（实际 ${baks.length} 个）`);
    if (baks.length === 1) {
      const bak = JSON.parse(fs.readFileSync(path.join(home, '.claude', baks[0]), 'utf8'));
      expect(JSON.stringify(bak) === JSON.stringify(USER_SETTINGS), '备份内容是接入前的原文');
    }
    expect(
      (fs.statSync(claudeSettingsPath(home)).mode & 0o777) === 0o600,
      'settings.json 的权限仍是 0600'
    );

    // ---- 退出前先记下状态 ----
    const state = readTakeoverState(home);
    expect(state?.enabled === true, 'profiles.json 里记下了接管授权');
    expect(
      state?.previous?.ANTHROPIC_BASE_URL === 'https://api.deepseek.com/anthropic',
      '记下的 previous 是用户原值'
    );
    expect(state?.backupPath && path.isAbsolute(state.backupPath), '记下了备份文件的绝对路径');
  });

  // ---- 退出之后：文件必须回到原样 ----
  console.log('  — 应用已退出，检查还原 —');
  const restored = readSettings(home);
  expect(
    restored.env.ANTHROPIC_BASE_URL === 'https://api.deepseek.com/anthropic',
    `退出后 ANTHROPIC_BASE_URL 已还原（实际 ${restored.env.ANTHROPIC_BASE_URL}）`
  );
  expect(
    restored.env.ANTHROPIC_AUTH_TOKEN === 'sk-real-user-key',
    '退出后 ANTHROPIC_AUTH_TOKEN 已还原成用户真实 key'
  );
  expect(restored.env.ANTHROPIC_MODEL === 'deepseek-v4-pro', '退出后模型相关配置仍然原样');
  expect(backups(home).length === 1, '退出还原没有再产生备份');
  expect(readTakeoverState(home)?.lastRestore?.ok === true, 'profiles.json 里记下了还原成功');
}

async function scenarioAutoTakeover(home) {
  console.log('\n【场景 2】重开应用 → 自动接管（不再询问）');

  await withApp(home, async (client) => {
    const state = await client.evaluate(`return ${takeStateExpr};`);
    expect(state === 'active', `无需任何点击即处于「已接管」（实际 ${state}）`);

    const after = readSettings(home);
    expect(after.env.ANTHROPIC_BASE_URL?.startsWith('http://127.0.0.1:'), '文件又被指回本机代理');
  });

  const restored = readSettings(home);
  expect(
    restored.env.ANTHROPIC_BASE_URL === 'https://api.deepseek.com/anthropic',
    '第二次退出同样还原'
  );
  expect(backups(home).length === 1, '「每次启动自动接管」没有堆积备份文件');
}

async function scenarioDisconnect(home) {
  console.log('\n【场景 3】断开接入 → 此后不再接管');

  await withApp(home, async (client) => {
    const before = await client.evaluate(`return ${takeStateExpr};`);
    expect(before === 'active', '断线前处于「已接管」');

    await client.evaluate(`
      const btn = document.querySelector('#btn-disconnect');
      if (!btn) throw new Error('侧边栏没有「断开接入」按钮');
      btn.click();
      await new Promise((r) => setTimeout(r, 600));
    `);

    const after = await client.evaluate(`return ${takeStateExpr};`);
    expect(after === 'off', `断开后侧边栏回到「未接管」（实际 ${after}）`);
  });

  const restored = readSettings(home);
  expect(
    restored.env.ANTHROPIC_BASE_URL === 'https://api.deepseek.com/anthropic',
    '断开后配置已还原'
  );
  expect(readTakeoverState(home) === null, '授权记忆被清除');
}

async function scenarioDisconnectedStaysOff(home) {
  console.log('\n【场景 4】断开之后重开应用 → 不再自动接管');

  await withApp(home, async (client) => {
    const state = await client.evaluate(`return ${takeStateExpr};`);
    expect(state === 'off', `重开后仍是「未接管」（实际 ${state}）`);
  });

  const settings = readSettings(home);
  expect(
    settings.env.ANTHROPIC_BASE_URL === 'https://api.deepseek.com/anthropic',
    '配置文件没有被再次改动'
  );
}

async function scenarioNoSettingsFile() {
  console.log('\n【场景 5】接入前没有 settings.json → 还原后仍然没有');

  const home = makeFakeHome({ withSettings: false });

  await withApp(home, async (client) => {
    await client.evaluate(`
      const btn = document.querySelector('#btn-setup');
      if (!btn) throw new Error('侧边栏没有「接管 Claude Code」按钮');
      btn.click();
      await new Promise((r) => setTimeout(r, 500));
    `);
    await waitFor(client, `document.querySelector('#modal-root .modal')`);

    const text = await client.evaluate(
      `return document.querySelector('#modal-root .modal')?.textContent ?? '';`
    );
    expect(text.includes('将被创建'), '弹窗说明目标文件会被创建');

    await client.evaluate(clickByText(client, '#modal-root .modal-actions button', '确认接管'));
    await waitFor(
      client,
      `document.querySelector('#modal-root .modal h2')?.textContent === '已接管'`
    );

    expect(settingsExists(home), '接管后文件被创建出来了');
    expect(backups(home).length === 0, '原本没有文件可备份，不应产生备份');
  });

  expect(!settingsExists(home), '退出后文件被删掉，回到「接入前不存在」的状态');
}

// ---------------------------------------------------------------------------

async function main() {
  // 应用的全局快捷键/单实例锁都依赖一个可用的 HOME；这里只做一次存在性确认
  if (!fs.existsSync(path.join(PROJECT_ROOT, 'dist', 'renderer', 'index.html'))) {
    throw new Error('没有构建产物，请先 `npm run build`');
  }

  const homeA = makeFakeHome();
  console.log(`隔离 HOME：${homeA}`);

  await scenarioMainFlow(homeA);
  await scenarioAutoTakeover(homeA);
  await scenarioDisconnect(homeA);
  await scenarioDisconnectedStaysOff(homeA);
  await scenarioNoSettingsFile();

  console.log('\n' + '─'.repeat(60));
  for (const n of notes) console.log(`· ${n}`);

  if (problems.length === 0) {
    console.log('\n全部通过。');
    process.exit(0);
  }

  console.log(`\n${problems.length} 项未通过：`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('\n检查无法进行：', err);
  process.exit(2);
});
