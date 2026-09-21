'use strict';

/**
 * Electron 主进程入口。
 *
 * 职责：创建窗口、装配各模块、注册 IPC 通道、管理应用生命周期。
 *
 * 架构要点（见设计文档 3.2）：代理运行在主进程，不跑在渲染进程。
 * 渲染进程是沙箱化的浏览器环境，不适合监听端口；主进程才是完整的 Node 运行时。
 */

const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');

const { createStore } = require('./store');
const { createProxy, testUpstream } = require('./proxy');
const { createUsageStore } = require('./usage');
const { createSetup, MANAGED_KEYS, hasOwn } = require('./setup');
const { createModelFetcher } = require('./models');

// ---------------------------------------------------------------------------
// 单实例锁
//
// 必须在**模块顶层**判定，早于任何退出钩子注册，也早于 proxy.start() 与启动接管。
// 两个实例会同时持有接管状态：先退出的那个执行还原，把仍在运行的另一个实例的
// 接管撤掉，用户表现为「用着用着突然断了」。见 PRD 的 R8。
// ---------------------------------------------------------------------------
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  // 失败分支**不执行任何还原** —— 它读到的接管状态是另一个实例写的，它无权撤销。
  console.log(
    '[cc-nbproject] 已有实例在运行，本实例直接退出，不会改动任何配置。\n' +
      '  若你是想用 --remote-debugging-port 另起一个实例来调试，需要先退出正在运行的那个；\n' +
      '  单实例锁会让第二个实例立刻退出，调试端口根本不会打开。'
  );
  app.exit(0);
} else {
  bootstrap();
}

/**
 * 应用的组装与生命周期。
 *
 * 之所以包成函数：单实例锁的失败分支要能「什么都不做就退出」，而模块顶层不允许
 * `return`。把整个初始化做成一个可选执行的单元，比在每一行后面都加判空干净。
 *
 * 顺带说明为什么这些实例不放在模块顶层：失败分支一旦执行到那里，会在用户
 * 毫不知情的情况下生成 `~/.cc-nbproject/profiles.json` 并写入本地准入凭证 ——
 * 一个「什么都不做」的退出不该有这种副作用。
 */
