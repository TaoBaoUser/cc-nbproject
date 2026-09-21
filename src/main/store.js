'use strict';

/**
 * 配置存储层：读写 ~/.cc-nbproject/profiles.json
 *
 * 设计决策记录见 docs/plans/2026-09-21-cc-nbproject-design.md 第 6.4 / 7 节。
 *
 * 为什么导出的是工厂函数 createStore()，而不是一组模块级函数？
 * —— 因为测试需要把数据写到临时目录，不能污染用户真实的 ~/.cc-nbproject。
 *    把目录作为参数注入，测试就能用 mkdtemp 造一个隔离环境。这是本项目
 *    "让核心逻辑可独立测试" 原则的一部分（与 proxy.js 的依赖注入同源）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIR = path.join(os.homedir(), '.cc-nbproject');

/** 配置文件的初始形态。首次运行时会以此为准创建。 */
const DEFAULT_STATE = {
  version: 1,
  activeId: null,
  profiles: [],
  settings: {
    port: 8787,
    // 本地代理的准入凭证。见 getLocalToken()。
    localToken: null,
    // 接管状态的快照。结构见 docs/plans/2026-09-21-接管与还原-prd.md 第 3.1 节。
    // null 表示从未接管过。
    takeover: null,
  },
};

/** 本地准入凭证的长度（字节）。32 字节 = 256 位，口令学上远超暴力枚举。 */
const LOCAL_TOKEN_BYTES = 32;

/**
 * 文件权限：仅所有者可读写。
 * API key 以明文存放在此文件中，权限位是它的第一道防线。
 */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * 校验并归一化模型映射表。
 *
 * 映射表用于解决"同一个模型在不同供应商那里叫法不同"的问题：
 * Claude Code 发出的是它自己配置里的模型名，而供应商要求的是自己的模型 ID。
 * 详见 proxy.js 的 rewriteModel。
 *
 * 任何非法输入都退化成空对象（表示"不做映射"），而不是抛错 ——
 * 一个填错的映射规则不该让整个供应商配置无法保存。
 */
function sanitizeModelMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [from, to] of Object.entries(raw)) {
    const source = typeof from === 'string' ? from.trim() : '';
    const target = to === undefined || to === null ? '' : String(to).trim();
    if (source && target) out[source] = target;
  }
  return out;
}

