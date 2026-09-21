'use strict';

/**
 * setup.js 的单元测试，分两部分：
 *
 * 1. 模型名解析（`extractModelNames` / `classifyModelNames`）—— 纯函数。
 * 2. **接管与还原** —— 本项目风险最高的一段逻辑。
 *
 * 第二部分之所以能测，靠的是 setup.js 做成了可注入路径的工厂：
 * 每个用例都在 `mkdtemp` 造出的隔离目录上跑，绝不碰用户真实的
 * `~/.claude/settings.json`。在此之前这段逻辑写在模块顶层、路径写死，
 * 「测一下」就意味着去读写用户的私人文件 —— 于是它从来没被测过。
 *
 * 用例编号对应 docs/plans/2026-09-21-接管与还原-prd.md 第 6.1 节的十四条。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createSetup,
  extractModelNames,
  classifyModelNames,
  LEGACY_PLACEHOLDER_TOKEN,
} = require('../src/main/setup.js');

/** 代理监听在这个地址上。 */
const PROXY_URL = 'http://127.0.0.1:8787';
/** 本次安装的本地准入凭证（生产里由 store.getLocalToken 随机生成）。 */
const LOCAL_TOKEN = 'f'.repeat(64);
const MANAGED_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];

/** 一份形状真实的用户配置：受管键 + 模型键 + 非 env 的其它设置。 */
const USER_SETTINGS = {
  env: {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'sk-real-user-key',
    ANTHROPIC_MODEL: 'deepseek-v4-pro',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
  },
  permissions: { allow: ['Bash(ls:*)'] },
};

/**
 * 在隔离目录上搭一套「夹具」：一个 setup 实例 + 几个读写该目录的小工具。
 *
 * @param {object} [opts]
 * @param {object} [opts.settings] 预置的 settings.json 内容；不传则不创建该文件
 */
function makeRig({ settings } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnb-setup-'));
  const settingsPath = path.join(dir, 'settings.json');

  if (settings !== undefined) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  }

  return {
    dir,
    settingsPath,
    setup: createSetup({ claudeDir: dir, localToken: LOCAL_TOKEN }),
    exists: () => fs.existsSync(settingsPath),
    /** 文件原始文本。用来做「一个字节都没动」这类断言。 */
    raw: () => fs.readFileSync(settingsPath, 'utf8'),
    read: () => JSON.parse(fs.readFileSync(settingsPath, 'utf8')),
    /** 目录里由本工具产生的备份文件名。 */
    backups: () => fs.readdirSync(dir).filter((name) => name.includes('.bak.')),
    /** 就地改写 settings.json，模拟「用户在应用运行期间手动编辑」。 */
    write(transform) {
      const next = transform(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
      fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    },
  };
}

/** 只读一个字段，且不把「键不存在」与「值为 undefined」混起来。 */
function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}


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

// ---------------------------------------------------------------------------
// classifyModelNames：卡片上那两个下拉各自对应 Claude Code 的哪种请求
// ---------------------------------------------------------------------------

test('classifyModelNames：按配置键而不是按名字分主模型与小任务', () => {
  // 用户真实的配置形状。名字是用户随便起的，键才是 Claude Code 定义的语义 ——
  // 分类若靠名字猜，换个供应商就全错了。
  const entries = extractModelNames({
    ANTHROPIC_MODEL: 'deepseek-v4-pro',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
    ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-flash',
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
  });

  assert.deepEqual(classifyModelNames(entries), {
    main: 'deepseek-v4-pro',
    fast: 'deepseek-flash',
  });
});

test('classifyModelNames：名字顺序反过来也认得出', () => {
  // 不能依赖"小任务那个一定排在后面"
  const entries = extractModelNames({
    ANTHROPIC_SMALL_FAST_MODEL: 'cheap',
    ANTHROPIC_MODEL: 'expensive',
  });

  assert.deepEqual(classifyModelNames(entries), { main: 'expensive', fast: 'cheap' });
});

