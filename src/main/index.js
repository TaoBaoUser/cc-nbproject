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
const { app, BrowserWindow, ipcMain, shell } = require('electron');

const { createStore } = require('./store');
const { createProxy, testUpstream } = require('./proxy');
const { createUsageStore } = require('./usage');
const { previewClaudeSettings, applyClaudeSettings, readClaudeModelNames } = require('./setup');
const { createModelFetcher } = require('./models');

const store = createStore();
const usageStore = createUsageStore();
// 拉取模型列表可能返回几百 KB（OpenRouter 有 446 个模型），带缓存
const modelFetcher = createModelFetcher();

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
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 外部链接交给系统浏览器，不在应用内打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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
  // 接收的是表单里的**草稿值**而非已保存的 profile id：
  // 这样新增供应商、还没点保存时也能先拉列表看看有哪些模型可选。
  ipcMain.handle('models:list', (_event, { baseUrl, apiKey, force }) =>
    modelFetcher.fetchModels({ baseUrl, apiKey, force })
  );

  ipcMain.handle('claude:modelNames', () => readClaudeModelNames());

  // --- Claude Code 配置引导（破坏性操作：预览与应用严格分离）---
  ipcMain.handle('claude:preview', () =>
    previewClaudeSettings({ proxyBaseUrl: proxy.baseUrl || 'http://127.0.0.1:8787' })
  );

  ipcMain.handle('claude:apply', () =>
    applyClaudeSettings({ proxyBaseUrl: proxy.baseUrl || 'http://127.0.0.1:8787' })
  );
}

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
});

/**
 * 关闭所有窗口即退出应用。
 *
 * macOS 的惯例是关掉窗口后应用继续驻留，但 v0.1 没有托盘图标，
 * 驻留会让用户找不到这个应用、也没法退出。等 v0.2 加了托盘再改成驻留。
 */
app.on('window-all-closed', async () => {
  await proxy.stop();
  app.quit();
});
