'use strict';

/**
 * 把 Claude Code 指向本地代理 —— 以及**把它还回去**。
 *
 * ⚠️ 这是本工具**唯一**会修改用户已有文件的功能，而且改的是 Claude Code
 * 赖以工作的配置文件。因此有两条贯穿全文件的规矩：
 *
 * 1. **预览与应用必须分开**，中间由用户显式确认（见设计文档 P4.1）。任何形式的
 *    静默修改都是不可接受的：一旦改坏，用户会看到 Claude Code 突然无法使用，
 *    却完全想不到是这个工具造成的，排查成本极高。
 * 2. **接管必须是双向的**。只接不管，用户关掉应用后 Claude Code 就指向一个没人
 *    监听的端口 —— 上面那条风险会以最恶劣的方式兑现。见
 *    docs/plans/2026-09-21-接管与还原-prd.md。
 *
 * 为什么做成工厂（`createSetup({ claudeDir })`）而不是一组模块级函数：
 * 还原是本项目里**最危险**的一段代码，写错就是毁掉用户的 Claude Code 配置 ——
 * 而路径写死在模块顶层时，它偏偏是最测不了的部分（测一下就得去读用户真实的
 * 私人文件）。注入路径之后，测试可以用 mkdtemp 造隔离目录把它测透。
 * 这与 store.js 的 `createStore({ dir })` 是同一个范式。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.claude');

/** 配置文件权限：仅所有者可读写。里面有用户的真实 API key。 */
const FILE_MODE = 0o600;

/**
 * 接管只会碰这两个键，其余（模型名、权限、hooks……）一律不碰。
 *
 * 模型相关的键是用户对**自己所用模型**的配置，与走不走代理无关，保留即可。
 * 见 PRD 的 R5。
 */
const MANAGED_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];

/**
 * 本地代理可能占用的端口区间，与 proxy.js 的 `listenWithFallback` 对应。
 *
 * 用途只有一个：判断 settings.json 里的 ANTHROPIC_BASE_URL 是不是我们自己写的。
 * 端口会漂移（8787 被占时顺延），所以判定不能只比当前端口；但也不能见到
 * 127.0.0.1 就认——用户可能自己在本地跑着别的服务。
 */
const PROXY_DEFAULT_PORT = 8787;
const PROXY_PORT_ATTEMPTS = 20;
const PROXY_PORT_RANGE = {
  from: PROXY_DEFAULT_PORT,
  to: PROXY_DEFAULT_PORT + PROXY_PORT_ATTEMPTS,
};

/**
 * 老版本写进 Claude Code 的固定占位符。
 *
 * 它曾同时充当「本地准入凭证」和「真实 key 的替身」，但那是个**公开常量** ——
 * 任何本机进程照抄这串字，就能让代理白送一次用真实 key 签名的请求。现在凭证
 * 改为每次安装随机生成（见 store.js 的 getLocalToken），这个常量只保留一个
 * 用途：**认出老版本留下的残渣**，好把它安全地还原掉，而不是当成用户的真实
 * 配置记进 previous（那会让还原变成「把死值写回去」，见 PRD 的 R6）。
 */
const LEGACY_PLACEHOLDER_TOKEN = 'cc-nbproject-managed';

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

/** 判定对象上是否**真的存在**该键 —— 不能用 `obj[key] === undefined` 代替。 */
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

/**
 * 判定某个键的当前值是不是「我们自己写进去的」。
 *
 * 这是 PRD 的 R6 的落点，也是本项目最容易造成**数据破坏**的一处：
 * 应用被强杀（kill -9、断电）时来不及还原，文件里会留下我们写的值。
 * 下次启动接管时若把这个残渣当成「用户原本的配置」记进 `previous`，
 * 那么下一次还原就会把占位符/本机地址写回给 Claude Code ——
 * **用户真正的凭证与地址被彻底丢掉，而工具还会报告「已还原成功」**。
 *
 * 所以宁可不认（把残渣记进 previous 只是还原不精确），也不能误认
 * （把用户真实配置当成残渣丢弃）。判定规则因此收得很紧：只在值确实
 * 长得像我们的产物时才认。
 */
