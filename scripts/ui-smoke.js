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
 *      第二个参数默认 `openrouter`，只用来**抄取 baseUrl 与 apiKey** ——
 *      拉取候选那几步需要一个真能连通的端点，端点行为不同的供应商会走不同分支。
 *
 * **它绝不碰你已有的供应商。** 检查全程只操作一个当场新建的一次性供应商
 * `__smoke__`：开始前用目标 profile 的 baseUrl/apiKey 造出来，结束时无条件删掉
 * （断言失败、中途抛错都照删）。收尾还会逐字段比对你原有 profile 是否原封不动。
 *
 * 这条设计是踩过坑才改的：早先的版本直接在真实 profile 上改映射、结尾再还原，
 * 结果脚本运行期间用户自己在界面上点了一下模型下拉 —— 于是"还原"把他刚选的值
 * 覆盖掉了。**检查工具绝不能留下一个能改动用户数据的窗口期**，哪怕只有几秒。
 *
 * 退出码 0 表示全部检查通过。
 */

const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const PROFILE_HINT = process.argv[2] || 'openrouter';

/**
 * 一次性供应商的名字。所有写操作都只落在它身上，跑完即删。
 * 用双下划线包起来，是为了万一删除失败时一眼认得出它不属于用户。
 */
const SMOKE_NAME = '__smoke__';

