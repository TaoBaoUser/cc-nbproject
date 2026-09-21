'use strict';

/**
 * preload 脚本：主进程与渲染进程之间唯一的合法通道。
 *
 * 为什么需要这一层（见设计文档 3.2 / P2.2）：
 *
 * 渲染进程启用了 contextIsolation 且禁用了 nodeIntegration，因此它拿不到
 * ipcRenderer，无法直接和主进程通信。我们在这里把允许渲染进程调用的能力
 * 显式列成一份白名单。
 *
 * 关键点在于「白名单」而非「透传」：绝不能写成
 *     contextBridge.exposeInMainWorld('ipcRenderer', ipcRenderer)
 * 那样等于把整个 IPC 面暴露给页面脚本。渲染进程会显示来自 API 响应的内容，
 * 一旦页面里混入恶意脚本，后果就是任意 IPC 调用。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ccnb', {
  // --- 供应商管理 ---
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  addProfile: (payload) => ipcRenderer.invoke('profiles:add', payload),
  updateProfile: (id, patch) => ipcRenderer.invoke('profiles:update', { id, patch }),
  removeProfile: (id) => ipcRenderer.invoke('profiles:remove', id),
  activateProfile: (id) => ipcRenderer.invoke('profiles:activate', id),
  testProfile: (id) => ipcRenderer.invoke('profiles:test', id),

  // --- 观测 ---
  getUsageSummary: (range) => ipcRenderer.invoke('usage:summary', range),
  getRecentUsage: (limit) => ipcRenderer.invoke('usage:recent', limit),
  getProxyStatus: () => ipcRenderer.invoke('proxy:status'),

  // --- Claude Code 配置引导（P4）---
  previewClaudeSettings: () => ipcRenderer.invoke('claude:preview'),
  applyClaudeSettings: () => ipcRenderer.invoke('claude:apply'),

  /**
   * 订阅主进程推送的实时日志。
   *
   * 只把 payload 交给回调，不把 Electron 的 event 对象暴露出去 ——
   * event 上挂着 sender 等引用，暴露它等于绕过了白名单。
   * 返回一个取消订阅函数，供组件卸载时清理。
   */
  onLogEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('log:event', listener);
    return () => ipcRenderer.removeListener('log:event', listener);
  },
});