test('classifyModelNames：只有一种模型名时，fast 为 null', () => {
  // 否则卡片上会出现两个指向同一个名字的下拉，纯属迷惑
  const entries = extractModelNames({ ANTHROPIC_MODEL: 'only-one' });

  assert.deepEqual(classifyModelNames(entries), { main: 'only-one', fast: null });
});

test('classifyModelNames：同一个名字同时占了两类时，只保留"主"', () => {
  const entries = extractModelNames({
    ANTHROPIC_MODEL: 'same',
    ANTHROPIC_SMALL_FAST_MODEL: 'same',
  });

  assert.deepEqual(classifyModelNames(entries), { main: 'same', fast: null });
});

test('classifyModelNames：指向小任务的键更多时，仍按归属而非数量分', () => {
  const entries = extractModelNames({
    ANTHROPIC_MODEL: 'big',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'small',
    ANTHROPIC_SMALL_FAST_MODEL: 'small',
    CLAUDE_CODE_SUBAGENT_MODEL: 'small',
  });

  assert.deepEqual(classifyModelNames(entries), { main: 'big', fast: 'small' });
});

test('classifyModelNames：空输入与畸形输入都返回两项 null，不抛错', () => {
  assert.deepEqual(classifyModelNames([]), { main: null, fast: null });
  assert.deepEqual(classifyModelNames(undefined), { main: null, fast: null });
  assert.deepEqual(classifyModelNames([{ name: 'x' }]), { main: null, fast: null });
});

// ===========================================================================
// 接管与还原
//
// 每个用例都在 mkdtemp 隔离目录上跑。注意这里**不清理**临时目录 ——
// 用例创建的目录交给系统回收，以免测试代码里出现任何 rm 类操作。
// ===========================================================================

test('1. 接管：首次接入记录 previous/fileExisted、产生一个备份、写入 applied', () => {
  const rig = makeRig({ settings: USER_SETTINGS });
  const result = rig.setup.applyClaudeSettings({ proxyBaseUrl: PROXY_URL });

  assert.equal(result.fileExisted, true);
  assert.equal(result.createdBackup, true);
  // previous 是**本次接管前**的真实值 —— 不是「首次接入那天的快照」。
  // 后者会让用户在应用关着时改的配置被静默覆盖掉（见 PRD 第 3.2 节）。
  assert.deepEqual(result.previous, {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'sk-real-user-key',
  });
  assert.deepEqual(result.applied, {
    ANTHROPIC_BASE_URL: PROXY_URL,
    ANTHROPIC_AUTH_TOKEN: LOCAL_TOKEN,
  });

  const after = rig.read();
  assert.equal(after.env.ANTHROPIC_BASE_URL, PROXY_URL);
  assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, LOCAL_TOKEN);

  // 只碰这两个键：模型相关配置与 env 之外的内容原样保留
  assert.equal(after.env.ANTHROPIC_MODEL, 'deepseek-v4-pro');
  assert.equal(after.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-flash');
  assert.deepEqual(after.permissions, USER_SETTINGS.permissions);

  // 备份恰好一个，且内容是接管前的原文
  const backups = rig.backups();
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rig.dir, backups[0]), 'utf8')), USER_SETTINGS);

  // 权限必须是 0600：这个文件里有用户的真实 API key。
  // 漏掉这一项时，rename 会把用户原本 0600 的文件静默放宽成 0644。
  assert.equal(fs.statSync(rig.settingsPath).mode & 0o777, 0o600);
});

