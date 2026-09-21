import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electronPath from 'electron';

// 用 Vite 的 Node API 起 dev server，再拉起 Electron 指向它。
// 不引入 concurrently / wait-on：靠 server.listen() 的 Promise 保证就绪。

const server = await createServer();

await server.listen();

const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5173';

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});

// Electron 退出时关掉 dev server，让整个进程随之退出
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
