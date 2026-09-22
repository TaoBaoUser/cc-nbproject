'use strict';

/**
 * 端到端检查专用的 Electron 入口。**这不是生产代码**，只被
 * `scripts/e2e/run.js` 用 `npx electron scripts/e2e/app` 启动。
 *
 * 它只做两件事：
 *
 * 1. 加载真正的主进程入口 —— 检查走的是与线上完全相同的那份 index.js，
 *    一行都不替换。
 *
 * 2. 在 `E2E_QUIT_FLAG` 指向的文件出现时调用 `app.quit()`。
 *
 * 第 2 条为什么非要有：本项工作的核心断言是「退出时自动还原配置」，而在 macOS
 * 上最常见的退出路径是 Cmd+Q —— 它直接走 `app.quit()`，**不会**触发
 * `window-all-closed`。CDP 只能操作渲染进程，从页面上关窗口恰好走的是另一条
 * 路径，恰恰验不到这条。早先的版本把还原挂在 `window-all-closed` 上，在真实
 * 退出路径上从不执行 —— 这正是要防的回归。
 *
 * 用 `E2E_QUIT_FLAG` 这个文件信号而不是 IPC，是为了让 driver 能在「已经确认
 * 文件内容」之后再触发退出，避免时序上的猜测。
 *
 * 顺带：本目录自带 package.json（包名 cc-nbproject-e2e），因此 Electron 的
 * userData 落在隔离目录里，单实例锁与用户正在运行的那个应用**互不干扰**。
 */

require('../../../src/main/index.js');

const fs = require('fs');
const { app } = require('electron');

const quitFlag = process.env.E2E_QUIT_FLAG;

if (quitFlag) {
  const timer = setInterval(() => {
    if (!fs.existsSync(quitFlag)) return;
    clearInterval(timer);
    console.log('[e2e] 收到退出信号，调用 app.quit()');
    app.quit();
  }, 100);
} else {
  console.log('[e2e] 未设置 E2E_QUIT_FLAG，退出钩子不会被触发');
}
