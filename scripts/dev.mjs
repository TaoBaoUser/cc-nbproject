import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electronPath from 'electron';

// 用 Vite 的 Node API 起 dev server，再拉起 Electron 指向它。
// 不引入 concurrently / wait-on：靠 server.listen() 的 Promise 保证就绪。

const server = await createServer();

await server.listen();

const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5173';

// 必须清掉 ELECTRON_RUN_AS_NODE：设着它时 Electron 会退化成普通 Node 进程，
// `app` 直接是 undefined，报错却是 `Cannot read properties of undefined
// (reading 'requestSingleInstanceLock')` —— 看上去像主进程的 bug，其实是环境。
// 这个变量在部分开发环境里是默认设着的（本仓库的作者机器上就是 1），
// 于是 `npm run dev` 会直接崩。scripts/e2e/run.js 出于同样的理由也这么做。
const env = { ...process.env, VITE_DEV_SERVER_URL: url };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env,
});

// Electron 退出时关掉 dev server，让整个进程随之退出
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