test('2. 还原：当前值等于 applied 时回到 previous', () => {
  const rig = makeRig({ settings: USER_SETTINGS });
  const applied = rig.setup.applyClaudeSettings({ proxyBaseUrl: PROXY_URL });
  const result = rig.setup.restoreClaudeSettings({
    takeover: {
      applied: applied.applied,
      previous: applied.previous,
      fileExisted: applied.fileExisted,
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.restored.sort(), [...MANAGED_KEYS].sort());
  assert.deepEqual(result.externallyModified, []);

  const after = rig.read();
  assert.equal(after.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, 'sk-real-user-key');
  // 接管期间没动过的键，还原后也不该动
  assert.equal(after.env.ANTHROPIC_MODEL, 'deepseek-v4-pro');
});

test('3. 还原：previous 里为 null 的键被删除，而不是写成空串', () => {
  // 用户原本只配了 BASE_URL，AUTH_TOKEN 这个键压根不存在
  const rig = makeRig({
    settings: { env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' } },
  });
  const applied = rig.setup.applyClaudeSettings({ proxyBaseUrl: PROXY_URL });
  assert.equal(applied.previous.ANTHROPIC_AUTH_TOKEN, null);

  rig.setup.restoreClaudeSettings({
    takeover: {
      applied: applied.applied,
      previous: applied.previous,
      fileExisted: applied.fileExisted,
    },
  });

  const after = rig.read();
  // 「该键不存在」与「该键是空串」是两回事，还原必须把键删掉
  assert.equal(has(after.env, 'ANTHROPIC_AUTH_TOKEN'), false);
  assert.equal(after.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
});

test('4. 还原：用户在接管期间手改过的键保持不动，并在返回值里标出', () => {
  const rig = makeRig({ settings: USER_SETTINGS });
  const applied = rig.setup.applyClaudeSettings({ proxyBaseUrl: PROXY_URL });

  // 用户在接管期间自己把 AUTH_TOKEN 改成了别的
  rig.write((cur) => {
    cur.env.ANTHROPIC_AUTH_TOKEN = 'sk-user-changed-it';
    return cur;
  });

  const result = rig.setup.restoreClaudeSettings({
    takeover: {
      applied: applied.applied,
      previous: applied.previous,
      fileExisted: applied.fileExisted,
    },
  });

  // 无条件覆盖会把用户的修改静默丢掉，所以必须跳过并告知
  assert.deepEqual(result.externallyModified, ['ANTHROPIC_AUTH_TOKEN']);
  assert.deepEqual(result.restored, ['ANTHROPIC_BASE_URL']);

  const after = rig.read();
  assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, 'sk-user-changed-it');
  assert.equal(after.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
});

test('5. 还原：当前值已等于 previous 时不写、不告警（幂等判定）', () => {
  // 文件已经是「还原后」的状态（例如上一轮还原成功但状态没来得及清）
  const rig = makeRig({ settings: USER_SETTINGS });
  const before = rig.raw();

  const result = rig.setup.restoreClaudeSettings({
    takeover: {
      applied: { ANTHROPIC_BASE_URL: PROXY_URL, ANTHROPIC_AUTH_TOKEN: LOCAL_TOKEN },
      previous: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'sk-real-user-key',
      },
      fileExisted: true,
    },
  });

  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.externallyModified, []);
  assert.deepEqual(result.alreadyRestored.sort(), [...MANAGED_KEYS].sort());
  // 一个字节都没动
  assert.equal(rig.raw(), before);
});

test('6. 还原幂等：连调两次，第二次什么都没做也不产生假告警', () => {
  const rig = makeRig({ settings: USER_SETTINGS });
  const applied = rig.setup.applyClaudeSettings({ proxyBaseUrl: PROXY_URL });
  const takeover = {
    applied: applied.applied,
    previous: applied.previous,
    fileExisted: applied.fileExisted,
  };

  rig.setup.restoreClaudeSettings({ takeover });
  const afterFirst = rig.raw();

  const second = rig.setup.restoreClaudeSettings({ takeover });

  // 没有第 5 条那条判定的话，第二次会把「我们刚写回去的原值」误报成
  // 「用户改过」—— 用户于是收到一条毫无根据的告警。
  assert.deepEqual(second.restored, []);
  assert.deepEqual(second.externallyModified, []);
  assert.equal(rig.raw(), afterFirst);
});

test('7. 还原：文件是非法 JSON 时抛错，且一个字节都不写', () => {
  const rig = makeRig();
  fs.writeFileSync(rig.settingsPath, '{ 这不是 JSON');
  const before = rig.raw();

  assert.throws(
    () =>
      rig.setup.restoreClaudeSettings({
        takeover: {
          applied: { ANTHROPIC_BASE_URL: PROXY_URL, ANTHROPIC_AUTH_TOKEN: LOCAL_TOKEN },
          previous: { ANTHROPIC_BASE_URL: null, ANTHROPIC_AUTH_TOKEN: null },
          fileExisted: true,
        },
      }),
    /无法解析/
  );

  // 用户的文件已经坏了，这时贸然覆盖会把里面剩下的内容也抹掉
  assert.equal(rig.raw(), before);
});

test('8. 还原：接入前文件不存在时，还原后文件仍然不存在', () => {
  const rig = makeRig(); // 目录里什么都没有
  const applied = rig.setup.applyClaudeSettings({ proxyBaseUrl: PROXY_URL });

  assert.equal(applied.fileExisted, false);
  assert.equal(applied.backupPath, null, '本来就没有文件可备份');
  assert.equal(rig.exists(), true, '文件是被我们创建出来的');

  const result = rig.setup.restoreClaudeSettings({
    takeover: {
      applied: applied.applied,
      previous: applied.previous,
      fileExisted: applied.fileExisted,
    },
  });

  // 「还原到接管前」包含「接管前它不存在」这一情形 ——
  // 否则会凭空留下一个用户从未创建过的 {"env": {}}，Claude Code 会照读不误
  assert.equal(result.fileRemoved, true);
  assert.equal(rig.exists(), false);
});

test('8b. 还原：文件本不存在、但接管期间用户往里写了别的内容时不删文件', () => {
  const rig = makeRig();
  const applied = rig.setup.applyClaudeSettings({ proxyBaseUrl: PROXY_URL });

  // 文件虽然是本工具创建的，但用户后来往里面加了自己的设置
  rig.write((cur) => {
    cur.statusLine = { type: 'command', command: 'echo hi' };
    return cur;
  });

  const result = rig.setup.restoreClaudeSettings({
    takeover: {
      applied: applied.applied,
      previous: applied.previous,
      fileExisted: false,
    },
  });

  assert.equal(result.fileRemoved, false);
  const after = rig.read();
  assert.deepEqual(after.statusLine, { type: 'command', command: 'echo hi' });
  assert.equal(has(after.env, 'ANTHROPIC_BASE_URL'), false);
  assert.equal(has(after.env, 'ANTHROPIC_AUTH_TOKEN'), false);
});

test('9. 接管：连续两次「启动接管」不产生新备份', () => {
  const rig = makeRig({ settings: USER_SETTINGS });

  const first = rig.setup.applyClaudeSettings({ proxyBaseUrl: PROXY_URL });
  assert.equal(first.createdBackup, true);

  const second = rig.setup.applyClaudeSettings({
    proxyBaseUrl: PROXY_URL,
    previousTakeover: { backupPath: first.backupPath, previous: first.previous },
  });

  // 「每次启动自动接管」若每次都备份，~/.claude/ 里一天能堆出十个 .bak
  assert.equal(second.createdBackup, false);
  assert.equal(second.backupPath, first.backupPath);
  assert.equal(rig.backups().length, 1);
});

test('10. 接管：应用关着时用户改的配置，会成为下一次还原的目标值（R2 的定义）', () => {
  const rig = makeRig({ settings: USER_SETTINGS });

  // 第一次：接管 → 退出还原
  const first = rig.setup.applyClaudeSettings({ proxyBaseUrl: PROXY_URL });
  rig.setup.restoreClaudeSettings({
    takeover: {
      applied: first.applied,
      previous: first.previous,
      fileExisted: first.fileExisted,
    },
  });

  // 应用关着的时候，用户换了个供应商
  rig.write((cur) => {
    cur.env.ANTHROPIC_BASE_URL = 'https://api.moonshot.cn/anthropic';
    cur.env.ANTHROPIC_AUTH_TOKEN = 'sk-new-user-key';
    return cur;
  });

  // 再次启动 → 接管 → 退出还原
  const second = rig.setup.applyClaudeSettings({
    proxyBaseUrl: PROXY_URL,
    previousTakeover: { backupPath: first.backupPath, previous: first.previous },
  });

  // 关键：previous 刷新成了用户新改的值，而不是第一次接管前的旧值。
  // 若沿用旧值，用户这次的修改就在「退出还原」时被静默回退了。
  assert.equal(second.previous.ANTHROPIC_BASE_URL, 'https://api.moonshot.cn/anthropic');
  assert.equal(second.previous.ANTHROPIC_AUTH_TOKEN, 'sk-new-user-key');

  rig.setup.restoreClaudeSettings({
    takeover: {
      applied: second.applied,
      previous: second.previous,
      fileExisted: second.fileExisted,
    },
  });

  const after = rig.read();
  assert.equal(after.env.ANTHROPIC_BASE_URL, 'https://api.moonshot.cn/anthropic');
  assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, 'sk-new-user-key');
});

test('11. 接管：文件里残留上一轮的 applied 时，绝不把它当成用户原值记进 previous', () => {
  // 模拟 kill -9 / 断电：应用没来得及还原，文件里留着我们写的值。
  // 这是全项目最容易造成**数据破坏**的一处：一旦把残渣记进 previous，
  // 下次还原就会把死值写回去，用户真实的地址与凭证被彻底丢掉，
  // 而工具还会报告「已还原成功」。
  const rig = makeRig({
    settings: {
      env: {
        ANTHROPIC_BASE_URL: PROXY_URL,
        ANTHROPIC_AUTH_TOKEN: LOCAL_TOKEN,
        ANTHROPIC_MODEL: 'deepseek-v4-pro',
      },
    },
  });

  const result = rig.setup.applyClaudeSettings({ proxyBaseUrl: PROXY_URL });

  assert.equal(result.residualDetected, true);
  assert.equal(result.previous.ANTHROPIC_BASE_URL, null);
  assert.equal(result.previous.ANTHROPIC_AUTH_TOKEN, null);

  rig.setup.restoreClaudeSettings({
    takeover: {
      applied: result.applied,
      previous: result.previous,
      fileExisted: result.fileExisted,
    },
  });

  const after = rig.read();
  assert.equal(has(after.env, 'ANTHROPIC_BASE_URL'), false);
  assert.equal(has(after.env, 'ANTHROPIC_AUTH_TOKEN'), false);
  assert.equal(after.env.ANTHROPIC_MODEL, 'deepseek-v4-pro');
});

test('11b. 接管：手上已有 previous 时，残留只刷新 applied，previous 沿用原值', () => {
  const prior = {
    previous: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-real-user-key',
    },
  };
  const rig = makeRig({
    settings: { env: { ANTHROPIC_BASE_URL: PROXY_URL, ANTHROPIC_AUTH_TOKEN: LOCAL_TOKEN } },
  });

  const result = rig.setup.applyClaudeSettings({ proxyBaseUrl: PROXY_URL, previousTakeover: prior });

  assert.equal(result.residualDetected, true);
  // 残渣覆盖掉的是 applied，用户的原值必须活着
  assert.deepEqual(result.previous, prior.previous);
});