function bootstrap() {
  const store = createStore();
  const usageStore = createUsageStore();
  // 拉取模型列表可能返回几百 KB（OpenRouter 有 446 个模型），带缓存
  const modelFetcher = createModelFetcher();
  // 接管时把这个凭证写进 Claude Code 的 ANTHROPIC_AUTH_TOKEN，代理也用它校验来客。
  // 不用固定占位符的原因见 store.js 的 getLocalToken。
  const setup = createSetup({ localToken: store.getLocalToken() });

  let mainWindow = null;

  /**
   * 向渲染进程推送事件。
   * 窗口可能已经关闭，所以每次都要检查存在性和销毁状态。
   */
  function broadcast(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  }

  /**
   * 代理实例。
   *
   * 这里是「零重启切换」的实现关键：getActiveProfile 是一个**每次请求都会调用**
   * 的函数，它实时从 store 读取当前选中的供应商。因此切换供应商只需要改动
   * store 里的 activeId，代理的下一次请求自然就会走新的上游 ——
   * 既不需要重启 Claude Code，也不需要重启代理本身。
   */
  const proxy = createProxy({
    getActiveProfile: () => store.getActiveProfile(),
    getLocalToken: () => store.getLocalToken(),
    port: store.getSettings().port,
    onUsage: (record) => {
      usageStore.append(record);
      broadcast('log:event', { kind: 'usage', ...record });
    },
    onRequest: (event) => {
      broadcast('log:event', { kind: 'request', ...event });
    },
  });

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1120,
      height: 760,
      minWidth: 900,
      minHeight: 600,
      title: 'cc-nbproject',
      backgroundColor: '#14161a',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        // 以下三项共同构成渲染进程的隔离边界，缺一不可：
        // contextIsolation 让 preload 与页面脚本运行在隔离的 JS 上下文中，
        // nodeIntegration 关闭后页面无法直接 require 任意 Node 模块。
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());

    // dev 模式走 Vite dev server（scripts/dev.mjs 注入该变量），生产走构建产物
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (devServerUrl) {
      mainWindow.loadURL(devServerUrl);
    } else {
      mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'));
    }

    // 外部链接交给系统浏览器，不在应用内打开
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  }

  // ---------------------------------------------------------------------------
  // 接管 / 还原
  //
  // 这一整块是「让接管变成双向」的落点：开应用才生效，关应用自动回到原样，
  // 随时能断开。完整规格见 docs/plans/2026-09-21-接管与还原-prd.md。
  // ---------------------------------------------------------------------------

  /**
   * 接管与断开必须串行。
   *
   * 两者都是「读文件 → 算 → 写文件 → 写状态」的复合动作，交错执行会写出不一致
   * 的状态（例如断开读到的是接管写到一半的快照）。后来者直接拒绝，不做排队 ——
   * 这类操作本来就该由用户一个一个点。
   */
  let takeoverBusy = false;

  function withTakeoverLock(fn) {
    if (takeoverBusy) {
      return { ok: false, reason: '另一项接管操作正在进行，请稍候重试' };
    }
    takeoverBusy = true;
    try {
      return fn();
    } finally {
      takeoverBusy = false;
    }
  }

  /**
   * 接管前的准入条件（PRD 的 R7），两条缺一不可：
   *   1. 代理确实在监听，拿得到**实听**地址；
   *   2. 有已激活的供应商 —— 否则代理对每个请求空转。
   *
   * 第一条同时修掉了一个会实际伤到用户的缺陷：原先写的是
   * `proxy.baseUrl || 'http://127.0.0.1:8787'`，代理启动失败时这个兜底会把一个
   * **必然连不上**的地址写进用户的 Claude Code 配置 —— 正好制造出本工具最怕的
   * 那种「用户完全想不到是工具干的」故障。另外端口被占时代理会顺延，
   * 写死的 8787 也不保证是实听端口，所以地址必须取自 proxy.baseUrl。
   */
  function checkTakeoverEligibility() {
    if (!proxy.baseUrl) {
      return { ok: false, reason: '代理未运行，无法接管。请检查是否有端口被占用。' };
    }
    if (!store.getActiveProfile()) {
      return { ok: false, reason: '请先在「供应商」页添加并激活一个供应商' };
    }
    return { ok: true };
  }

  /**
   * 执行接管：把 Claude Code 指向本机代理，并记下接管状态。
   *
   * 写序遵循 PRD 的 R11 —— 只有 `applyClaudeSettings` **成功落盘之后**才允许写
   * `takeover`。反过来会留下半接管状态：profiles.json 说已接管、文件其实还是原样，
   * 界面显示「已接管」，退出还原又因为文件里的值不等于 applied 而跳过 ——
   * 两头都对不上，用户看到的却是一切正常。
   */
  function performTakeover() {
    return withTakeoverLock(() => {
      const eligible = checkTakeoverEligibility();
      if (!eligible.ok) return eligible;

      const previousTakeover = store.getTakeover();
      try {
        const result = setup.applyClaudeSettings({
          proxyBaseUrl: proxy.baseUrl,
          previousTakeover,
        });
        const at = new Date().toISOString();
        store.setTakeover({
          enabled: true,
          applied: result.applied,
          previous: result.previous,
          fileExisted: result.fileExisted,
          backupPath: result.backupPath,
          residualDetected: result.residualDetected,
          lastApply: { ok: true, at, reason: null },
          lastRestore: (previousTakeover && previousTakeover.lastRestore) || null,
        });
        return { ok: true, ...result };
      } catch (err) {
        // 失败时绝不写 enabled=true。只把这次的失败记下来供界面展示。
        store.patchTakeover({
          lastApply: { ok: false, at: new Date().toISOString(), reason: err.message },
        });
        return { ok: false, reason: err.message };
      }
    });
  }

  /**
   * 执行还原：把两个受管键按 R5 的三态判定写回去。
   *
   * 失败时不抛错、也不清除 takeover —— 保留 previous 与 backupPath，
   * 用户还能再试一次（R10 的界面分支）。
   */
  function performRestore() {
    const takeover = store.getTakeover();
    if (!takeover || !takeover.enabled) {
      return { ok: true, skipped: true, reason: '未接管，无需还原' };
    }
    try {
      const result = setup.restoreClaudeSettings({ takeover });
      store.patchTakeover({
        lastRestore: { ok: true, at: new Date().toISOString(), reason: null },
      });
      return { ok: true, ...result };
    } catch (err) {
      store.patchTakeover({
        lastRestore: { ok: false, at: new Date().toISOString(), reason: err.message },
      });
      return { ok: false, reason: err.message, backupPath: takeover.backupPath };
    }
  }

  /**
   * 「断开接入」：还原 + 清除授权记忆（下次启动不再自动接管）。
   *
   * 清除必须在**还原成功之后**。反过来做的话，还原失败时用户会同时失去两样东西：
   * 下次启动自动重试的机会，以及手动还原所需的 previous / backupPath。
   */
  function performDisconnect() {
    return withTakeoverLock(() => {
      const result = performRestore();
      if (result.ok) {
        store.setTakeover(null);
      }
      return result;
    });
  }

  /**
   * 组装界面要的接管状态（PRD 的 R9 三态）。
   *
   * 判定以**文件内容**为准，`enabled` 只作旁证：「已接管」的实质是文件里那两个键
   * 确实等于我们写进去的值，而不是我们记得自己写过。两者不一致时进中间态，
   * 让用户看到「已授权，但本次没写进去」以及原因。
   */
  function buildTakeoverStatus() {
    const takeover = store.getTakeover();
    const enabled = Boolean(takeover && takeover.enabled);

    let fileMatches = false;
    if (enabled && takeover.applied) {
      try {
        const { exists, content } = setup.readCurrentSettings();
        const env = (content && content.env) || {};
        fileMatches =
          exists &&
          MANAGED_KEYS.every((key) => hasOwn(env, key) && env[key] === takeover.applied[key]);
      } catch {
        // 文件损坏时按「未生效」对待，让界面提示用户先去修文件
        fileMatches = false;
      }
    }

    return {
      // off    未接管
      // active 已接管（文件里确实是我们写的值）
      // pending 已授权，但本次没写进去（代理没起来 / 写入失败）
      state: !enabled ? 'off' : fileMatches ? 'active' : 'pending',
      enabled,
      fileMatches,
      settingsPath: setup.settingsPath,
      applied: (takeover && takeover.applied) || null,
      previous: (takeover && takeover.previous) || null,
      backupPath: (takeover && takeover.backupPath) || null,
      lastApply: (takeover && takeover.lastApply) || null,
      lastRestore: (takeover && takeover.lastRestore) || null,
      proxyBaseUrl: proxy.baseUrl,
    };
  }

  function registerIpcHandlers() {
    // --- 供应商 ---
    ipcMain.handle('profiles:list', () => {
      const state = store.load();
      return { profiles: state.profiles, activeId: state.activeId };
    });

    ipcMain.handle('profiles:add', (_event, payload) => store.addProfile(payload));
    ipcMain.handle('profiles:update', (_event, { id, patch }) => store.updateProfile(id, patch));
    ipcMain.handle('profiles:remove', (_event, id) => store.removeProfile(id));

    ipcMain.handle('profiles:activate', (_event, id) => {
      const profile = store.setActive(id);
      // 立刻广播一次，让 UI 不用额外轮询就能反映新状态
      broadcast('log:event', { kind: 'switch', profileName: profile.name });
      return profile;
    });

    ipcMain.handle('profiles:test', async (_event, id) => {
      const profile = store.listProfiles().find((p) => p.id === id);
      if (!profile) throw new Error('供应商不存在');
      return testUpstream(profile);
    });

    // --- 观测 ---
    ipcMain.handle('usage:summary', (_event, range) => {
      const sinceMs = range && range.sinceMs ? range.sinceMs : null;
      return usageStore.summarize({ sinceMs });
    });
    ipcMain.handle('usage:recent', (_event, limit) => usageStore.recent(limit || 200));

    ipcMain.handle('proxy:status', () => ({
      running: proxy.port !== null,
      port: proxy.port,
      baseUrl: proxy.baseUrl,
      activeProfile: store.getActiveProfile(),
    }));

    // --- 模型列表（辅助填写模型映射，见设计文档 6.6）---
    ipcMain.handle('models:list', (_event, { baseUrl, apiKey, force }) =>
      modelFetcher.fetchModels({ baseUrl, apiKey, force })
    );

    ipcMain.handle('claude:modelNames', () => setup.readClaudeModelNames());

    // --- Claude Code 接管（破坏性操作：预览与应用严格分离）---
    ipcMain.handle('claude:status', () => buildTakeoverStatus());

    ipcMain.handle('claude:preview', () => {
      // 代理没就绪时不展示一份注定写不进去的 diff —— 先告诉用户为什么不行
      const eligibility = checkTakeoverEligibility();
      if (!eligibility.ok) return { ok: false, reason: eligibility.reason };
      return {
        ok: true,
        ...setup.previewClaudeSettings({
          proxyBaseUrl: proxy.baseUrl,
          takeover: store.getTakeover(),
        }),
      };
    });

    ipcMain.handle('claude:takeover', () => performTakeover());
    ipcMain.handle('claude:disconnect', () => performDisconnect());
  }

  /** 退出流程已经跑过一遍了。见 before-quit。 */
  let quitHandled = false;

  app.whenReady().then(async () => {
    try {
      const port = await proxy.start();
      console.log(`[cc-nbproject] 代理已启动：http://127.0.0.1:${port}`);
    } catch (err) {
      // 代理起不来，应用就没有存在意义，直接告知用户而不是开一个空窗口
      console.error('[cc-nbproject] 代理启动失败：', err);
    }

    registerIpcHandlers();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // 启动即接管（R3）：授权过就自动写回，用户不必每次手点。
    // 代理没就绪时这里会安静地跳过（performTakeover 内部会拒绝并记下原因），
    // 界面按 R9 进「已授权，本次未接管」态。
    const takeover = store.getTakeover();
    if (takeover && takeover.enabled) {
      const result = performTakeover();
      if (!result.ok) {
        console.warn('[cc-nbproject] 启动自动接管未成功：', result.reason);
      }
    }
  });

  /**
   * 关掉窗口就退出。
   *
   * macOS 的惯例是关窗后应用继续驻留，但 v0.1 没有托盘图标，驻留会让用户
   * 找不到这个应用、也没法退出。等 v0.2 加了托盘再改成驻留。
   *
   * ⚠️ 这里**只负责退出**，还原一律交给 before-quit。`window-all-closed` 在
   * 「应用正在退出」时根本不触发（Cmd+Q 正是如此），把还原挂在这里等于它在
   * macOS 最常见的退出路径上从不执行。
   */
  app.on('window-all-closed', () => {
    app.quit();
  });

  /**
   * 已有实例时把它的窗口拉到前台，而不是开第二个。
   * 走到这里说明本实例拿到了锁，另一个实例刚刚启动并失败了。
   */
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  /**
   * 退出前的单口还原。
   *
   * 不注册 SIGINT/SIGTERM：macOS 上从 Finder/Dock 启动的 .app 没有控制终端，
   * 收不到 Ctrl+C；系统注销/关机走的也是 quit Apple Event（即走 before-quit）。
   * 那两个处理器对真实用户路径覆盖为零，却会和 Electron 自身的退出流程打架。
   * 退出只留一个口子。
   */
  app.on('before-quit', async (event) => {
    if (quitHandled) return;
    event.preventDefault();

    let result;
    try {
      result = performRestore();
    } catch (err) {
      // 还原本身抛了（例如写状态时磁盘满）。绝不能让它变成未捕获异常 ——
      // 那样用户既看不到交代，应用也卡在一个退不掉的中间态。
      result = { ok: false, reason: err.message };
    }

    if (!result.ok) {
      // 退出路径上的失败处置（R10）：窗口可能已全关、应用不在前台，弹框会被
      // 压在别的应用后面。所以**只给一个动作** —— 不点也不至于退不出去。
      dialog.showMessageBoxSync({
        type: 'error',
        title: '还原 Claude Code 配置失败',
        message: `未能把 ${setup.settingsPath} 还原到接管前的状态。`,
        detail:
          `原因：${result.reason}\n\n` +
          `备份文件：${result.backupPath || '（本次接管未创建备份）'}\n\n` +
          '手动恢复：把该文件里 ANTHROPIC_BASE_URL 与 ANTHROPIC_AUTH_TOKEN 两项改回你要用的值。\n' +
          '（接管前的原值记录在 ~/.cc-nbproject/profiles.json 的 settings.takeover.previous）',
        buttons: ['仍然退出'],
        noLink: true,
      });
    }

    await proxy.stop();
    quitHandled = true;
    // 用 exit 而不是 quit：quit 每次都会先 emit before-quit，用户点「仍然退出」时
    // 又会走进同一个失败的还原、又弹同一个框，形成退不掉的死循环。
    // exit 不触发这些事件，循环不存在。
    app.exit(0);
  });
}
