'use strict';

/**
 * 把 Claude Code 指向本地代理。
 *
 * ⚠️ 这是本工具**唯一**会修改用户已有文件的功能，而且改的是 Claude Code
 * 赖以工作的配置文件。因此流程被刻意拆成「预览」和「应用」两步，中间必须
 * 由用户显式确认（见设计文档 P4.1）。任何形式的静默修改都是不可接受的：
 * 一旦改坏，用户会看到 Claude Code 突然无法使用，却完全想不到是这个工具
 * 造成的，排查成本极高。
 *
 * 参见设计文档第 8 节的风险表。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');

/**
 * 写入 Claude Code 的占位凭证。
 *
 * 真实 API key 由本工具持有并按请求注入，Claude Code 侧不需要知道。
 * 这样做顺带带来一个安全收益：真实凭证不再散落在 Claude Code 的配置里。
 */
const PLACEHOLDER_TOKEN = 'cc-nbproject-managed';

/**
 * 企业级强制配置的位置。它的优先级高于用户级 settings.json，
 * 若其中下发了 ANTHROPIC_BASE_URL，本工具的一切努力都会被覆盖掉。
 * 这种失败是静默的 —— 用户会以为工具坏了 —— 所以必须主动检测并告知。
 */
const MANAGED_SETTINGS_PATHS = {
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  win32: 'C:\\ProgramData\\ClaudeCode\\managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
};

function detectManagedConflict() {
  const managedPath = MANAGED_SETTINGS_PATHS[process.platform];
  if (!managedPath || !fs.existsSync(managedPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(managedPath, 'utf8'));
    const baseUrl = parsed && parsed.env && parsed.env.ANTHROPIC_BASE_URL;
    if (baseUrl) return { path: managedPath, baseUrl };
  } catch {
    // 解析不了就当作不存在，不要因为这个检查本身而阻塞主流程
  }
  return null;
}

function readCurrentSettings() {
  if (!fs.existsSync(CLAUDE_SETTINGS)) {
    return { exists: false, content: {} };
  }
  const raw = fs.readFileSync(CLAUDE_SETTINGS, 'utf8');
  try {
    return { exists: true, content: JSON.parse(raw) };
  } catch (err) {
    // 用户的 settings.json 本身就不是合法 JSON。这时绝不能贸然覆盖，
    // 那会把用户原有的配置彻底抹掉。
    throw new Error(
      `无法解析 ${CLAUDE_SETTINGS}：${err.message}\n` +
        `为避免破坏你的现有配置，本工具不会写入。请先手动修复该文件。`
    );
  }
}

/** 构造写入后的 settings 内容：只动 env 里的两个键，其余原样保留。 */
function buildNextSettings(current, proxyBaseUrl) {
  const env = { ...(current.env || {}) };
  env.ANTHROPIC_BASE_URL = proxyBaseUrl;
  env.ANTHROPIC_AUTH_TOKEN = PLACEHOLDER_TOKEN;
  // 注意：这里刻意不碰 ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL。
  // 那些是用户对自己所用模型的配置，与走不走代理无关，保留即可。
  return { ...current, env };
}

function makeBackupPath() {
  // ISO 时间串里的冒号和点不能直接用于文件名
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${CLAUDE_SETTINGS}.bak.${stamp}`;
}

/**
 * 生成改动预览。不写入任何内容，只读取和计算。
 *
 * @returns {object} 供 UI 逐项展示给用户确认
 */
function previewClaudeSettings({ proxyBaseUrl }) {
  const { exists, content } = readCurrentSettings();
  const next = buildNextSettings(content, proxyBaseUrl);

  const changedKeys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];
  const changes = changedKeys.map((key) => ({
    key,
    from: (content.env && content.env[key]) || null,
    to: next.env[key],
  }));

  return {
    settingsPath: CLAUDE_SETTINGS,
    exists,
    changes,
    // 展示给用户看的完整前后对照
    before: content.env || {},
    after: next.env,
    backupPath: makeBackupPath(),
    managedConflict: detectManagedConflict(),
  };
}

/**
 * 应用改动：先备份，再原子写入。
 *
 * @returns {object} { backupPath, settingsPath }
 */
function applyClaudeSettings({ proxyBaseUrl }) {
  const { content } = readCurrentSettings();
  const next = buildNextSettings(content, proxyBaseUrl);

  if (!fs.existsSync(CLAUDE_DIR)) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  }

  // 第一步永远是备份。哪怕后面写入失败，用户也有一条完整的退路。
  let backupPath = null;
  if (fs.existsSync(CLAUDE_SETTINGS)) {
    backupPath = makeBackupPath();
    fs.copyFileSync(CLAUDE_SETTINGS, backupPath);
  }

  // 与 store.js 采用同样的原子替换策略：宁可失败，不要留下半截文件。
  const tmpPath = `${CLAUDE_SETTINGS}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmpPath, CLAUDE_SETTINGS);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // 临时文件可能没创建成功
    }
    throw err;
  }

  return { settingsPath: CLAUDE_SETTINGS, backupPath };
}

