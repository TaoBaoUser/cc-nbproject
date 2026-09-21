'use strict';

/**
 * Claude Code 配置读取的单元测试。
 *
 * 只测纯函数 `extractModelNames` —— 测 `readClaudeModelNames` 就得去读用户真实的
 * `~/.claude/settings.json`，那样测试结果会随环境变化，既不可控，也不该让测试
 * 依赖用户的私人文件。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractModelNames } = require('../src/main/setup.js');

test('extractModelNames：指向同一模型名的多个键被合并成一条', () => {
  // 这是真实的配置形状 —— 主模型、Opus、Sonnet 三个键指向同一个名字。
  // 若不去重，用户要在界面上为同一个模型名配三遍。
  const env = {
    ANTHROPIC_MODEL: 'deepseek-v4-pro',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
    ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-flash',
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
  };

  assert.deepEqual(extractModelNames(env), [
    {
      name: 'deepseek-v4-pro',
      keys: ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
    },
    {
      name: 'deepseek-flash',
      keys: [
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'ANTHROPIC_SMALL_FAST_MODEL',
        'CLAUDE_CODE_SUBAGENT_MODEL',
      ],
    },
  ]);
});

test('extractModelNames：只认 _MODEL 结尾的键', () => {
  const env = {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'sk-xxx',
    ANTHROPIC_MODEL: 'real-model',
  };

  assert.deepEqual(extractModelNames(env), [{ name: 'real-model', keys: ['ANTHROPIC_MODEL'] }]);
});

test('extractModelNames：非字符串、空白值被跳过，不产生空选项', () => {
  const env = {
    ANTHROPIC_MODEL: '  good  ', // 两侧空白应被去掉
    A_MODEL: 123,
    B_MODEL: null,
    C_MODEL: '   ',
    D_MODEL: '',
  };

  assert.deepEqual(extractModelNames(env), [{ name: 'good', keys: ['ANTHROPIC_MODEL'] }]);
});

test('extractModelNames：空输入与缺省输入都返回空数组', () => {
  assert.deepEqual(extractModelNames({}), []);
  assert.deepEqual(extractModelNames(undefined), []);
  assert.deepEqual(extractModelNames(null), []);
});

test('extractModelNames：保持键在 env 里的出现顺序', () => {
  // Object.entries 的顺序即插入顺序；顺序稳定才能让界面上的下拉框不来回跳
  const env = { Z_MODEL: 'z', A_MODEL: 'a', M_MODEL: 'm' };

  assert.deepEqual(
    extractModelNames(env).map((entry) => entry.name),
    ['z', 'a', 'm']
  );
});
