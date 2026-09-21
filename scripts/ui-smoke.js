'use strict';

/**
 * 渲染进程冒烟检查。
 *
 * **它存在的理由**：渲染进程没有任何单元测试保护，而它已经出过两次
 * 「代码一跑就崩、lint 却全绿」的问题：
 *
 *   1. 遮罩层常驻 —— `.modal-root` 的 `display: flex` 压掉了 `hidden` 属性
 *      依赖的 UA 样式，界面发暗、什么都点不了
 *   2. `buildModelHelper()` 被无参调用 —— 函数签名是解构参数，一打开编辑框就
 *      `TypeError`，而 ESLint 看不出这种错
 *
 * 两次都不是"逻辑算错了"，而是"这段代码根本没跑到过"。单元测试测不到它，
 * 给 DOM 打桩也只能验证"我以为的浏览器行为"。所以这里换成**连上真实运行中的
 * Electron 窗口**去点 —— 验的是真行为。
 *
 * 零依赖：Node 18+ 的全局 `fetch` 加 Node 22+ 的全局 `WebSocket`，
 * 直接用 Chrome DevTools Protocol 驱动，不引入 puppeteer/playwright。
 *
 * 用法：
 *   1. 另开一个终端启动带调试端口的应用
 *        npx electron . --remote-debugging-port=9222
 *   2. node scripts/ui-smoke.js [profile 名的一部分]
 *      第二个参数默认 `openrouter`，用来挑一张供应商卡片走编辑流程；
 *      该 profile 需要有可用的端点与 key，否则拉取那几步会走失败分支。
 *
 * 退出码 0 表示全部检查通过。
 */

const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const PROFILE_HINT = process.argv[2] || 'openrouter';

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!page) {
    throw new Error(
      `没找到渲染进程页面。请先以调试端口启动应用：\n  npx electron . --remote-debugging-port=${CDP_PORT}`
    );
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const problems = [];

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);

    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }

    // 渲染进程里任何未捕获的异常都会以这个事件送过来 —— 这正是我们要抓的东西
    if (msg.method === 'Runtime.exceptionThrown') {
      const detail = msg.params.exceptionDetails;
      problems.push('未捕获异常：' + (detail.exception?.description || detail.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push(
        'console.error：' + msg.params.args.map((a) => a.value ?? a.description).join(' ')
      );
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Runtime.enable');
  await send('Page.enable');

  /** 在页面里跑一段代码。异常变成 {__error} 返回，而不是让整个检查中断。 */
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      return {
        __error: result.exceptionDetails.exception?.description || result.exceptionDetails.text,
      };
    }
    return result.result.value;
  };

  return { ws, send, evaluate, problems };
}

