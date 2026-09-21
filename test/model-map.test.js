'use strict';

/**
 * 模型映射文本解析的单元测试。
 *
 * 这段逻辑原本在 app.js 里、没有测试，后果是真实发生过的：
 * 用户粘贴进来的多条规则被静默解析成了一条，配置被写坏，
 * 而错误要到 Claude Code 发出请求、上游返回 400 时才出现 ——
 * 报错信息完全不提"映射"，排查全靠猜。
 *
 * 所以这里的每个用例都对应一种"输错的方式"，而不是"正常输入"。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseModelMap,
  findModelMapProblems,
  suggestModelMapping,
  upsertModelMapLine,
} = require('../src/renderer/model-map.js');

/**
 * OpenRouter 上真实的 DeepSeek 系列模型 ID（从 /api/v1/models 实际拉取后摘录）。
 * 用真实数据而不是编造的样例：猜名逻辑的价值全在"面对真实命名混乱时准不准"。
 */
const OPENROUTER_DEEPSEEK = [
  'deepseek/deepseek-chat',
  'deepseek/deepseek-chat-v3-0324',
  'deepseek/deepseek-chat-v3.1',
  'deepseek/deepseek-r1',
  'deepseek/deepseek-v3.2',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-flash-0731',
  'deepseek/deepseek-v4-flash-vision-exp',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-pro-0813',
  '~deepseek/deepseek-flash-latest',
  '~deepseek/deepseek-pro-latest',
];

test('parseModelMap：正常的逐行输入被解析成多条规则', () => {
  const map = parseModelMap(
    'deepseek-v4-pro=deepseek/deepseek-v4-pro\ndeepseek-flash=deepseek/deepseek-v4-flash'
  );

  assert.deepEqual(map, {
    'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
    'deepseek-flash': 'deepseek/deepseek-v4-flash',
  });
});

test('parseModelMap：字面的 \\n 被当作换行，而不是规则内容的一部分', () => {
  // 这是真实踩过的坑：从一段 JS 源码里复制粘贴，拿到的是转义写法而非真换行。
  // 若不处理，整个输入框会被解析成**一条**规则，目标名变成一长串垃圾。
  const pasted =
    'deepseek-v4-pro=deepseek/deepseek-v4-pro\\ndeepseek-flash=deepseek/deepseek-v4-flash';

  assert.deepEqual(parseModelMap(pasted), {
    'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
    'deepseek-flash': 'deepseek/deepseek-v4-flash',
  });
});

test('parseModelMap：忽略空行、空白行与 # 注释', () => {
  const map = parseModelMap(['# 主模型', 'a=1', '', '   ', '  # 缩进的注释', 'b=2', ''].join('\n'));

  assert.deepEqual(map, { a: '1', b: '2' });
});

test('parseModelMap：缺等号、源或目标为空的条目被跳过', () => {
  const map = parseModelMap(['没有等号的一行', '=只有目标', '只有源=', '  =  ', 'a=1'].join('\n'));

  assert.deepEqual(map, { a: '1' });
});

test('parseModelMap：源名与目标名两侧的空白被去掉', () => {
  // 用户手打时很容易在等号两边留空格
  assert.deepEqual(parseModelMap('  deepseek-v4-pro = deepseek/deepseek-v4-pro  '), {
    'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
  });
});

test('parseModelMap：Windows 换行（\\r\\n）不会把 \\r 留在目标名里', () => {
  const map = parseModelMap('a=1\r\nb=2');

  assert.deepEqual(map, { a: '1', b: '2' });
});

test('parseModelMap：空输入返回空对象（等价于不启用映射）', () => {
  assert.deepEqual(parseModelMap(''), {});
  assert.deepEqual(parseModelMap('   \n  '), {});
});

test('findModelMapProblems：目标名里残留等号时报警（多条规则被粘成一行）', () => {
  // 这正是那次事故的形状：若解析器没能拆开，这条就会被当成正常规则存下去
  const problems = findModelMapProblems({
    'deepseek-v4-pro': 'deepseek/deepseek-v4-pro\\ndeepseek-flash=deepseek/deepseek-v4-flash',
  });

  assert.equal(problems.length, 1);
  assert.match(problems[0], /deepseek-v4-pro/);
});

test('findModelMapProblems：目标名含空格时报警', () => {
  const problems = findModelMapProblems({ a: 'deep seek/deepseek-v4-pro' });

  assert.equal(problems.length, 1);
  assert.match(problems[0], /空格/);
});

