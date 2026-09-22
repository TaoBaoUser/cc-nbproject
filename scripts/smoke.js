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
 *   2. node scripts/smoke.js [profile 名的一部分]
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

const fs = require('fs');

/**
 * 读取用户真实的 Claude Code 配置时用。**本脚本只读它，一个字都不写。**
 */
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

/**
 * 展示 env 用。里面的值可能是用户的真实 API key，也可能是我们写进去的准入凭证 ——
 * 终端输出经常被整段复制去别处问人，所以只报「前 6 位 + 长度」，
 * 够判断是哪一个值，又不足以拿去直接使用。
 */
function redactEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    out[k] = typeof v === 'string' && v ? `${v.slice(0, 6)}…（${v.length} 字符）` : v;
  }
  return out;
}

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
      const options = [...card.querySelectorAll('.combobox-option')];
      const list = card.querySelector('.combobox-list');
      return {
        状态文案: card.querySelector('.card-model-status')?.textContent ?? null,
        候选数: options.length,
        含v4pro: options.some((o) => o.dataset.value === 'deepseek/deepseek-v4-pro'),
        含v4flash: options.some((o) => o.dataset.value === 'deepseek/deepseek-v4-flash'),
        建议: [...card.querySelectorAll('.model-suggest')].map((b) => b.textContent),
        // 旧版用的是原生 <datalist>，浮层由浏览器画，候选一多就只能靠键盘硬顶，
        // 撑不出滚动条。换成自写列表后这条必须成立
        // （docs/plans/2026-09-21-检查模型选择连接.md 记录的原始痛点）。
        列表可滚动: list ? list.scrollHeight > list.clientHeight : null,
      };
    `);
    report('聚焦模型输入框后拉取候选', fetched);

    if (fetched.候选数 > 0) {
      expect(
        fetched.列表可滚动 === true,
        '候选列表应能滚动（scrollHeight 应大于 clientHeight），实际：' + fetched.列表可滚动
      );
    }

    // --- 4b. 状态文案必须与结果一致，且拉取结束后不再停在「正在拉取」---
    // 两种供应商形态都要能走通：有 /v1/models 的报条数；没有的（DeepSeek 是 404）
    // 必须说得出**原因**并指向手打，而不是一句「拉取失败」。
    // 六种原因各自的下一步完全不同，揉成一句等于没说 —— 那是 models.js 里 kind 存在的理由。
    const 失败文案候选 = [
      '该供应商没有 /v1/models 接口',
      '认证失败',
      '无法连接',
      'Base URL 不是合法 URL',
      '接口有响应但没有返回任何模型',
    ];
    expect(
      fetched.候选数 > 0
        ? (fetched.状态文案 || '').includes(`可选 ${fetched.候选数} 个模型`)
        : 失败文案候选.some((c) => (fetched.状态文案 || '').includes(c)),
      `状态文案应与结果一致（候选 ${fetched.候选数} 个，文案：${fetched.状态文案}）`
    );
    expect(
      !(fetched.状态文案 || '').includes('正在拉取'),
      '拉取结束后文案不该还停在「正在拉取」，实际：' + fetched.状态文案
    );

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

    // --- 6b. 边打边筛 + 键盘选中 ---
    // 换掉原生 datalist 的全部理由就在这两件事上：能不能筛、能不能用键盘选。
    // 446 个候选里靠肉眼找 `deepseek/deepseek-v4-flash` 是不现实的。
    const typed =
      fetched.候选数 > 0
        ? await evaluate(`
      ${findCard(SMOKE_NAME)}
      const input = card.querySelector('.card-model-row input');
      // 先聚焦把候选拉出来（结果有缓存，这一步很快），否则这里数到的 0
      // 分不清是"筛没了"还是"压根没候选"
      input.dispatchEvent(new Event('focus'));
      await new Promise((r) => setTimeout(r, 1500));
      const 打字前候选数 = card.querySelectorAll('.combobox-option').length;
      // React 的受控输入会比对内部记录的 value，直接赋值它看不出变化，
      // 必须走原型上的 setter 让它认为值确实变了，onChange 才会触发
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setValue.call(input, 'flash');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      const options = [...card.querySelectorAll('.combobox-option')];
      return {
        打字前候选数,
        筛选后候选数: options.length,
        全部命中关键词: options.every((o) => o.dataset.value.toLowerCase().includes('flash')),
        首个候选: options[0]?.dataset.value ?? null,
      };
    `)
        : // 拉候选要走网络，端点不通时不该把渲染进程的检查一并判失败
          { 跳过: '没拉到候选（端点不通），无法检查筛选与键盘选择' };
    report('输入关键词筛选候选', typed);
    expect(
      typed.跳过 || typed.打字前候选数 > 0,
      '聚焦后候选列表应有内容（字段已有值时已是按当前值筛过的结果），实际 ' + typed.打字前候选数
    );
    expect(
      typed.跳过 || typed.筛选后候选数 > 0,
      '输入 flash 后应该还有候选（该端点有 flash 系列模型）'
    );
    expect(
      typed.跳过 || (typed.全部命中关键词 && typed.筛选后候选数 < fetched.候选数),
      `候选应按关键词收窄，实际 ${typed.筛选后候选数} / ${fetched.候选数} 条，命中=${typed.全部命中关键词}`
    );

    const picked = typed.跳过
      ? typed
      : await evaluate(`
      ${findCard(SMOKE_NAME)}
      const input = card.querySelector('.card-model-row input');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      const 高亮项 = card.querySelector('.combobox-option.is-highlighted')?.dataset.value ?? null;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 600));
      const p = (await window.ccnb.listProfiles()).profiles
        .find((x) => x.name === ${JSON.stringify(SMOKE_NAME)});
      return {
        高亮项,
        选中后的值: card.querySelector('.card-model-row input').value,
        列表是否收起: card.querySelector('.combobox-list') === null,
        落盘的映射: p.modelMap,
      };
    `);
    report('键盘选中候选并落盘', picked);
    expect(
      picked.跳过 || picked.选中后的值 === picked.高亮项,
      `回车应把高亮项写进输入框（高亮=${picked.高亮项}，值=${picked.选中后的值}）`
    );
    expect(
      picked.跳过 || Object.values(picked.落盘的映射 || {}).includes(picked.选中后的值),
      '键盘选中同样要立即落盘，不能只在界面上好看'
    );
    expect(picked.跳过 || picked.列表是否收起, '选中后候选列表应收起');

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
    // --- 8. 拉取失败之后必须能重试（W1）---
    // 守的是一个真出过的 bug：UI 早先用一个「已拉取过」的标志挡住重复拉取，而它在
    // **发起**时就置位 —— 于是 key 填错一次、改对之后再聚焦也不会重拉，候选永远空着，
    // 只能重启应用。而主进程那侧特意做了「失败结果不进缓存」来支持这种重试，
    // 单元测试里还有一条专门测它，是绿的 —— 因为它压根不涉及渲染进程的状态。
    //
    // 做法：把这个一次性供应商的地址临时指向一个必然解析不了的域名逼出失败，
    // 再改回真地址，看它是否真的重新拉了一次。只动 __smoke__ 自己。
    const retry = await evaluate(`
      const 卡片 = () => [...document.querySelectorAll('#provider-list .card')].find((x) =>
        x.querySelector('.card-title').textContent.includes(${JSON.stringify(SMOKE_NAME)}));
      const 读状态 = () => {
        const c = 卡片();
        return {
          地址: c?.querySelector('.card-url')?.textContent ?? '',
          文案: c?.querySelector('.card-model-status')?.textContent ?? '',
          候选数: c?.querySelectorAll('.combobox-option').length ?? 0,
        };
      };
      /*
       * 像用户那样改地址：走编辑框保存。
       * **不能直接调 window.ccnb.updateProfile** —— 那只是裸 IPC，改了磁盘上的
       * profiles.json，而渲染进程内存里那份 profile 不会更新（React 收不到通知），
       * 于是卡片手里的 baseUrl 还是旧的，请求照旧打到旧地址。第一次写这条检查时
       * 就是这么假通过的：以为在测失败重试，其实连失败都没发生。
       */
      const 设地址 = async (地址) => {
        [...卡片().querySelectorAll('button')].find((b) => b.textContent.includes('编辑')).click();
        await new Promise((r) => setTimeout(r, 300));
        const root = document.querySelector('#modal-root');
        const 输入框 = [...root.querySelectorAll('input')][1];
        // 受控输入要绕过 React 记的 value，否则它认为没变、onChange 不触发
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setValue.call(输入框, 地址);
        输入框.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 100));
        [...root.querySelectorAll('.modal-actions button')]
          .find((b) => b.textContent === '保存')
          .click();
        await new Promise((r) => setTimeout(r, 500));
      };
      // 等「文案变了」而不是等「正在拉取」消失：已有候选时界面刻意不再显示
      // 「正在拉取」（为了不让每次聚焦都闪一下），拿它当信号会立刻返回、
      // 读到一个还没更新的状态。
      const 聚焦并等 = async () => {
        const 前 = 读状态().文案;
        卡片().querySelector('.card-model-row input').dispatchEvent(new Event('focus'));
        const 死线 = Date.now() + 25000;
        while (Date.now() < 死线 && 读状态().文案 === 前) {
          await new Promise((r) => setTimeout(r, 250));
        }
        return 读状态();
      };

      const 真地址 = 读状态().地址;
      // .invalid 是 RFC 2606 保留的顶级域，保证解析不了 —— 比赌某个端口没人占用可靠
      await 设地址('http://cc-nbproject-smoke.invalid/api');
      const 失败时 = await 聚焦并等();

      await 设地址(真地址);
      const 重试后 = await 聚焦并等();
      return { 真地址, 失败时, 重试后 };
    `);
    report('拉取失败后改回可用地址，是否真的重试', retry);
    // 先确认这个检查测的是它以为的东西：地址没真的换掉，后面几条就是假通过的
    expect(
      retry.失败时?.地址 === 'http://cc-nbproject-smoke.invalid/api',
      '编辑框保存后卡片应显示新地址，实际：' + retry.失败时?.地址
    );
    expect(
      (retry.失败时?.文案 || '').includes('可直接手打模型 ID'),
      '拉取失败时应给出可照做的提示，实际：' + retry.失败时?.文案
    );
    expect(
      !(retry.失败时?.文案 || '').includes('正在拉取'),
      '失败后不能停在「正在拉取」，实际：' + retry.失败时?.文案
    );
    expect(
      !(retry.重试后?.文案 || '').includes('无法连接'),
      '改回可用地址后必须重新拉取（文案不该还是「无法连接」），实际：' + retry.重试后?.文案
    );

    // --- 8b. 候选浮层必须完整可见，不能被 .main 的滚动盒推出视野（W4-2）---
    // 真出过的情形：输入框贴近视口底部时，朝下的浮层底边跑到视口外面（实测超出 130px，
    // 只看得见 46%），还把 .main 的滚动区撑高了同样的高度 —— 用户得先滚动才看得到下半截。
    //
    // 怎么摆出这个位置：在卡片**前面**插一个占位块，把卡片往下推，推多高是**算出来的** ——
    // 让输入框底边离 main 底边正好剩 50px。这比「滚到底」可靠：滚到底时卡片落在哪，取决于
    // 卡片下面还有多少内容，跟占位块多高无关，第一次写这条时就是这么假通过的
    // （摘掉修复重跑，卡片落在 573px 处、根本没贴底，断言照样绿）。
    //
    // 所以下面第一条断言的其实是**前置条件**：位置没摆对就直接报错，不许静默通过。
    // 全程只动页面里的 DOM（占位块量完即删），不碰任何配置。
    const flipped = await evaluate(`
      ${findCard(SMOKE_NAME)}
      const main = document.querySelector('.main');
      const input = card.querySelector('.card-model-row input');

      // 先打开一次，确保候选已经在手里（缓存命中，很快），后面那次才是要量的
      input.dispatchEvent(new Event('focus'));
      await new Promise((r) => setTimeout(r, 2500));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      input.dispatchEvent(new Event('blur'));
      await new Promise((r) => setTimeout(r, 300));

      const 撑高 = document.createElement('div');
      撑高.id = 'smoke-spacer';
      撑高.style.height = '0px';
      card.parentNode.insertBefore(撑高, card);
      await new Promise((r) => setTimeout(r, 100));

      // 让输入框底边落在「离 main 底边 50px」的位置 —— 这时 240px 的浮层朝下必然放不下
      const m = main.getBoundingClientRect();
      const 想要 = m.bottom - 50;
      const 加高 = Math.max(0, Math.round(想要 - input.getBoundingClientRect().bottom));
      撑高.style.height = 加高 + 'px';
      await new Promise((r) => setTimeout(r, 200));

      input.dispatchEvent(new Event('focus'));
      await new Promise((r) => setTimeout(r, 2500));

      const 浮层 = card.querySelector('.combobox-list');
      const 读数 = { 占位块高: 加高, 有浮层: Boolean(浮层), 候选数: card.querySelectorAll('.combobox-option').length };
      if (浮层) {
        const r = 浮层.getBoundingClientRect();
        const 框 = input.getBoundingClientRect();
        读数.浮层高度 = Math.round(r.height);
        读数.朝上展开 = 浮层.classList.contains('is-up');
        读数.输入框下方余量 = Math.round(window.innerHeight - 框.bottom);
        读数.需要的高度 = 240 + 4;
        读数.场景成立 = 读数.输入框下方余量 < 读数.需要的高度;
        读数.浮层top = Math.round(r.top);
        读数.浮层bottom = Math.round(r.bottom);
        读数.视口高 = window.innerHeight;
        读数.底边超出视口 = Math.round(r.bottom - window.innerHeight);
        读数.顶部超出main可视区 = Math.round(m.top - r.top);
        读数.底边超出main可视区 = Math.round(r.bottom - m.bottom);
        读数.完整可见 = r.top >= m.top - 1 && r.bottom <= Math.min(window.innerHeight, m.bottom) + 1;
        读数.列表仍可滚动 = 浮层.scrollHeight > 浮层.clientHeight;
      }

      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      input.dispatchEvent(new Event('blur'));
      撑高.remove();
      await new Promise((r) => setTimeout(r, 200));
      return { ...读数, 收尾后滚动区: { scrollHeight: main.scrollHeight, clientHeight: main.clientHeight } };
    `);
    report('输入框贴底时候选浮层是否完整可见', flipped);
    // 候选为 0 说明这个端点没有 /v1/models（DeepSeek 那一类），压根没有浮层可测 —— 跳过。
    // 有候选却没浮层才是怪事，那时下面的前置断言会报出来。
    if (flipped.候选数 === 0) {
      report('  这条跳过', { 原因: '这个端点没有 /v1/models，没有候选也就没有浮层可测' });
    } else {
      expect(
        flipped.有浮层 && flipped.场景成立,
        `这条检查没摆出它要测的位置（有浮层=${flipped.有浮层}，输入框下方余量=${flipped.输入框下方余量}px，` +
          `需要小于 ${flipped.需要的高度}px）—— 不许静默通过`
      );
      expect(
        flipped.完整可见,
        `输入框贴到视口底部时浮层也要完整可见，实际底边超出视口 ${flipped.底边超出视口}px、` +
          `顶部超出 ${flipped.顶部超出main可视区}px`
      );
      // 不许用「把浮层压扁」来蒙混过关：候选列表本身还得是那个能滚动的长列表
      expect(
        (flipped.浮层高度 || 0) >= 200 && flipped.列表仍可滚动,
        `浮层该保持原高度且可滚动（高度 ${flipped.浮层高度}，可滚动 ${flipped.列表仍可滚动}）`
      );
    }

    // --- 9. 读不到 Claude Code 模型名时，必须给一条出路（W2）---
    // 「读不到」多半是因为 settings.json 里还没有 _MODEL 结尾的键 —— 首次引导
    // 刻意不写 ANTHROPIC_MODEL（见 setup.js 的 buildNextSettings）。这个状态一旦
    // 被记在缓存里，用户补好模型名后卡片也不会恢复，只能重启应用。
    // 所以它必须有一个「重新读取」入口。
    //
    // 这一条只在真的处于该状态时才断言：**检查工具不许去改用户的 settings.json
    // 来制造这个状态** —— 那是本工具唯一承诺只改一次的文件。
    const names = await evaluate(`
      ${findCard(SMOKE_NAME)}
      const 文案 = card.querySelector('.card-model-status')?.textContent ?? '';
      return {
        读不到: 文案.includes('读不到 Claude Code 的模型名'),
        模型行数: card.querySelectorAll('.card-model-row').length,
        有重新读取: [...card.querySelectorAll('.card-model-status button')].some((b) =>
          b.textContent.includes('重新读取')
        ),
      };
    `);
    report('读不到 Claude Code 模型名时有没有出路', names);
    expect(!names.读不到 || names.有重新读取, '读不到模型名时必须给出「重新读取」入口，实际没有');

    // --- 10. 侧边栏的接管状态行必须与**文件内容**一致（R9）---
    //
    // 这一条**只读**：读的是用户真实的 ~/.claude/settings.json，一个字都不写。
    // 判定以文件内容为基准 —— 「已接管」的实质是文件里那两个键确实等于我们写进去
    // 的值，而不是我们记得自己写过。`enabled` 只作旁证。
    //
    // 为什么这条不能自证：「文件里是什么」由本脚本自己读，「界面显示什么」由应用
    // 自己读主进程状态 —— 两边走的是不同来源，任何一个环节坏了都会对不上。
    // 若改成「读应用自己算的 fileMatches 再断言界面等于它」，那就是同源自证。
    const claudeRow = await evaluate(`
      const status = await window.ccnb.getClaudeStatus();
      const line = document.querySelector('#claude-line');
      return {
        界面: line?.dataset.claudeState ?? null,
        主进程state: status.state,
        enabled: status.enabled,
        applied: status.applied,
        settingsPath: status.settingsPath,
        界面文案: document.querySelector('#claude-label')?.textContent ?? null,
      };
    `);

    let 档 = { 存在: false };
    try {
      档 = { 存在: true, content: JSON.parse(fs.readFileSync(claudeRow.settingsPath, 'utf8')) };
    } catch (err) {
      档 = { 存在: false, 原因: err.message };
    }

    const env = (档.content && 档.content.env) || {};
    const 受管键 = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];
    const 文件里是我们的 = 受管键.every(
      (k) => hasOwn(env, k) && env[k] === (claudeRow.applied || {})[k]
    );
    const 期望界面 = !claudeRow.enabled ? 'off' : 文件里是我们的 ? 'active' : 'pending';

    report('接管状态行与 settings.json 是否一致（只读）', {
      界面显示: claudeRow.界面,
      界面文案: claudeRow.界面文案,
      主进程state: claudeRow.主进程state,
      主进程enabled: claudeRow.enabled,
      文件存在: 档.存在,
      文件里两个受管键: redactEnv(env),
      文件里确实是接管写入的值: 文件里是我们的,
    });

    expect(
      claudeRow.界面 === 期望界面,
      `状态行与文件内容不一致：界面显示「${claudeRow.界面}」（${claudeRow.界面文案}），` +
        `按文件内容应为「${期望界面}」`
    );
    expect(claudeRow.主进程state === claudeRow.界面, '侧边栏渲染的状态与主进程给的状态不一致');
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