function createStore({ dir = DEFAULT_DIR } = {}) {
  const profilesFile = path.join(dir, 'profiles.json');

  function ensureDir() {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    }
  }

  /**
   * 原子写入。
   *
   * 为什么不能直接 fs.writeFileSync(目标路径)：
   * 若进程在写入过程中崩溃（或磁盘写满），目标文件会变成半截 JSON。
   * 下次启动时 JSON.parse 抛错，工具将完全无法启动，且用户很难自行修复
   * —— 那里面存着他所有的 API key。
   *
   * 改为「写临时文件 → rename 覆盖」：同一文件系统内的 rename 是原子操作，
   * 目标文件要么是完整的旧内容，要么是完整的新内容，不存在中间态。
   */
  function writeAtomic(targetPath, content) {
    ensureDir();
    // 临时文件名带上 pid 与时间戳，避免多个实例同时写时互相踩踏
    const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tmpPath, content, { mode: FILE_MODE });
      fs.renameSync(tmpPath, targetPath);
      // rename 会保留临时文件的权限，但如果目标文件原本已存在且权限更宽，
      // 某些平台上的行为不完全一致，这里再显式收紧一次。
      fs.chmodSync(targetPath, FILE_MODE);
    } catch (err) {
      // 失败时清理临时文件，避免在用户目录里堆积垃圾
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // 临时文件可能压根没创建成功，忽略
      }
      throw err;
    }
  }

  function load() {
    if (!fs.existsSync(profilesFile)) {
      return structuredClone(DEFAULT_STATE);
    }
    const raw = fs.readFileSync(profilesFile, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `配置文件损坏，无法解析：${profilesFile}\n` +
          `请检查该文件是否为合法 JSON，或删除它让程序重建（会丢失已保存的供应商）。\n` +
          `原始错误：${err.message}`
      );
    }
    // 与默认值合并，容忍旧版本配置文件缺少新增字段
    return {
      ...structuredClone(DEFAULT_STATE),
      ...parsed,
      settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
    };
  }

  function save(state) {
    writeAtomic(profilesFile, JSON.stringify(state, null, 2) + '\n');
  }

  function listProfiles() {
    return load().profiles;
  }

  function getActiveProfile() {
    const state = load();
    if (!state.activeId) return null;
    return state.profiles.find((p) => p.id === state.activeId) || null;
  }

  function setActive(id) {
    const state = load();
    const exists = state.profiles.some((p) => p.id === id);
    if (!exists) {
      throw new Error(`不存在 id 为 ${id} 的供应商`);
    }
    state.activeId = id;
    save(state);
    return state.profiles.find((p) => p.id === id);
  }

  function addProfile({ name, baseUrl, apiKey, modelMap }) {
    if (!name || !baseUrl) {
      throw new Error('name 与 baseUrl 为必填项');
    }
    const state = load();
    const profile = {
      id: crypto.randomUUID(),
      name: String(name).trim(),
      baseUrl: String(baseUrl).trim(),
      apiKey: apiKey ? String(apiKey).trim() : '',
      modelMap: sanitizeModelMap(modelMap),
      createdAt: new Date().toISOString(),
    };
    state.profiles.push(profile);
    // 第一个添加的供应商自动激活，省去用户一次多余点击
    if (!state.activeId) {
      state.activeId = profile.id;
    }
    save(state);
    return profile;
  }

  function updateProfile(id, patch) {
    const state = load();
    const idx = state.profiles.findIndex((p) => p.id === id);
    if (idx === -1) {
      throw new Error(`不存在 id 为 ${id} 的供应商`);
    }
    // 显式白名单，防止调用方意外覆盖 id / createdAt
    const allowed = ['name', 'baseUrl', 'apiKey'];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        state.profiles[idx][key] = String(patch[key]).trim();
      }
    }
    // modelMap 是对象，不能走上面的 String() 路径
    if (patch.modelMap !== undefined) {
      state.profiles[idx].modelMap = sanitizeModelMap(patch.modelMap);
    }
    save(state);
    return state.profiles[idx];
  }

  function removeProfile(id) {
    const state = load();
    const idx = state.profiles.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    state.profiles.splice(idx, 1);
    // 删掉的恰好是当前激活项时，把激活状态转移给剩下的第一个，
    // 否则 activeId 会指向一个不存在的 id，代理将陷入"无可用供应商"
    if (state.activeId === id) {
      state.activeId = state.profiles.length > 0 ? state.profiles[0].id : null;
    }
    save(state);
    return true;
  }

  function getSettings() {
    return load().settings;
  }

  /**
   * 取出本地代理的准入凭证，没有就生成一个并落盘。
   *
   * **为什么需要它**：代理监听在 127.0.0.1 上，本意是「只有本机能访问」。
   * 但「本机」不等于「本用户」—— 同一台机器上的任何进程、任何账户，只要能连
   * 127.0.0.1:8787，就能让代理拿**用户真实的 API key** 去发请求并计费。
   * 而代理原先刻意丢弃客户端凭证、无条件换成 profile.apiKey，等于一个敞开的中转站。
   *
   * 修法是把「凭证」变成只有本工具与 Claude Code 知道的一次性随机值：
   * 接管时把它写进 Claude Code 的 ANTHROPIC_AUTH_TOKEN，代理只认它。
   * 于是同机的其它进程即使发现端口也过不了准入。
   *
   * 凭证与 API key 同存于 profiles.json（权限 0600），不增加新的暴露面 ——
   * 能读到这个文件的人本来就已经拿到了所有真实 key。
   */
  function getLocalToken() {
    const state = load();
    const existing = state.settings.localToken;
    if (typeof existing === 'string' && existing) return existing;

    // randomUUID 的熵对本地准入够用，但它是 122 位且带固定格式；
    // 直接取 32 字节随机数的十六进制，位数更宽也更难被猜到规律。
    const token = crypto.randomBytes(LOCAL_TOKEN_BYTES).toString('hex');
    state.settings.localToken = token;
    save(state);
    return token;
  }

  /** 读取接管状态快照；从未接管过时返回 null。 */
  function getTakeover() {
    const value = load().settings.takeover;
    return value && typeof value === 'object' ? value : null;
  }

  /** 整体替换接管状态。传 null 表示清除（断开接入成功之后）。 */
  function setTakeover(next) {
    const state = load();
    state.settings.takeover = next || null;
    save(state);
    return state.settings.takeover;
  }

  /**
   * 合并式更新接管状态。
   *
   * 接管状态是「读文件 → 算 → 写文件 → 写状态」这串复合动作的产物，
   * 各处只会更新自己那几个字段（applied / previous 在接管时刷新，
   * lastRestore 在退出时刷新）。用合并而不是整份覆盖，避免某个调用点
   * 漏带字段时把别人的成果抹掉 —— 比如把 previous 冲成 undefined，
   * 下一次还原就没有目标可回了。
   */
  function patchTakeover(patch) {
    const state = load();
    const current = state.settings.takeover;
    const base = current && typeof current === 'object' ? current : {};
    state.settings.takeover = { ...base, ...patch };
    save(state);
    return state.settings.takeover;
  }

  return {
    dir,
    profilesFile,
    load,
    save,
    listProfiles,
    getActiveProfile,
    setActive,
    addProfile,
    updateProfile,
    removeProfile,
    getSettings,
    getLocalToken,
    getTakeover,
    setTakeover,
    patchTakeover,
  };
}

module.exports = { createStore, DEFAULT_DIR, DEFAULT_STATE };
