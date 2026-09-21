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

/**
 * 按名字猜：源模型名最可能对应哪个目标模型 ID。
 *
 * 用途是「拉取模型列表」之后的自动预填 —— 猜对了省一次选择，猜错了改一下即可，
 * 所以这里不需要多聪明，但**必须可以解释**，否则出错时没人知道该不该信它。
 *
 * 打分规则：
 *   1. 按非字母数字切词。源名 `deepseek-flash` → [deepseek, flash]
 *   2. 候选取模型 ID 的最后一段，同样切词。`deepseek/deepseek-v4-flash` → [deepseek, v4, flash]
 *   3. 源名的**每个词都必须出现**在候选里，否则淘汰
 *   4. 在存活者中取"多余词最少"的；并列时取 ID 最短的（更可能是通用名而非带日期后缀的版本）
 *
 * 对真实数据的效果（源 `deepseek-flash`）：
 *   `deepseek/deepseek-v4-flash`        多余 1 个词（v4）      → 胜出
 *   `deepseek/deepseek-chat`            缺 flash               → 淘汰
 *   `deepseek/deepseek-v4-flash-0731`   多余 2 个词            → 落选
 *
 * @returns {string|null} 目标模型 ID；没有可信候选时返回 null（由用户自己选）
 */
function suggestModelMapping(sourceName, modelIds) {
  if (typeof sourceName !== 'string' || !sourceName) return null;
  if (!Array.isArray(modelIds) || modelIds.length === 0) return null;

  const tokenize = (text) =>
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);

  const sourceTokens = [...new Set(tokenize(sourceName))];
  if (sourceTokens.length === 0) return null;

  let best = null;
  for (const id of modelIds) {
    if (typeof id !== 'string' || !id) continue;

    // 只比较最后一段：供应商前缀（deepseek/）不参与匹配，
    // 否则源名里没有厂家名时会把所有带前缀的候选都淘汰掉。
    const lastSegment = id.slice(id.lastIndexOf('/') + 1);
    const candidateTokens = new Set(tokenize(lastSegment));

    if (!sourceTokens.every((token) => candidateTokens.has(token))) continue;

    const extra = candidateTokens.size - sourceTokens.length;
    if (
      best === null ||
      extra < best.extra ||
      (extra === best.extra && id.length < best.id.length)
    ) {
      best = { id, extra };
    }
  }

  return best ? best.id : null;
}

/**
 * 在映射文本里新增或替换一条规则，返回新的文本。
 *
 * 逐行处理而不是"解析成对象再重新序列化"，是为了**保住用户写的注释和空行** ——
 * 后者会让用户在界面上做的任何一次小修改，都把他精心写的注释抹掉。
 *
 * 源名已存在时原地替换那一行（而不是追加），否则同一条规则会出现两次，
 * 后一条静默覆盖前一条，而在文本框里根本看不出来。
 */
function upsertModelMapLine(text, source, target) {
  // 先去掉末尾空白，空输入直接当作"没有行"，
  // 免得追加时在最前面留下一个空行
  const trimmed = String(text || '')
    .replace(/\\n/g, '\n')
    .replace(/\s+$/, '');
  const lines = trimmed === '' ? [] : trimmed.split('\n');

  let replaced = false;
  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const separator = trimmed.indexOf('=');
    if (separator === -1) return line;
    if (trimmed.slice(0, separator).trim() !== source) return line;
    replaced = true;
    return `${source}=${target}`;
  });

  if (!replaced) next.push(`${source}=${target}`);
  return next.join('\n');
}

// 浏览器里没有 module；Node 里才有。守卫住，让同一个文件两边都能用。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseModelMap,
    findModelMapProblems,
    suggestModelMapping,
    upsertModelMapLine,
  };
}
