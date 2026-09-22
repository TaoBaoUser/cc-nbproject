/**
 * ESLint 扁平配置（ESLint 9+ 的默认格式，取代了旧的 .eslintrc）
 *
 * 为什么分两段配置：
 * 主进程和 preload 跑在 Node 环境，渲染进程跑在浏览器环境。两者可用的全局变量
 * 完全不同（主进程有 process/require，渲染进程有 window/document）。合并成一套
 * 配置会导致一边误报 no-undef，或更糟——把浏览器全局变量误认为主进程可用。
 */
'use strict';

const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');

// Node.js 环境可用的全局变量（主进程 / preload / 测试 / 配置文件）
const nodeGlobals = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  URL: 'readonly',
  structuredClone: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  fetch: 'readonly',
  // Node 22 起是全局变量。scripts/smoke.js 用它走 CDP 驱动真实窗口，
  // 从而不必为了做 UI 冒烟检查而引入 puppeteer。
  WebSocket: 'readonly',
};

// 浏览器环境可用的全局变量（渲染进程）
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
};

module.exports = [
  {
    // 构建产物和依赖目录不参与检查
    ignores: ['node_modules/**', 'dist/**', 'out/**', 'build/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'warn',
    },
  },
  {
    /*
     * 唯一的例外：model-map.js 同时被渲染进程（经 Vite 打包，见 vite.config.ts
     * 的 cjsModelMap 插件）和 node --test（require）加载。
     * 它用 `typeof module !== 'undefined'` 守卫
     * 那行导出语句，浏览器里永远不会执行到，所以这里放行 module 是安全的。
     * 加这条例外是为了换来"这段解析逻辑有单元测试"——它曾经静默写坏过配置。
     */
    files: ['src/renderer/model-map.js'],
    languageOptions: {
      globals: { ...browserGlobals, module: 'readonly' },
    },
  },
  /*
   * 渲染进程的 TypeScript 部分（React + Vite）。
   *
   * 这里不装 eslint-plugin-react：它至今仍把 peer 卡在 eslint <= 9，
   * 与本项目的 eslint 10 装不到一起。收益也很有限 —— 新 JSX transform 下
   * 不需要 import React，插件里最常用的 react/react-in-jsx-scope 已经没意义；
   * 真正值钱的是 react-hooks（依赖数组漏项、条件调用 Hook 这类错误），
   * 它本身支持 eslint 10，所以只取它。
   *
   * tseslint 的预设是"配置数组"，扁平配置里没有 extends，只能就地展开；
   * 展开后必须补上 files，否则它会漏到 .js 上去。
   */
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx'],
  })),
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      // TS 自己就能查出未定义标识符，no-undef 在 .ts 上只会误报类型声明
      globals: { ...browserGlobals },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // 构建配置跑在 Node 环境（vite.config.ts 用 defineConfig + 读路径）
    files: ['vite.config.ts', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...nodeGlobals } },
  },
];