/** 报错信息里绝不能带 API key —— 终端输出会被复制粘贴到别处去 */
const redact = (p) =>
  p ? { ...p, apiKey: p.apiKey ? `（${p.apiKey.length} 字符，已隐去）` : '' } : p;

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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const expect = (cond, label) => {
    if (!cond) problems.push('断言失败：' + label);
    return Boolean(cond);
  };
  const report = (name, data) => console.log(`\n【${name}】\n` + JSON.stringify(data, null, 2));

  /**
   * 按标题找一张供应商卡片。不同 profile 的端点行为可能完全不同，必须指名。
   *
   * 变量名可传：同一段页面代码里若调用两次，两次都声明 `const card` 就会
   * `SyntaxError: Identifier 'card' has already been declared`，
   * 而报错抛在被注入的页面里，从 Node 这边只能看到一句含混的"检查无法进行"。
   * 这个坑踩过两次（先是 `cards`，后是 `card`），所以干脆做成可传参的。
   */
  const findCard = (hint, varName = 'card') => `
    const ${varName} = [...document.querySelectorAll('#provider-list .card')].find((c) =>
      c.querySelector('.card-title').textContent.includes(${JSON.stringify(hint)})
    );
  `;
  /** 现有卡片标题。找不到目标时把它报出来，比只丢一句"失败"有用得多。 */
  const cardTitles = `[...document.querySelectorAll('#provider-list .card .card-title')].map((t) => t.textContent)`;

  const waitFor = async (expr, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(`return Boolean(${expr});`)) return true;
      await sleep(200);
    }
    return false;
  };

  const cancelModal = async () => {
    await evaluate(`
      const btn = [...document.querySelectorAll('#modal-root .modal-actions button')]
        .find((b) => b.textContent === '取消');
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 250));
    `);
  };
  const modalHidden = async () => {
    const r = await evaluate(
      `return { 模态框隐藏: document.querySelector('#modal-root').hidden === true };`
    );
    return r.模态框隐藏 === true;
  };

  // 必须从干净状态开始：主进程的模型缓存在渲染进程重载后依然存在，
  // 上一次运行残留的状态会让"来自缓存"之类的读数变得无法解释。
  await send('Page.reload');
  await sleep(1200);

  // 记下目标供应商的原样。它此后**只读**：用来抄 baseUrl/apiKey，以及收尾时比对。
  const target = await evaluate(`
    const { profiles } = await window.ccnb.listProfiles();
    const src = profiles.find((p) => p.name.includes(${JSON.stringify(PROFILE_HINT)}));
    if (!src) return { 找不到: profiles.map((p) => p.name) };
    return { 快照: src, 总数: profiles.length };
  `);
  if (target.找不到) {
    throw new Error(
      `没找到名字含「${PROFILE_HINT}」的供应商。现有：${JSON.stringify(target.找不到)}`
    );
  }

  let smokeId = null;
  let fatal = null;

  try {
    // --- 0. 造一个一次性供应商。后面所有写操作都只落在它身上 ---
    const created = await evaluate(`
      const { profiles } = await window.ccnb.listProfiles();
      // 上一次跑崩了可能留下残骸，先清掉，否则会撞名
      for (const p of profiles.filter((x) => x.name === ${JSON.stringify(SMOKE_NAME)})) {
        await window.ccnb.removeProfile(p.id);
      }
      const p = await window.ccnb.addProfile({
        name: ${JSON.stringify(SMOKE_NAME)},
        baseUrl: ${JSON.stringify(target.快照.baseUrl)},
        apiKey: ${JSON.stringify(target.快照.apiKey)},
      });
      return { id: p.id, baseUrl: p.baseUrl, 抄自: ${JSON.stringify(target.快照.name)} };
    `);
    smokeId = created.id;
    report('一次性供应商（检查完即删）', created);

    await send('Page.reload');
    await sleep(1000);
    const ready = await waitFor(
      `
      [...document.querySelectorAll('#provider-list .card .card-title')]
        .some((t) => t.textContent.includes(${JSON.stringify(SMOKE_NAME)}))
    `,
      10000
    );
    if (!ready) {
      const titles = await evaluate(`return ${cardTitles};`);
      throw new Error(`新建的「${SMOKE_NAME}」卡片没出现。现有卡片：${JSON.stringify(titles)}`);
    }

    // --- 1. 卡片上应直接列出模型选择，而不是藏在编辑框里 ---
    const cards = await evaluate(`
      ${findCard(SMOKE_NAME)}
      const rows = [...card.querySelectorAll('.card-model-row')];
      return {
        模型行数: rows.length,
        标签: rows.map((r) => r.querySelector('.card-model-label').textContent),
        当前值: rows.map((r) => r.querySelector('input').value),
        状态: card.querySelector('.card-model-status')?.textContent ?? null,
      };
    `);
    report('卡片上的模型选择', cards);
    expect(cards.模型行数 >= 1, '卡片上应直接能选模型');
    expect(
      (cards.标签 || []).includes('主模型') && (cards.标签 || []).includes('后台小任务'),
      '两个下拉应分别标注为「主模型」和「后台小任务」（标签=' + JSON.stringify(cards.标签) + '）'
    );
    expect(
      (cards.当前值 || []).every((v) => v === ''),
      '全新供应商的模型框应为空（原样透传），实际：' + JSON.stringify(cards.当前值)
    );

    // --- 2. 编辑框里不该再有模型选择的流水线，映射应已收进「高级」---
    const modal = await evaluate(`
      document.querySelector('#btn-add').click();
      await new Promise((r) => setTimeout(r, 300));
      const root = document.querySelector('#modal-root');
      const advanced = root.querySelector('details.advanced');
      return {
        模态框可见: root.hidden === false,
        输入框数量: root.querySelectorAll('input').length,
        有高级折叠区: Boolean(advanced),
        高级默认收起: advanced ? advanced.open === false : null,
        高级标题: advanced?.querySelector('summary')?.textContent ?? null,
        折叠区内有映射文本框: Boolean(advanced?.querySelector('.textarea')),
      };
    `);
    report('「添加供应商」编辑框', modal);
    expect(modal.模态框可见, '编辑框应能打开');
    expect(
      modal.输入框数量 === 3,
      '编辑框只应剩名称 / 地址 / Key 三个输入框（实际 ' + modal.输入框数量 + ' 个）'
    );
    expect(modal.有高级折叠区 && modal.高级默认收起, '映射应收进默认收起的「高级」');
    expect(modal.折叠区内有映射文本框, '「高级」里应能手动写映射');
    expect(
      !(modal.高级标题 || '').includes('已有'),
      '还没配规则的供应商不该显示"已有 N 条"（实际：' + modal.高级标题 + '）'
    );

    // 取消必须真的关得掉 —— 遮罩层压掉 hidden 属性的老毛病就出在这里
    await cancelModal();
    expect(await modalHidden(), '点取消必须真的关掉模态框');

    // --- 3. 打开这张卡片的编辑框：常规路径只需要看到地址和 key ---
    const edit = await evaluate(`
      ${findCard(SMOKE_NAME)}
      [...card.querySelectorAll('button')].find((b) => b.textContent.includes('编辑')).click();
      await new Promise((r) => setTimeout(r, 300));
      const root = document.querySelector('#modal-root');
      const inputs = [...root.querySelectorAll('input')];
      return {
        模态框可见: root.hidden === false,
        BaseURL: inputs[1]?.value ?? null,
        高级标题: root.querySelector('details.advanced summary')?.textContent ?? null,
      };
    `);
    report('打开一次性供应商的编辑框', edit);
    expect(edit.模态框可见, '编辑框应能打开');
    expect(edit.BaseURL === target.快照.baseUrl, 'BaseURL 应正确回填');
    await cancelModal();
    expect(await modalHidden(), '取消后应关掉编辑框');

    // --- 4. 聚焦某个模型输入框 → 自动拉取候选 ---
    // 注意：不要试图包装 window.ccnb.listModels 来计数 —— contextBridge 暴露的对象
    // 是冻结的，赋值会静默失败，反倒制造出"调用次数 0"这种假阴性。只看可观测结果。
    const fetched = await evaluate(`
      ${findCard(SMOKE_NAME)}
      const input = card.querySelector('.card-model-row input');
      input.dispatchEvent(new Event('focus'));
      await new Promise((r) => setTimeout(r, 25000));
      const options = [...document.querySelectorAll('datalist[id^="ccnb-models-"] option')];
      return {
        状态文案: card.querySelector('.card-model-status')?.textContent ?? null,
        候选数: options.length,
        含v4pro: options.some((o) => o.value === 'deepseek/deepseek-v4-pro'),
        含v4flash: options.some((o) => o.value === 'deepseek/deepseek-v4-flash'),
        建议: [...card.querySelectorAll('.model-suggest')].map((b) => b.textContent),
      };
    `);
    report('聚焦模型输入框后拉取候选', fetched);

    // --- 5. 一键采纳建议 → 应立即落盘（没有"保存"按钮）---
    const applied = await evaluate(`
      ${findCard(SMOKE_NAME)}
      const chip = card.querySelector('.model-suggest');
      if (!chip) return { 跳过: '没有出现建议（该端点的 /v1/models 不可用，或字段已有值）' };
      const 建议文案 = chip.textContent;
      chip.click();
      await new Promise((r) => setTimeout(r, 600));
      const rows = [...card.querySelectorAll('.card-model-row')];
      const { profiles } = await window.ccnb.listProfiles();
      const p = profiles.find((x) => x.name === ${JSON.stringify(SMOKE_NAME)});
      return {
        建议文案,
        采纳后各行的值: rows.map((r) => r.querySelector('input').value),
        状态: card.querySelector('.card-model-status').textContent,
        落盘的映射: p.modelMap,
      };
    `);
    report('一键采纳建议', applied);

    // --- 5b. 采纳之后，「高级」标题应如实报出规则条数 ---
    // 用户得知道"有规则正在生效"。否则请求被改了名，他却以为原样透传出去了。
    if (!applied.跳过) {
      const echo = await evaluate(`
        ${findCard(SMOKE_NAME)}
        [...card.querySelectorAll('button')].find((b) => b.textContent.includes('编辑')).click();
        await new Promise((r) => setTimeout(r, 300));
        const root = document.querySelector('#modal-root');
        const p = (await window.ccnb.listProfiles()).profiles
          .find((x) => x.name === ${JSON.stringify(SMOKE_NAME)});
        return {
          高级标题: root.querySelector('details.advanced summary')?.textContent ?? null,
          折叠区内的文本: root.querySelector('.textarea')?.value ?? null,
          落盘的规则条数: Object.keys(p.modelMap).length,
        };
      `);
      report('「高级」应报出已生效的规则条数', echo);
      expect(
        (echo.高级标题 || '').includes(`已有 ${echo.落盘的规则条数} 条`),
        '「高级」标题应显示「已有 N 条」，实际：' + echo.高级标题
      );
      expect(
        (echo.折叠区内的文本 || '').trim().length > 0,
        '手动映射文本框应回显出当前生效的规则，实际为空'
      );
      await cancelModal();
    }

    // --- 6. 卡片上的交互不能连带切换供应商 ---
    // 这里要重新取一次卡片（点击可能触发重渲染），所以两次查找用不同的变量名
    const activeAfterClick = await evaluate(`
      ${findCard(SMOKE_NAME, 'cardBefore')}
      const before = cardBefore.classList.contains('is-active');
      cardBefore.querySelector('.card-model-row input').click();
      await new Promise((r) => setTimeout(r, 500));
      ${findCard(SMOKE_NAME, 'cardAfter')}
      return {
        点模型框前是否激活: before,
        点模型框后是否激活: cardAfter.classList.contains('is-active'),
      };
    `);
    report('点模型输入框不改变当前供应商', activeAfterClick);
    expect(
      activeAfterClick.点模型框前是否激活 === activeAfterClick.点模型框后是否激活,
      '在模型输入框里点一下不该把这张卡切成当前供应商'
    );

    // --- 7. 清空输入框 = 取消映射，不能留一条空规则 ---
    // 留一条空规则会让请求带一个空模型名出去，上游只会回一个看不懂的 400
    const cleared = await evaluate(`
      ${findCard(SMOKE_NAME)}
      const rows = [...card.querySelectorAll('.card-model-row')];
      const 目标行 = rows.find((r) => r.querySelector('input').value) || rows[rows.length - 1];
      const input = 目标行.querySelector('input');
      const 清空前的值 = input.value;
      input.value = '';
      input.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 600));
      const p = (await window.ccnb.listProfiles()).profiles
        .find((x) => x.name === ${JSON.stringify(SMOKE_NAME)});
      return {
        清空前的值,
        清空后该行: input.value,
        状态: card.querySelector('.card-model-status').textContent,
        落盘的映射: p.modelMap,
      };
    `);
    report('清空模型框 = 取消映射', cleared);
    expect(cleared.状态.includes('原样透传'), '清空应提示已改回原样透传');
    expect(
      Object.keys(cleared.落盘的映射 || {}).length === 0,
      '清空后配置里不该留下任何规则，实际：' + JSON.stringify(cleared.落盘的映射)
    );
  } catch (err) {
    // 不在这里抛：先把一次性供应商清理干净，再统一汇报问题
    fatal = err;
  }

  // ---------- 收尾：无论成败都必须做的事 ----------

  // 1) 删掉一次性供应商。留一个 __smoke__ 在用户的供应商列表里，
  //    比检查失败本身更糟糕 —— 用户的配置必须回到运行前的样子。
  if (smokeId) {
    const cleanup = await evaluate(`
      const 已删除 = await window.ccnb.removeProfile(${JSON.stringify(smokeId)});
      const { profiles } = await window.ccnb.listProfiles();
      return { 已删除, 剩余供应商: profiles.map((p) => p.name) };
    `);
    report('清理一次性供应商', cleanup);
    expect(cleanup.已删除, '一次性供应商应被删除');
    expect(
      !(cleanup.剩余供应商 || []).includes(SMOKE_NAME),
      '列表里不该残留 ' + SMOKE_NAME + '：' + JSON.stringify(cleanup.剩余供应商)
    );
  }

  // 2) 你原有的供应商必须一个字都没变。这是整个脚本最该守住的一条断言。
  const after = await evaluate(`
    const { profiles } = await window.ccnb.listProfiles();
    return { profiles, 总数: profiles.length };
  `);
  const now = (after.profiles || []).find((p) => p.name === target.快照.name);
  expect((now || {}).apiKey === target.快照.apiKey, '原有供应商的 API key 被动过了');
  expect(
    JSON.stringify(now) === JSON.stringify(target.快照),
    '原有供应商被动过了！\n  运行前：' +
      JSON.stringify(redact(target.快照)) +
      '\n  现在：  ' +
      JSON.stringify(redact(now))
  );
  expect(after.总数 === target.总数, `供应商数量应回到 ${target.总数}，实际 ${after.总数}`);

  // 3) 让界面回到干净状态：删掉的卡片不该还留在屏幕上
  await send('Page.reload');
  await sleep(800);

  if (fatal) problems.push('检查中断：' + fatal.message);

  console.log(
    problems.length
      ? `\n❌ 发现 ${problems.length} 个问题：\n- ` + problems.join('\n- ')
      : '\n✓ 全部检查通过：渲染进程无未捕获异常，你原有的供应商一字未改'
  );

  ws.close();
  process.exit(problems.length ? 1 : 0);
}

main().catch((err) => {
  console.error('冒烟检查无法进行：', err.message);
  process.exit(1);
});
