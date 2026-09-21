/**
 * ESLint 扁平配置（ESLint 9+ 的默认格式，取代了旧的 .eslintrc）
 *
 * 为什么分两段配置：
 * 主进程和 preload 跑在 Node 环境，渲染进程跑在浏览器环境。两者可用的全局变量
 * 完全不同（主进程有 process/require，渲染进程有 window/document）。合并成一套
 * 配置会导致一边误报 no-undef，或更糟——把浏览器全局变量误认为主进程可用。
 */
'use strict';

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
    // 渲染进程：浏览器环境，且以 <script> 标签直接加载，因此是 script 而非 module
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: browserGlobals,
    },
  },
];