test('findModelMapProblems：合法映射不产生任何告警', () => {
  assert.deepEqual(
    findModelMapProblems({
      'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
      'deepseek-flash': 'deepseek/deepseek-v4-flash',
    }),
    []
  );
  assert.deepEqual(findModelMapProblems({}), []);
});

// ---------------------------------------------------------------------------
// 自动预填：拉取模型列表后猜"源名对应哪个目标模型"
// ---------------------------------------------------------------------------

test('suggestModelMapping：完全同名的候选优先于带版本后缀的', () => {
  // deepseek-v4-pro 在列表里有三代：原版、-0813。原版多余词最少，应胜出。
  assert.equal(
    suggestModelMapping('deepseek-v4-pro', OPENROUTER_DEEPSEEK),
    'deepseek/deepseek-v4-pro'
  );
});

test('suggestModelMapping：源名少一个版本词时，仍能挑出最贴近的那个', () => {
  // 这是用户真实遇到的形状：Claude Code 发 deepseek-flash，
  // 而 OpenRouter 上叫 deepseek-v4-flash。中间差了 v4 这个词。
  assert.equal(
    suggestModelMapping('deepseek-flash', OPENROUTER_DEEPSEEK),
    'deepseek/deepseek-v4-flash'
  );
});

test('suggestModelMapping：缺失关键词的候选一律淘汰', () => {
  // deepseek-chat 含 deepseek 但不含 flash —— 不能因为"部分匹配"就选中它，
  // 那会把后台小任务模型悄悄指到另一个代次上。
  assert.notEqual(
    suggestModelMapping('deepseek-flash', OPENROUTER_DEEPSEEK),
    'deepseek/deepseek-chat'
  );
});

test('suggestModelMapping：没有可信候选时返回 null，而不是硬凑一个', () => {
  assert.equal(suggestModelMapping('gpt-4o', OPENROUTER_DEEPSEEK), null);
  assert.equal(suggestModelMapping('deepseek-flash', []), null);
  assert.equal(suggestModelMapping('', OPENROUTER_DEEPSEEK), null);
  assert.equal(suggestModelMapping(null, OPENROUTER_DEEPSEEK), null);
  assert.equal(suggestModelMapping('deepseek-flash', null), null);
});

test('suggestModelMapping：忽略非字符串候选，不因脏数据抛错', () => {
  assert.equal(suggestModelMapping('m', ['m', null, undefined, 42, {}]), 'm');
});

// ---------------------------------------------------------------------------
// 写入映射文本
// ---------------------------------------------------------------------------

test('upsertModelMapLine：空输入只产生一行，不留前导空行', () => {
  assert.equal(upsertModelMapLine('', 'a', 'x'), 'a=x');
  assert.equal(upsertModelMapLine('   \n  ', 'a', 'x'), 'a=x');
});

test('upsertModelMapLine：新规则追加到末尾', () => {
  assert.equal(upsertModelMapLine('a=x', 'b', 'y'), 'a=x\nb=y');
});

test('upsertModelMapLine：同一源名原地替换，不产生重复行', () => {
  // 若改成追加，同一条规则会出现两次、后一条静默覆盖前一条，
  // 而在文本框里完全看不出问题
  const result = upsertModelMapLine('a=old\nb=y', 'a', 'new');

  assert.equal(result, 'a=new\nb=y');
  assert.equal(result.split('\n').filter((l) => l.startsWith('a=')).length, 1);
});

test('upsertModelMapLine：保住用户写的注释与空行', () => {
  // 逐行处理而不是"解析成对象再序列化"，就是为了不让界面上任何一次小修改
  // 都把用户精心写的注释抹掉
  const text = '# 主模型\na=old\n\n# 后台小任务\nb=y';
  const result = upsertModelMapLine(text, 'a', 'new');

  assert.equal(result, '# 主模型\na=new\n\n# 后台小任务\nb=y');
});

test('upsertModelMapLine：输入里是字面 \\n 时也能正确追加', () => {
  // 与 parseModelMap 同一类坑：字面 \n 必须先当作换行，否则会把整段当成一行
  assert.equal(upsertModelMapLine('a=x\\nb=y', 'c', 'z'), 'a=x\nb=y\nc=z');
});

test('upsertModelMapLine：写入结果能被 parseModelMap 原样读回', () => {
  // 这两个函数是一对，往返一致是它们之间唯一的契约
  let text = '';
  text = upsertModelMapLine(text, 'deepseek-v4-pro', 'deepseek/deepseek-v4-pro');
  text = upsertModelMapLine(text, 'deepseek-flash', 'deepseek/deepseek-v4-flash');

  assert.deepEqual(parseModelMap(text), {
    'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
    'deepseek-flash': 'deepseek/deepseek-v4-flash',
  });
});