test('11c. 接管：老版本留下的公开占位符同样被认作残渣', () => {
  const rig = makeRig({
    settings: {
      env: { ANTHROPIC_BASE_URL: PROXY_URL, ANTHROPIC_AUTH_TOKEN: LEGACY_PLACEHOLDER_TOKEN },
    },
  });

  const result = rig.setup.applyClaudeSettings({ proxyBaseUrl: PROXY_URL });

  // 老版本把公开常量 cc-nbproject-managed 写进过配置，那些安装升级后
  // 必须能认出这串字是残渣，否则会把死值当用户凭证记下来
  assert.equal(result.residualDetected, true);
  assert.equal(result.previous.ANTHROPIC_AUTH_TOKEN, null);
});

test('11d. 接管：用户自己的本机服务不会被误认成残渣', () => {
  // 用户自己在本地跑着 LM Studio。它的 1234 端口落在代理端口区间之外，
  // 判定必须收得足够紧 —— 误认的代价是把用户真实的配置丢掉。
  const rig = makeRig({
    settings: {
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234/v1', ANTHROPIC_AUTH_TOKEN: 'lm-studio' },
    },
  });

  const result = rig.setup.applyClaudeSettings({ proxyBaseUrl: PROXY_URL });

  assert.equal(result.residualDetected, false);
  assert.equal(result.previous.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1234/v1');
  assert.equal(result.previous.ANTHROPIC_AUTH_TOKEN, 'lm-studio');
});

test('12. 接管：空串是合法取值，不能被折叠成「键不存在」', () => {
  // `env[key] || null` 这种写法会把 "" 变成 null，还原时就成了「删除该键」，
  // 与用户原本的「键存在且为空」不符
  const rig = makeRig({
    settings: {
      env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: '' },
    },
  });

  const result = rig.setup.applyClaudeSettings({ proxyBaseUrl: PROXY_URL });
  assert.equal(result.previous.ANTHROPIC_AUTH_TOKEN, '');

  rig.setup.restoreClaudeSettings({
    takeover: {
      applied: result.applied,
      previous: result.previous,
      fileExisted: result.fileExisted,
    },
  });

  const after = rig.read();
  assert.equal(has(after.env, 'ANTHROPIC_AUTH_TOKEN'), true);
  assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, '');
});