function looksLikeOurOwnValue(key, value, { localToken, proxyBaseUrl } = {}) {
  if (typeof value !== 'string' || !value) return false;

  if (key === 'ANTHROPIC_AUTH_TOKEN') {
    if (value === LEGACY_PLACEHOLDER_TOKEN) return true;
    return Boolean(localToken) && value === localToken;
  }

  if (key === 'ANTHROPIC_BASE_URL') {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }
    const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
    if (!LOOPBACK.has(parsed.hostname)) return false;

    const port = Number(parsed.port);
    if (!Number.isInteger(port)) return false;

    // 端口可能漂移（8787 被占时 listenWithFallback 会顺延），所以不能只比当前端口。
    // 用「落在代理可能使用的端口区间内」判定，既覆盖漂移，又不会把用户自己
    // 在本机跑的其它服务（如 LM Studio 的 1234）误认成我们写的。
    if (port >= PROXY_PORT_RANGE.from && port <= PROXY_PORT_RANGE.to) return true;

    // 本次要写的地址是确凿无疑的，即便它落在区间之外（端口被显式配置过）
    if (proxyBaseUrl) {
      try {
        return new URL(proxyBaseUrl).port === parsed.port;
      } catch {
        return false;
      }
    }
  }

  return false;
}

/**
 * 工厂：把「接管 / 还原 Claude Code 配置」的全部能力绑到一个目录上。
 *
 * @param {object}   deps
 * @param {string}   [deps.claudeDir]   Claude Code 配置目录，默认 ~/.claude
 * @param {string}   [deps.localToken]  本地代理准入凭证，接管时写进 ANTHROPIC_AUTH_TOKEN
 */