/**
 * 读出 Claude Code 实际会发出的模型名。
 *
 * 这些名字正是「模型映射」左边那一列 —— 让工具把它们读出来，而不是让用户默写，
 * 是从根上消灭"模型名写错"这类错误（见设计文档 6.5 记录的真实事故）。
 *
 * 纯读取，不写入任何内容。读不到时返回 `ok:false` 而不是抛错：
 * 这只是一个便利功能，不该因为它失败就让用户连供应商都加不了。
 *
 * @returns {{ok:boolean, entries?:Array<{name:string, keys:string[]}>, settingsPath:string, reason?:string}}
 *   entries 按"名字"去重保序；keys 记录这个模型名被哪几个配置键使用，
 *   因为 Claude Code 常常让主模型、Opus、Sonnet 三个键指向同一个名字。
 */
/**
 * 从 env 对象里抽出模型名。纯函数 —— 摘出来是为了能测试，
 * 否则测它就得去读用户真实的 ~/.claude/settings.json，既不可控也不该被测试依赖。
 *
 * Claude Code 的模型配置项都以 `_MODEL` 结尾：
 *   ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL /
 *   ANTHROPIC_SMALL_FAST_MODEL / CLAUDE_CODE_SUBAGENT_MODEL
 *
 * @returns {Array<{name:string, keys:string[]}>} 按名字去重且保序。
 *   keys 记录这个模型名被哪几个配置键用到 —— 实践中主模型、Opus、Sonnet
 *   经常指向同一个名字，把它们合并成一行才不会让用户配三遍。
 */
/**
 * 归属"后台小任务"的配置键。用来把模型名分成主模型 / 小任务两类，
 * 依据是键的语义而不是用户起的名字。
 */
const FAST_MODEL_KEYS = new Set([
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
]);

function extractModelNames(env) {
  const byName = new Map();
  for (const [key, value] of Object.entries(env || {})) {
    if (!key.endsWith('_MODEL')) continue;
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(key);
  }
  return [...byName].map(([name, keys]) => ({ name, keys }));
}

function readClaudeModelNames() {
  let content;
  try {
    const read = readCurrentSettings();
    if (!read.exists) {
      return { ok: false, settingsPath: CLAUDE_SETTINGS, reason: '尚未创建 Claude Code 配置文件' };
    }
    content = read.content;
  } catch (err) {
    return { ok: false, settingsPath: CLAUDE_SETTINGS, reason: err.message };
  }

  const entries = extractModelNames(content.env);
  if (entries.length === 0) {
    return {
      ok: false,
      settingsPath: CLAUDE_SETTINGS,
      reason: '配置里没有以 _MODEL 结尾的项，无法推断 Claude Code 会发出什么模型名',
    };
  }
  const { main, fast } = classifyModelNames(entries);
  return { ok: true, entries, main, fast, settingsPath: CLAUDE_SETTINGS };
}

/**
 * 判定哪个模型名是"主模型"、哪个是"后台小任务模型"。
 *
 * 依据是配置键而不是名字本身 —— 名字是用户随便起的，键是 Claude Code 定义的语义。
 * 一次会话里 Claude Code 会同时发这两种请求：主模型负责对话，小任务模型负责
 * 生成标题、压缩上下文这类轻量活儿。把它们指到不同价位，才有省钱的可能。
 *
 * 纯函数，可测。
 *
 * @returns {{main: string|null, fast: string|null}} 找不到对应项时为 null
 */
function classifyModelNames(entries) {
  let main = null;
  let mainHits = 0;
  let fast = null;
  let fastHits = 0;

  for (const entry of entries || []) {
    if (!entry || !Array.isArray(entry.keys)) continue;
    const hits = entry.keys.filter((key) => FAST_MODEL_KEYS.has(key)).length;
    // 不属于小任务那几项的都算主模型侧的键
    const mainSide = entry.keys.length - hits;

    if (mainSide > mainHits) {
      mainHits = mainSide;
      main = entry.name;
    }
    if (hits > fastHits) {
      fastHits = hits;
      fast = entry.name;
    }
  }

  // 两种请求指向同一个模型名时只留一个，否则卡片上会出现两个下拉选同一个值
  if (main === fast) fast = null;
  return { main, fast };
}

module.exports = {
  previewClaudeSettings,
  applyClaudeSettings,
  readClaudeModelNames,
  extractModelNames,
  classifyModelNames,
  CLAUDE_SETTINGS,
  PLACEHOLDER_TOKEN,
};
