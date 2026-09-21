'use strict';

/**
 * 模型映射文本的解析与校验。
 *
 * **为什么单独拆成一个文件**：这段逻辑必须能离开浏览器被测试。
 * 它曾经静默地把用户粘贴的多条规则解析成了一条，直接把配置写坏 ——
 * 而错误要到 Claude Code 真的发出请求、上游返回 400 时才显现，
 * 且报错信息完全不提"映射"两个字，排查成本极高。
 * 留在 app.js 里就只能靠手工点界面验证，而这类"静默写坏数据"的 bug
 * 恰恰是最该被测试钉死的。
 *
 * 同一个文件要能被两种方式加载：
 *   - 渲染进程：`<script src="model-map.js">`，函数成为全局
 *   - 单元测试：`require('./model-map.js')`
 * 靠文件末尾的 `typeof module` 守卫区分，浏览器里那行不会执行。
 */

/**
 * 解析模型映射输入框。
 *
 * 格式：每行一条「源模型名=目标模型名」，以 # 开头的行视为注释。
 * 之所以用这种朴素格式而不是做一套表格 UI：映射本身是个低频、小规模的配置
 * （通常两三条），文本行的编辑成本远低于为了让表格好看而付出的代码量。
 *
 * **为什么要把字面的 `\n` 也当换行**：这个坑真实踩过 —— 用户从别处（例如
 * 一段 JavaScript 源码）复制粘贴时，粘进来的可能是字面的反斜杠 + n，而不是
 * 真正的换行。结果多条规则被当成一条，目标名变成一长串垃圾。
 * 模型 ID 里不可能出现反斜杠，所以把字面 `\n` 折叠成换行是安全的。
 */
function parseModelMap(text) {
  const map = {};
  for (const line of text.replace(/\\n/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const from = trimmed.slice(0, separator).trim();
    const to = trimmed.slice(separator + 1).trim();
    if (from && to) map[from] = to;
  }
  return map;
}

/**
 * 找出映射里明显不对劲的地方，返回问题描述数组（空数组表示没问题）。
 *
 * 目的：让"粘错了"这类错误在**保存之前**就暴露出来。
 * 一旦存进去，错误会延迟到 Claude Code 发请求时才以 400 的形式出现，
 * 而那时的报错信息不会提到映射。
 */
function findModelMapProblems(map) {
  const problems = [];
  for (const [from, to] of Object.entries(map)) {
    // 目标名里还有等号，说明本来是两条规则却被粘成了一行
    if (to.includes('=')) {
      problems.push(`「${from}」的目标名里还含有 "="，看起来是多条规则被粘到了一行`);
    } else if (/\s/.test(to)) {
      problems.push(`「${from}」的目标名里有空格，模型 ID 不该含空格`);
    }
  }
  return problems;
}

// 浏览器里没有 module；Node 里才有。守卫住，让同一个文件两边都能用。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseModelMap, findModelMapProblems };
}
