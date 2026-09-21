'use strict';

/**
 * store.js 中「接管状态」与「本地准入凭证」两块的单元测试。
 *
 * 两块都是后加的，且都属于**看不见但错了很贵**的类型：
 *   - 接管状态被写坏 → 退出时还原不回去，用户的 Claude Code 配置丢在原处
 *   - 准入凭证被写坏 → 代理要么谁都放进来，要么连 Claude Code 自己都进不来
 *
 * 与 setup.test.js 同一范式：全部在 mkdtemp 隔离目录上跑，不碰用户真实的
 * ~/.cc-nbproject/profiles.json。目录不做清理，交给系统回收。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore } = require('../src/main/store.js');

function makeStore(preloaded) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnb-store-'));
  const profilesFile = path.join(dir, 'profiles.json');
  if (preloaded !== undefined) {
    fs.writeFileSync(profilesFile, JSON.stringify(preloaded, null, 2) + '\n');
  }
  return {
    dir,
    profilesFile,
    store: createStore({ dir }),
    read: () => JSON.parse(fs.readFileSync(profilesFile, 'utf8')),
  };
}

// ---------------------------------------------------------------------------
// 本地准入凭证
// ---------------------------------------------------------------------------

test('getLocalToken：首次调用生成并落盘，之后每次都返回同一个', () => {
  const rig = makeStore();

  const first = rig.store.getLocalToken();

  // 32 字节 = 256 位，十六进制即 64 个字符。位数够宽才谈得上「猜不到」——
  // 这个值就是本机其它进程能不能白用用户真实 key 的唯一门槛。
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(rig.read().settings.localToken, first);

  // 必须持久化：每次启动重新生成的话，上一个应用实例写进 Claude Code 的凭证
  // 会立刻失效，Claude Code 直接连不上自己家的代理
  assert.equal(rig.store.getLocalToken(), first);

  // 换个实例读同一个目录，应当拿到同一个值
  assert.equal(createStore({ dir: rig.dir }).getLocalToken(), first);
});

test('getLocalToken：两个安装目录生成的凭证不同', () => {
  const a = makeStore();
  const b = makeStore();

  assert.notEqual(a.store.getLocalToken(), b.store.getLocalToken());
});

test('凭证与 API key 同存于 0600 的文件里，不额外扩大暴露面', () => {
  const rig = makeStore();
  rig.store.getLocalToken();

  assert.equal(fs.statSync(rig.profilesFile).mode & 0o777, 0o600);
});

test('旧配置文件没有 localToken 字段时自动补上，不报错', () => {
  // 升级场景：老版本的 profiles.json 里没有 settings.localToken
  const rig = makeStore({
    version: 1,
    activeId: null,
    profiles: [],
    settings: { port: 8787 },
  });

  const token = rig.store.getLocalToken();

  assert.match(token, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// 接管状态
// ---------------------------------------------------------------------------

const PREVIOUS = {
  ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
  ANTHROPIC_AUTH_TOKEN: 'sk-real-user-key',
};

test('getTakeover：从未接管过时返回 null，而不是 undefined 或空对象', () => {
  const rig = makeStore();

  // 界面靠 `state === 'off'` 判断显示哪一行，返回 {} 会让它误以为接管过
  assert.equal(rig.store.getTakeover(), null);
});

test('patchTakeover：合并而不是整份覆盖，不会把别人的字段抹掉', () => {
  const rig = makeStore();
  rig.store.setTakeover({
    enabled: true,
    applied: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' },
    previous: PREVIOUS,
    backupPath: '/Users/x/.claude/settings.json.bak.2026-09-22',
  });

  // 退出还原时只更新 lastRestore
  rig.store.patchTakeover({ lastRestore: { ok: true, at: '2026-09-22T10:00:00.000Z', reason: null } });

  const after = rig.store.getTakeover();
  assert.equal(after.lastRestore.ok, true);
  // 这几项要是在合并时丢了，用户就再也没法还原了
  assert.deepEqual(after.previous, PREVIOUS);
  assert.equal(after.enabled, true);
  assert.equal(after.backupPath, '/Users/x/.claude/settings.json.bak.2026-09-22');
});

test('patchTakeover：在从未接管过时只写 patch 里的字段，绝不凭空产生 enabled（R11）', () => {
  const rig = makeStore();

  // 接管失败时主进程走的就是这条路：只记 lastApply，不碰 enabled
  rig.store.patchTakeover({ lastApply: { ok: false, at: '2026-09-22T10:00:00.000Z', reason: '代理未运行' } });

  const after = rig.store.getTakeover();
  assert.deepEqual(Object.keys(after), ['lastApply']);
  // 这是 R11 的机制保证：写序反了的话，界面会显示「已接管」而文件其实还是原样，
  // 退出还原又因为文件里的值不等于 applied 而跳过 —— 两头都对不上
  assert.equal(after.enabled, undefined);
  assert.equal(Boolean(after.enabled), false);
});

test('setTakeover(null)：断开接入后清除授权记忆，下次启动不再自动接管', () => {
  const rig = makeStore();
  rig.store.setTakeover({ enabled: true, previous: PREVIOUS });
  assert.equal(rig.store.getTakeover().enabled, true);

  rig.store.setTakeover(null);

  assert.equal(rig.store.getTakeover(), null);
  // 落盘确认：不能只是内存里清了
  assert.equal(rig.read().settings.takeover, null);
});

test('getTakeover：文件里是坏值时退化成 null，不把垃圾对象交给调用方', () => {
  const rig = makeStore({
    version: 1,
    activeId: null,
    profiles: [],
    settings: { port: 8787, takeover: '这不是对象' },
  });

  // 调用方会直接读 takeover.applied / takeover.previous，
  // 给出去一个字符串只会让失败发生在更远、更难查的地方
  assert.equal(rig.store.getTakeover(), null);
});

test('接管状态与凭证互不干扰：写其一时另一个原样保留', () => {
  const rig = makeStore();

  const token = rig.store.getLocalToken();
  rig.store.setTakeover({ enabled: true, previous: PREVIOUS });
  rig.store.patchTakeover({ lastApply: { ok: true, at: '2026-09-22T10:00:00.000Z', reason: null } });

  // 两者都走 load() → save() 的读改写，很容易出现「后写的把先写的冲掉」
  assert.equal(rig.store.getLocalToken(), token);
  assert.equal(rig.read().settings.takeover.enabled, true);
  assert.equal(rig.read().settings.port, 8787, '未被改动的设置项不该丢');
});
