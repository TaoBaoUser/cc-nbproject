import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 让 dev 也能 import model-map.js。
 *
 * 那个文件是 CommonJS —— 文件末尾一行 `module.exports = {...}`，靠
 * `typeof module !== 'undefined'` 守卫，好让 node --test 能用 require() 加载它。
 * 那份单元测试是这段解析逻辑唯一的保护（它曾经静默写坏过用户的配置），不能动。
 *
 * 生产构建会自动做 CJS→ESM 互操作，所以 build 一直正常；但 dev 下 Vite 把源码
 * .js 原样当 ESM 送进浏览器，`import { suggestModelMapping } from '../model-map.js'`
 * 直接抛 "does not provide an export named ..."，整个应用白屏 —— 而 build 是好的，
 * 于是这个故障只在开发时出现。
 *
 * 试过 optimizeDeps.include，不解决问题：Vite 确实预打包了，但不会改写这个
 * 相对路径导入的 URL，浏览器拿到的仍是原文件。
 *
 * 所以就地补一行导出：文件本身已经把三个函数声明成了顶层 function，直接
 * re-export 它们即可。末尾那段 `typeof module !== 'undefined'` 守卫在 ESM 里
 * 自然为假（`typeof` 碰未声明的标识符不报错），会自己跳过，不用管。
 * 只在 serve 下生效，构建产物不受影响。
 */
const MODEL_MAP_EXPORTS = 'export { parseModelMap, findModelMapProblems, suggestModelMapping };';

function cjsModelMap(): Plugin {
  let file = '';
  return {
    name: 'cjs-model-map',
    apply: 'serve',
    enforce: 'pre',
    configResolved(config) {
      file = path.resolve(config.root, 'model-map.js');
    },
    transform(code, id) {
      if (id.split('?')[0] !== file) return null;
      // 注意不能写成 `export const { parseModelMap, ... } = module.exports` ——
      // 那是重新声明同名绑定，与文件里既有的 function 声明撞车，直接报
      // "Identifier has already been declared"。
      return `${code}\n${MODEL_MAP_EXPORTS}\n`;
    },
  };
}

// 开发期放行 Vite 的 HMR（websocket + React-refresh 内联 preamble）。
// 生产构建保持 index.html 里的严格 CSP（script-src 'self' / connect-src 'none'）。
function devCsp(): Plugin {
  return {
    name: 'dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      /*
       * index.html 里这个 <meta> 是跨多行写的，属性各占一行，
       * 所以不能用 `<meta http-equiv=...` 这种同行正则 —— 匹配不到时
       * String.replace 会**原样返回**，dev 下悄悄退回严格 CSP，
       * 表现为 HMR 被拦、React-refresh 的 preamble 不执行、窗口空白。
       * `[\s\S]*?` 允许属性之间换行，非贪婪避免吃掉后面的 meta。
       */
      return html.replace(
        /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
        '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; connect-src \'self\' ws: http: https:;" />'
      );
    },
  };
}

export default defineConfig({
  root: 'src/renderer',
  // 关键：Electron 用 file:// 加载构建产物，资源必须相对路径，否则 /assets 会解析到磁盘根
  base: './',
  plugins: [react(), devCsp(), cjsModelMap()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
});