test('13. 接管：proxyBaseUrl 缺失时拒绝写入，且不碰文件（R7 准入）', () => {
  const rig = makeRig({ settings: USER_SETTINGS });
  const before = rig.raw();

  for (const bad of [undefined, null, '']) {
    assert.throws(() => rig.setup.applyClaudeSettings({ proxyBaseUrl: bad }), /代理尚未就绪/);
  }

  // 兜底地址会把一个**必然连不上**的地址写进用户配置，
  // 正好制造出本工具最怕的那种「用户想不到是工具干的」故障
  assert.equal(rig.raw(), before);
  assert.equal(rig.backups().length, 0);
});

test('13b. 预览：只读不写，且备份只给布尔语义、不给具体路径', () => {
  const rig = makeRig({ settings: USER_SETTINGS });
  const before = rig.raw();

  const preview = rig.setup.previewClaudeSettings({ proxyBaseUrl: PROXY_URL });

  assert.equal(rig.raw(), before);
  assert.equal(rig.backups().length, 0);
  assert.equal(preview.exists, true);
  assert.equal(preview.willBackup, true);
  // 备份文件名带时间戳，预览阶段算出来的名字与真正生成的对不上 ——
  // 用户照提示去找只能扑空，所以预览不给路径（见 makeBackupPath 的注释）
  assert.equal(has(preview, 'backupPath'), false);
  assert.deepEqual(
    preview.changes.map((c) => c.key),
    MANAGED_KEYS
  );

  // 已经接管过（有 backupPath）时不再重复备份
  const second = rig.setup.previewClaudeSettings({
    proxyBaseUrl: PROXY_URL,
    takeover: { backupPath: '/tmp/x.bak.1' },
  });
  assert.equal(second.willBackup, false);
});