function createSetup({ claudeDir = DEFAULT_CLAUDE_DIR, localToken = null } = {}) {
  const settingsPath = path.join(claudeDir, 'settings.json');

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
    if (!fs.existsSync(settingsPath)) {
      return { exists: false, content: {} };
    }
    const raw = fs.readFileSync(settingsPath, 'utf8');
    try {
      return { exists: true, content: JSON.parse(raw) };
    } catch (err) {
      // 用户的 settings.json 本身就不是合法 JSON。这时绝不能贸然覆盖，
      // 那会把用户原有的配置彻底抹掉。
      throw new Error(
        `无法解析 ${settingsPath}：${err.message}\n` +
          `为避免破坏你的现有配置，本工具不会写入。请先手动修复该文件。`
      );
    }
  }

  /**
   * 原子写入，并**显式收紧权限**。
   *
   * 与 store.js 的 writeAtomic 同一个套路，理由也一样：进程在写入中途崩溃时，
   * 目标文件会变成半截 JSON，下次启动 Claude Code 直接读不了，而用户很难
   * 想到是这个工具干的。
   *
   * 权限这一项尤其容易漏：`writeFileSync` 不传 mode 时，临时文件按
   * `0o666 & ~umask`（通常 0644）创建，`renameSync` 之后**用户原本 0600 的
   * settings.json 就被静默放宽了**。这个文件里存着用户的真实 API key。
   */
  function writeSettings(next) {
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
    }
    const tmpPath = `${settingsPath}.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n', { mode: FILE_MODE });
      fs.renameSync(tmpPath, settingsPath);
      // rename 会保留临时文件的权限，但目标文件原本已存在且权限更宽时，
      // 某些平台上的行为不完全一致，这里再显式收紧一次。
      fs.chmodSync(settingsPath, FILE_MODE);
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // 临时文件可能压根没创建成功，忽略
      }
      throw err;
    }
  }

  /**
   * 构造写入后的 settings 内容：只动 env 里的两个键，其余原样保留。
   *
   * ANTHROPIC_AUTH_TOKEN 写的是**本地准入凭证**而不是固定的占位符：
   * 真实 API key 仍由本工具持有并按请求注入，Claude Code 侧不需要知道。
   * 用随机凭证而非公开常量，是为了让同机的其它进程即便发现了代理端口，
   * 也无法借它白用用户的真实 key（见 store.js 的 getLocalToken）。
   */
  function buildNextSettings(current, proxyBaseUrl, token) {
    const env = { ...(current.env || {}) };
    env.ANTHROPIC_BASE_URL = proxyBaseUrl;
    env.ANTHROPIC_AUTH_TOKEN = token;
    // 注意：这里刻意不碰 ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL。
    // 那些是用户对自己所用模型的配置，与走不走代理无关，保留即可。
    return { ...current, env };
  }

  /**
   * 备份路径。
   *
   * ISO 时间串里的冒号和点不能直接用于文件名。
   *
   * ⚠️ 只应由 `applyClaudeSettings` 在**首次接管**时调用。以前预览阶段也调一次
   * 来「预告」备份路径，结果预览显示的名字和真正生成的文件对不上（两次调用
   * 的时间戳不同），用户照提示去找备份只能扑空。现在预览只返回布尔语义。
   */
  function makeBackupPath() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${settingsPath}.bak.${stamp}`;
  }

  /**
   * 生成改动预览。不写入任何内容，只读取和计算。
   *
   * @param {object} deps
   * @param {string} deps.proxyBaseUrl  本次要写入的代理地址（取自 proxy.baseUrl）
   * @param {object} [deps.takeover]    已有的接管状态，用于判断是否为首次接管
   * @returns {object} 供 UI 逐项展示给用户确认
   */
  function previewClaudeSettings({ proxyBaseUrl, takeover = null }) {
    const { exists, content } = readCurrentSettings();
    const appliedToken = localToken || LEGACY_PLACEHOLDER_TOKEN;
    const next = buildNextSettings(content, proxyBaseUrl, appliedToken);

    const changes = MANAGED_KEYS.map((key) => ({
      key,
      from: hasOwn(content.env, key) ? content.env[key] : null,
      to: next.env[key],
    }));

    return {
      settingsPath,
      exists,
      changes,
      // 展示给用户看的完整前后对照
      before: content.env || {},
      after: next.env,
      // 只给布尔语义，不给具体路径 —— 路径由 apply 的返回值给出（见 makeBackupPath）
      willBackup: exists && !(takeover && takeover.backupPath),
      managedConflict: detectManagedConflict(),
    };
  }

  /**
   * 接管：先备份（仅首次），再原子写入。
   *
   * 「首次」的判定依据是 `previousTakeover`（存在即说明此前接管过）——
   * 不能用「文件里有没有 .bak」，那个用户随时可能删掉。
   *
   * 每次接管都会**刷新** `previous` 与 `applied`：
   *   - `applied` 记录本次真正写进去的值，供还原时判定「这是我们写的」
   *   - `previous` 记录**本次接管前**的实际值，供还原时回滚
   *
   * 后者是 PRD 第 1 版被推翻的地方：把 previous 定义成「首次接入那天的快照」，
   * 会让用户在应用关着时改的配置在下次退出时被静默覆盖掉 —— 正是本工具
   * 最该避免的事。
   *
   * @returns {object} { settingsPath, backupPath, createdBackup, applied, previous,
   *                     fileExisted, residualDetected }
   */
  function applyClaudeSettings({ proxyBaseUrl, previousTakeover = null }) {
    if (!proxyBaseUrl) {
      // R7 的准入条件之一。兜底地址会把一个必然连不上的地址写进用户配置，
      // 正好制造出「用户完全想不到是工具干的」那种故障。
      throw new Error('代理尚未就绪，拒绝写入 Claude Code 配置');
    }

    const { exists, content } = readCurrentSettings();
    const env = content.env || {};
    const appliedToken = localToken || LEGACY_PLACEHOLDER_TOKEN;
    const priorPrevious = (previousTakeover && previousTakeover.previous) || {};

    // 逐键算出「本次接管前的真实值」，同时认出残渣
    const previous = {};
    let residualDetected = false;

    for (const key of MANAGED_KEYS) {
      const present = hasOwn(env, key);
      const current = present ? env[key] : null;

      if (looksLikeOurOwnValue(key, current, { localToken, proxyBaseUrl })) {
        // 是残渣（应用被强杀留下的），或我们上一轮写的值还没还原。
        // 绝不能记进 previous —— 那会让还原把死值写回给用户。
        // 沿用手上已有的 previous；确实没有（首次接管却撞见残渣）时记 null，
        // 表示「原本没有这个键」，还原时删除它。
        residualDetected = true;
        previous[key] = hasOwn(priorPrevious, key) ? priorPrevious[key] : null;
        continue;
      }

      // 用 hasOwnProperty 而不是 `|| null`：""、0、false 都是合法取值，
      // 被折叠成 null 会让还原把「空串」和「键不存在」混为一谈。
      previous[key] = present ? current : null;
    }

    const next = buildNextSettings(content, proxyBaseUrl, appliedToken);
    const applied = {
      ANTHROPIC_BASE_URL: next.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: next.env.ANTHROPIC_AUTH_TOKEN,
    };

    // 备份只在首次接管时产生一次。否则「每次启动自动接管」会让
    // ~/.claude/ 里一天堆出十个 .bak 文件。
    let backupPath = (previousTakeover && previousTakeover.backupPath) || null;
    let createdBackup = false;
    if (exists && !backupPath) {
      backupPath = makeBackupPath();
      fs.copyFileSync(settingsPath, backupPath);
      createdBackup = true;
    }

    writeSettings(next);

    return {
      settingsPath,
      backupPath,
      createdBackup,
      applied,
      previous,
      fileExisted: exists,
      residualDetected,
    };
  }

  /**
   * 还原：把两个受管键按当前值分三种情形处理（PRD 的 R5）。
   *
   * | 当前值            | 含义                     | 动作                        |
   * |-------------------|--------------------------|-----------------------------|
   * | 等于 applied[key] | 是我们写的，没被动过      | 回滚为 previous[key]        |
   * | 等于 previous[key]| 已是目标状态（刚还原过）  | 不写、不标记（幂等）        |
   * | 其它              | 用户自己改过              | 保持不动，标记出来告知用户  |
   *
   * 第二条分支是幂等的落点：没有它，第二次还原会把「我们刚写回去的原值」
   * 误报成「用户改过」，产生假告警。
   *
   * @returns {object} { ok, written, restored, alreadyRestored, externallyModified,
   *                     fileRemoved, settingsPath }
   */
  function restoreClaudeSettings({ takeover }) {
    const state = takeover || {};
    const applied = state.applied || {};
    const previous = state.previous || {};

    const { exists, content } = readCurrentSettings();
    if (!exists) {
      // 文件没了（用户在接管期间自己删掉）。没有可还原的对象，也不算失败。
      return {
        ok: true,
        settingsPath,
        restored: [],
        alreadyRestored: [],
        externallyModified: [],
        fileRemoved: false,
        reason: '配置文件不存在，无需还原',
      };
    }

    /** 判断「当前状态」是否等于某个目标值；目标为 null 表示「该键不应存在」。 */
    const equals = (present, current, target) =>
      target === null || target === undefined ? !present : present && current === target;

    const env = { ...(content.env || {}) };
    const restored = [];
    const alreadyRestored = [];
    const externallyModified = [];

    for (const key of MANAGED_KEYS) {
      const present = hasOwn(env, key);
      const current = present ? env[key] : null;

      if (equals(present, current, hasOwn(previous, key) ? previous[key] : null)) {
        alreadyRestored.push(key);
        continue;
      }

      if (equals(present, current, hasOwn(applied, key) ? applied[key] : null)) {
        const target = hasOwn(previous, key) ? previous[key] : null;
        if (target === null) delete env[key];
        else env[key] = target;
        restored.push(key);
        continue;
      }

      // 用户自己改过 —— 保持不动。无条件覆盖会把用户的修改静默丢掉。
      externallyModified.push(key);
    }

    const hasWork = restored.length > 0;
    let fileRemoved = false;

    if (hasWork) {
      const next = { ...content, env };

      // 接入前文件本来不存在时，是我们把它创建出来的。若还原后它只剩一个
      // 空的 env、没有任何用户内容，就该把它删掉 —— 否则会凭空留下一个
      // 用户从未创建过的 `{"env": {}}`，与「还原到接管前」的承诺不符。
      if (state.fileExisted === false && isEmptyShell(next)) {
        fs.unlinkSync(settingsPath);
        fileRemoved = true;
      } else {
        writeSettings(next);
      }
    }

    return {
      ok: true,
      settingsPath,
      restored,
      alreadyRestored,
      externallyModified,
      fileRemoved,
    };
  }

  /** 判定一份 settings 内容是不是「空壳」：没有顶层键，或只有一个空的 env。 */
  function isEmptyShell(content) {
    const keys = Object.keys(content || {});
    if (keys.length === 0) return true;
    if (keys.length === 1 && keys[0] === 'env') {
      return Object.keys(content.env || {}).length === 0;
    }
    return false;
  }

  /**
   * 读出 Claude Code 实际会发出的模型名。
   *
   * 这些名字正是「模型映射」左边那一列 —— 让工具把它们读出来，而不是让用户默写，
   * 是从根上消灭"模型名写错"这类错误（见设计文档 6.5 记录的真实事故）。
   *
   * 纯读取，不写入任何内容。读不到时返回 `ok:false` 而不是抛错：
   * 这只是一个便利功能，不该因为它失败就让用户连供应商都加不了。
   */
  function readClaudeModelNames() {
    let content;
    try {
      const read = readCurrentSettings();
      if (!read.exists) {
        return { ok: false, settingsPath, reason: '尚未创建 Claude Code 配置文件' };
      }
      content = read.content;
    } catch (err) {
      return { ok: false, settingsPath, reason: err.message };
    }

    const entries = extractModelNames(content.env);
    if (entries.length === 0) {
      return {
        ok: false,
        settingsPath,
        reason: '配置里没有以 _MODEL 结尾的项，无法推断 Claude Code 会发出什么模型名',
      };
    }
    const { main, fast } = classifyModelNames(entries);
    return { ok: true, entries, main, fast, settingsPath };
  }

  return {
    claudeDir,
    settingsPath,
    previewClaudeSettings,
    applyClaudeSettings,
    restoreClaudeSettings,
    readClaudeModelNames,
    readCurrentSettings,
    detectManagedConflict,
  };
}

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
  createSetup,
  DEFAULT_CLAUDE_DIR,
  MANAGED_KEYS,
  PROXY_PORT_RANGE,
  LEGACY_PLACEHOLDER_TOKEN,
  hasOwn,
  looksLikeOurOwnValue,
  extractModelNames,
  classifyModelNames,
};
