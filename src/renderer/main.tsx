import { createRoot } from 'react-dom/client';
/*
 * 后缀必须写成 `.tsx`，不能只写 `./App`。
 *
 * macOS 的文件系统默认不区分大小写：`./App` 会匹配到 `app.js`（同目录下那个
 * 已被 React 版取代的旧文件，Vite 默认扩展名里 `.js` 排在 `.tsx` 前面），
 * 把整个旧渲染进程打进包，表现为白屏 + React error #130 —— 这个坑真踩过。
 * 文件虽然删了，显式后缀能保证同一个名字回来时不再中招。
 */
import App from './App.tsx';
import './style.css';

createRoot(document.getElementById('root')!).render(<App />);