async function main() {
  const { ws, send, evaluate, problems } = await connect();

  // 必须从干净状态开始：主进程的模型缓存在渲染进程重载后依然存在，
  // 上一次运行残留的状态会让"来自缓存"之类的读数变得无法解释。
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 1200));

  const expect = (cond, label) => {
    if (!cond) problems.push('断言失败：' + label);
    return Boolean(cond);
  };
  const report = (name, data) => console.log(`\n【${name}】\n` + JSON.stringify(data, null, 2));

  // --- 1. 「添加供应商」编辑框能打开（buildModelHelper 无参调用就是在这里崩的）---
  const add = await evaluate(`
    document.querySelector('#btn-add').click();
    await new Promise((r) => setTimeout(r, 300));
    const root = document.querySelector('#modal-root');
    return {
      模态框可见: root.hidden === false,
      辅助区存在: Boolean(root.querySelector('.model-helper')),
      拉取按钮文案: root.querySelector('.model-helper .btn')?.textContent ?? null,
      选择区默认隐藏: root.querySelector('.model-picker')?.hidden === true,
      添加按钮存在: Boolean(root.querySelector('.picker-actions button')),
    };
  `);
  report('打开「添加供应商」编辑框', add);
  expect(add.模态框可见 && add.辅助区存在, '编辑框应能打开且含模型辅助区');
  expect(add.选择区默认隐藏, '拉取之前选择区必须隐藏');

  // --- 2. 源模型名的候选应读自 Claude Code 的实际配置 ---
  const names = await evaluate(`
    await new Promise((r) => setTimeout(r, 600));
    return {
      候选: [...document.querySelectorAll('#ccnb-source-models option')].map((o) => o.value),
      预填: document.querySelector('.model-picker input')?.value ?? null,
    };
  `);
  report('源模型名读自 settings.json', names);

  // --- 3. 关掉再打开指定 profile 的编辑框 ---
  const edit = await evaluate(`
    [...document.querySelectorAll('#modal-root .modal-actions button')]
      .find((b) => b.textContent === '取消').click();
    await new Promise((r) => setTimeout(r, 200));
    const 取消后隐藏 = document.querySelector('#modal-root').hidden === true;

    // 按标题挑卡片而不是取第一张：不同 profile 的端点行为可能完全不同
    const cards = [...document.querySelectorAll('#provider-list .card')];
    const card = cards.find((c) =>
      c.querySelector('.card-title').textContent.includes(${JSON.stringify(PROFILE_HINT)})
    );
    if (!card) {
      return { 找不到指定卡片: cards.map((c) => c.querySelector('.card-title').textContent) };
    }
    [...card.querySelectorAll('button')].find((b) => b.textContent.includes('编辑')).click();
    await new Promise((r) => setTimeout(r, 300));
    const root = document.querySelector('#modal-root');
    return {
      取消后模态框隐藏: 取消后隐藏,
      模态框可见: root.hidden === false,
      BaseURL: root.querySelectorAll('input')[1].value,
      映射文本框: root.querySelector('.textarea')?.value ?? null,
      实时解析回显: root.querySelector('.field-status')?.textContent ?? null,
    };
  `);
  report(`打开 ${PROFILE_HINT} 的编辑框`, edit);
  expect(edit.取消后模态框隐藏, '点取消必须真的关掉模态框');
  expect(edit.模态框可见, '编辑框应能打开');

  // --- 4. 拉取模型列表 ---
  // 注意：不要试图包装 window.ccnb.listModels 来计数 —— contextBridge 暴露的对象
  // 是冻结的，赋值会静默失败，反倒制造出"调用次数 0"这种假阴性。只看可观测结果。
  const fetched = await evaluate(`
    const root = document.querySelector('#modal-root');
    root.querySelector('.model-helper .btn').click();
    await new Promise((r) => setTimeout(r, 25000));
    const picker = root.querySelector('.model-picker');
    const options = [...document.querySelectorAll('#ccnb-target-models option')];
    return {
      状态文案: root.querySelector('.model-helper .field-status')?.textContent ?? null,
      选择区已展开: picker?.hidden === false,
      候选数: options.length,
      源输入框当前值: picker?.querySelectorAll('input')[0]?.value ?? null,
      首次预填的目标模型: picker?.querySelectorAll('input')[1]?.value ?? null,
    };
  `);
  report('从供应商拉取模型列表', fetched);

  // --- 5. 改源名自动预填，再写入文本框 ---
  const written = await evaluate(`
    const root = document.querySelector('#modal-root');
    const picker = root.querySelector('.model-picker');
    if (picker.hidden) return { 跳过: '上一步没拉到模型，该端点的 /v1/models 不可用' };

    const sourceInput = picker.querySelectorAll('input')[0];
    const targetInput = picker.querySelectorAll('input')[1];
    const 候选源名 = [...document.querySelectorAll('#ccnb-source-models option')].map((o) => o.value);

    const 预填 = {};
    for (const src of 候选源名.slice(0, 3)) {
      sourceInput.value = src;
      sourceInput.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 120));
      预填[src] = targetInput.value;
    }

    // 清空文本框单测写入结果，免得受已有内容干扰
    const box = root.querySelector('.textarea');
    box.value = '';
    const 首个源名 = 候选源名[0];
    sourceInput.value = 首个源名;
    sourceInput.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 120));
    root.querySelector('.picker-actions button').click();
    await new Promise((r) => setTimeout(r, 150));
    const 一次后 = box.value;

    // 同一个源名再点一次：必须是原地替换，不能出现两行
    root.querySelector('.picker-actions button').click();
    await new Promise((r) => setTimeout(r, 150));

    return { 各源名的自动预填: 预填, 一次后, 两次后: box.value, 实时回显: root.querySelector('.field-status').textContent };
  `);
  report('改源名自动预填 + 点「添加」写入', written);
  if (!written.跳过) {
    expect(written.一次后.split('\n').length === 1, '「添加」应把规则写进文本框');
    expect(written.两次后 === written.一次后, '同一源名点两次「添加」不应产生重复行');
  }

  // --- 6. 新增供应商：Base URL 还空着就点拉取 ---
  // 这是"新加一个供应商"的真实起点：空的 URL 必须给出明确提示，
  // 而不是发出一个畸形请求、再报一个让人看不懂的错
  const empty = await evaluate(`
    [...document.querySelectorAll('#modal-root .modal-actions button')]
      .find((b) => b.textContent === '取消').click();
    await new Promise((r) => setTimeout(r, 200));
    document.querySelector('#btn-add').click();
    await new Promise((r) => setTimeout(r, 300));
    const root = document.querySelector('#modal-root');
    root.querySelector('.model-helper .btn').click();
    await new Promise((r) => setTimeout(r, 500));
    return {
      BaseURL输入框: root.querySelectorAll('input')[1].value,
      状态文案: root.querySelector('.model-helper .field-status').textContent,
      选择区仍隐藏: root.querySelector('.model-picker').hidden === true,
    };
  `);
  report('新增供应商：Base URL 为空时点拉取', empty);
  expect(empty.状态文案.includes('先填写 Base URL'), '空的 Base URL 应提示先填写');

  console.log(
    problems.length
      ? `\n❌ 发现 ${problems.length} 个问题：\n- ` + problems.join('\n- ')
      : '\n✓ 全部检查通过，渲染进程无未捕获异常'
  );

  ws.close();
  process.exit(problems.length ? 1 : 0);
}

main().catch((err) => {
  console.error('冒烟检查无法进行：', err.message);
  process.exit(1);
});
