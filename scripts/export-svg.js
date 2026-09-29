'use strict';

/**
 * 从真实 Electron 界面导出几何数据，生成高保真 SVG 原型图。
 *
 * 与 scripts/shots.js 的分工：那个脚本产出「给人看的 PNG」，这个脚本产出
 * 「能拖着改的矢量图」。两者共用同一套隔离环境与 CDP 办法 —— 复制而非抽公共
 * 模块，理由同 shots.js 与 e2e/run.js 的分工（产物与失败语义都不同）。
 *
 * 隔离（三处，理由见 scripts/e2e/run.js 文件头）：
 *   1. HOME 指向 mkdtemp 造的假目录 —— 绝不读写用户真实的
 *      ~/.claude/settings.json 与 ~/.cc-nbproject/profiles.json
 *   2. scripts/e2e/app 自带 package.json，userData 落隔离目录
 *   3. CDP 端口默认 9225，与 shots.js 的 9224、e2e 的 9223 错开
 *
 * 零依赖：Node 全局 fetch + 全局 WebSocket 讲 CDP。
 *
 * 用法：
 *   node scripts/export-svg.js --json /tmp/geom   # 只导出几何数据
 *   node scripts/export-svg.js                    # 导出数据 + 生成 SVG
 *
 * 生成物是**纯矢量、逐元素可编辑**的：盒子是 <rect>、文字是 <text>、图标是
 * 内联 <svg>。绝不贴图、绝不把文字转成路径 —— 否则拖进 Figma 就改不动了。
 *
 * 几处只有踩过才知道的坑，改这个脚本前先读一眼：
 *   · 折行的文本节点必须逐行拆开（<text> 不会自动换行）
 *   · 滚动容器裁掉的内容必须剪掉（DOM 还在，坐标也在，但用户看不见）
 *   · 边框颜色要取最粗那条边（只设一边 border 时，其余三边是 currentColor）
 *   · 密码框要还原成圆点（el.value 是明文，原型文件不该带真实 key）
 *   · ::before / ::after 得单独采（不是 DOM 节点，而选中态的紫竖条正是它画的）
 *
 * 已知取不到的（浏览器内建绘制，不在 DOM 里）：
 *   · <select> 右侧的下拉箭头
 *   · <summary> 左侧的展开三角
 * 每份最多一两处，docs/prototype/SVG-原型说明.md 里记了，用的人手工补一下即可。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const CDP_PORT = Number(process.env.CDP_PORT || 9225);
const APP_DIR = 'scripts/e2e/app';

const argVal = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
};

const JSON_ONLY = argVal('--json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 页面结构 —— 与 scripts/shots.js 的 PROFILES 保持一致，
// 两处看到的是同一版界面。改一处记得改另一处。
// ---------------------------------------------------------------------------

const PROFILES = [
  {
    id: 'p-deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiKey: 'sk-demo-deepseek',
    modelMap: {},
    createdAt: '2026-09-01T00:00:00.000Z',
  },
  {
    id: 'p-kimi',
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    apiKey: 'sk-demo-kimi',
    modelMap: {},
    createdAt: '2026-09-02T00:00:00.000Z',
  },
  {
    id: 'p-glm',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    apiKey: 'sk-demo-glm',
    modelMap: {},
    createdAt: '2026-09-03T00:00:00.000Z',
  },
];

/** 造隔离 HOME，预置「三个供应商、尚未接管」的状态。目录不清理，交给系统回收。 */
function makeFakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnb-svg-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.cc-nbproject'), { recursive: true });

  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'sk-real-user-key',
          ANTHROPIC_MODEL: 'deepseek-v4-pro',
        },
      },
      null,
      2
    ) + '\n'
  );

  fs.writeFileSync(
    path.join(home, '.cc-nbproject', 'profiles.json'),
    JSON.stringify(
      {
        version: 1,
        activeId: 'p-deepseek',
        profiles: PROFILES,
        settings: { port: 8787, localToken: 'a'.repeat(64), takeover: null },
      },
      null,
      2
    ) + '\n'
  );

  return home;
}

// ---------------------------------------------------------------------------
// 启动 + CDP
// ---------------------------------------------------------------------------

function launchApp(home, quitFlag) {
  const electron = require('electron');
  const env = { ...process.env, HOME: home, E2E_QUIT_FLAG: quitFlag };
  // 清掉它，否则 Electron 退化成普通 Node 进程，`app` 是 undefined
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electron, [APP_DIR, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log = [];
  child.stdout.on('data', (b) => log.push(b.toString()));
  child.stderr.on('data', (b) => log.push(b.toString()));
  return { child, log };
}

async function waitForPage(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch {
      // 调试端口还没起来，继续等
    }
    await sleep(250);
  }
  throw new Error('等不到渲染进程页面：应用可能没起来，或调试端口没打开');
}

async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  // 顺序要紧：先 Page 域，再 Runtime 域（理由见 scripts/e2e/run.js）
  await send('Page.enable');
  await send('Runtime.enable');

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text
      );
    }
    return result.result.value;
  };

  return { ws, send, evaluate };
}

const waitForReady = (evaluate) =>
  evaluate(`
    for (let i = 0; i < 60; i++) {
      const url = document.querySelector('#proxy-url')?.textContent?.trim();
      const card = document.querySelector('#provider-list .card');
      if (url && url !== '—' && card) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  `);

// ---------------------------------------------------------------------------
// 几何提取 —— 在页面里跑，返回「有视觉表现的元素」清单
// ---------------------------------------------------------------------------
//
// 只收两类元素：有背景或边框的盒子、有直接文本的节点。纯容器（那些只为布局
// 存在的 div）会被跳过 —— 否则 SVG 里会塞满一层层空矩形，拖进 Figma 就是
// 图层灾难。
//
// 文本位置用 Range 量，而不是拿父元素的 padding 去猜。

const EXTRACT = `
  const out = [];
  const round = (v) => Math.round(v * 100) / 100;

  // 把一个被 CSS 折成多行的文本节点拆成逐行的 { x, y, width, height, text }。
  //
  // 为什么非拆不可：SVG 的 <text> 不会自动折行。而 getBoundingClientRect 对
  // 折行文本给出的是整个块 —— 宽取最宽那行、高是行数×行高。直接照它画，两行
  // 会被压成一行、基线还落到块中心上。
  //
  // 办法是逐字符量 Range，按行盒 top 分组：同一次折行的字符 top 必然相同。
  // 这样每行的文字与框都是精确的，落到 Figma 里也是逐行独立图层。
  const measureLines = (node) => {
    const chars = [];
    for (let k = 0; k < node.length; k++) {
      const cr = document.createRange();
      cr.setStart(node, k);
      cr.setEnd(node, k + 1);
      chars.push({ ch: node.textContent[k], r: cr.getBoundingClientRect() });
    }

    const rows = [];
    for (const c of chars) {
      const top = Math.round(c.r.top);
      const last = rows[rows.length - 1];
      if (last && Math.abs(last.top - top) <= 1) last.items.push(c);
      else rows.push({ top, items: [c] });
    }

    return rows
      .map((row) => {
        // 行尾空格会量出零宽 rect，用它算左边界会把整行拽偏。只用有宽度的
        // 字符定框；整行都没宽度时（纯空白行）退回全部字符。
        const boxed = row.items.filter((c) => c.r.width > 0);
        const src = boxed.length ? boxed : row.items;
        const left = Math.min(...src.map((c) => c.r.left));
        const right = Math.max(...src.map((c) => c.r.right));
        const top = Math.min(...src.map((c) => c.r.top));
        const bottom = Math.max(...src.map((c) => c.r.bottom));
        return {
          x: left,
          y: top,
          w: right - left,
          h: bottom - top,
          text: row.items.map((c) => c.ch).join('').replace(/\\s+/g, ' ').trim(),
        };
      })
      .filter((row) => row.text);
  };

  // 视口坐标下的矩形求交。null = 完全不相交，那就什么都别画。
  const intersect = (a, b) => {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.w, b.x + b.w);
    const bottom = Math.min(a.y + a.h, b.y + b.h);
    return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
  };

  const isCropped = (v, s) => v.w < s.w - 0.5 || v.h < s.h - 0.5;

  const walk = (el, clip) => {
    if (el.nodeType !== 1) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;

    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;

    const self = { x: r.x, y: r.y, w: r.width, h: r.height };

    // 滚动容器裁掉的内容：DOM 里还在，但用户看不见。getBoundingClientRect 照样
    // 给出完整坐标 —— 不裁的话，弹窗正文的末尾会被画到底部按钮上叠成一团。
    // 整个落在裁剪框外就剪枝，连子树都不用遍历。
    const visible = clip ? intersect(clip, self) : self;
    if (!visible) return;

    // 这个元素自己是不是滚动容器？是的话，它给出的就是子元素的新裁剪框。
    const scrolls = ['hidden', 'auto', 'scroll', 'clip'].some(
      (v) => cs.overflowX === v || cs.overflowY === v
    );
    const innerClip = scrolls ? visible : clip;

    // ---- 图标：整棵 <svg> 原样带走，不递归内部 ----
    // 里面是 <path>/<line>，既没有背景也没有文本节点，按下面两条规则会被
    // 整个漏掉 —— 侧边栏的导航图标就没了。
    if (el.tagName.toLowerCase() === 'svg') {
      // 被裁掉一角的图标不如不要 —— 半个箭头比没有更刺眼。
      if (isCropped(visible, self)) return;
      out.push({
        i: out.length,
        kind: 'icon',
        tag: 'svg',
        cls: typeof el.className === 'string' ? el.className : (el.getAttribute('class') || ''),
        x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height),
        viewBox: el.getAttribute('viewBox'),
        // 图标内部写的是 stroke="currentColor" —— 离开文档树后 currentColor
        // 会退化成黑，近黑底上等于消失。把它算出来的颜色一并带走，生成时
        // 写回外层 <svg color="…">，让 currentColor 仍能解析。
        color: cs.color,
        html: el.outerHTML,
      });
      return;
    }

    // ---- 盒子：背景 / 边框 / 圆角 ----
    const bg = cs.backgroundColor;
    const hasBg = bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
    const bw = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth]
      .map((v) => parseFloat(v) || 0);
    const hasBorder = bw.some((v) => v > 0);
    // 渐变背景。激活卡片的「第一眼信号」就是它 —— 只认 backgroundColor 的话，
    // 激活态会退化成一块普通卡片底，跟未激活的分不出来。
    const bgImage =
      cs.backgroundImage && cs.backgroundImage !== 'none' ? cs.backgroundImage : null;

    // 被滚动容器裁过的元素，一律按求交后的框画，而不是它自己的框。
    // 圆角在被裁的方向上会失真，但滚动区边缘本来就只露出一个角，无所谓。
    const box = isCropped(visible, self) ? visible : self;

    if (hasBg || hasBorder || bgImage) {
      out.push({
        i: out.length,
        kind: 'box',
        tag: el.tagName.toLowerCase(),
        cls: typeof el.className === 'string' ? el.className : '',
        x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h),
        bg: hasBg ? bg : null,
        bgImage,
        bw,
        bc: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor],
        br: parseFloat(cs.borderTopLeftRadius) || 0,
      });
    }

    // ---- 伪元素：::before / ::after 不是 DOM 节点，遍历永远够不着 ----
    //
    // 而选中态的唯一标记正是用它画的：侧边栏当前页与激活卡片左侧那根紫竖条
    // （.nav-item.is-active::before / .card.is-active::before）。漏掉的话原型里
    // 看不出「现在在哪一页、用的是哪个供应商」，等于把选中态整个丢了。
    //
    // 只认一种写法：position:absolute + left + top + bottom + 固定 width，
    // 且 content 是空串。位置按父元素 padding box 推算 —— 这是 CSS 里
    // absolute 包含块的规则，不是给某几个元素开小灶。其余写法（百分比、
    // transform、content 是文字、只有 left/right 没有 width…）一律跳过：
    // 宁可少画一个装饰，也不能画错位置，错位的假信息比缺失更糟。
    const readPseudo = (which) => {
      const ps = getComputedStyle(el, which);
      if (!ps || ps.content === 'none' || ps.content === 'normal' || !ps.content) return;
      // content 去引号后还有内容 = 是文字，不是用来撑盒子的空串
      if (ps.content.replace(/^["']|["']$/g, '').length > 0) return;
      if (ps.position !== 'absolute' || ps.display === 'none') return;

      const w = parseFloat(ps.width);
      const top = parseFloat(ps.top);
      const bottom = parseFloat(ps.bottom);
      const left = parseFloat(ps.left);
      if (!(w > 0) || !Number.isFinite(top) || !Number.isFinite(bottom)) return;
      // left 是 auto 时横向位置由 right 说了算，这里推算不出来，跳过。
      if (!Number.isFinite(left)) return;

      const bT = parseFloat(cs.borderTopWidth) || 0;
      const bL = parseFloat(cs.borderLeftWidth) || 0;
      const bR = parseFloat(cs.borderRightWidth) || 0;
      const bB = parseFloat(cs.borderBottomWidth) || 0;
      const padBox = {
        x: r.x + bL,
        y: r.y + bT,
        w: r.width - bL - bR,
        h: r.height - bT - bB,
      };
      const h = padBox.h - top - bottom;
      if (h <= 0) return;

      const bg = ps.backgroundColor;
      if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') return;

      const corners = [
        ps.borderTopLeftRadius,
        ps.borderTopRightRadius,
        ps.borderBottomRightRadius,
        ps.borderBottomLeftRadius,
      ].map((v) => parseFloat(v) || 0);

      const rect = { x: padBox.x + left, y: padBox.y + top, w, h };
      const seen = clip ? intersect(clip, rect) : rect;

      // 四角半径在 SVG 的 <rect> 里只能给一个 —— 取最大的那个。
      // 这几处伪元素都只有 2~3px 宽，「全圆」与「只圆一侧」看不出差别。
      if (seen) {
        out.push({
          i: out.length,
          kind: 'box',
          tag: which,
          cls: (typeof el.className === 'string' ? el.className : ''),
          x: round(seen.x), y: round(seen.y), w: round(seen.w), h: round(seen.h),
          bg,
          bw: [0, 0, 0, 0],
          bc: [bg, bg, bg, bg],
          br: Math.max(...corners),
        });
      }
    };
    readPseudo('::before');
    readPseudo('::after');

    // ---- 表单控件的值：input 的 value / placeholder 不是子文本节点 ----
    // 供应商卡片上的「原样透传」就住在这里，漏掉它卡片里会空一块。
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      // <select> 的选中项文本既不是子文本节点、也不在 value 里（value 是
      // option 的 value 属性），得从 options 里取。用量页右上角那个
      // 「最近 24 小时」就这么漏掉过一次，只剩个空框。
      const v =
        el.tagName === 'SELECT'
          ? (el.options[el.selectedIndex] || {}).text || ''
          : el.value || el.getAttribute('placeholder') || '';
      if (v) {
        const fs = parseFloat(cs.fontSize);
        const padL = parseFloat(cs.paddingLeft) || 0;
        const padR = parseFloat(cs.paddingRight) || 0;
        // 密码框的 el.value 是**明文**，而屏幕上画的是圆点。原样带走会把
        // 真实 API key 写进原型文件 —— 这东西是要拿去给人看、甚至发出去的。
        // 按值长还原成等长的圆点，与浏览器渲染的样子一致。
        const shown = el.type === 'password' && el.value ? '•'.repeat(el.value.length) : v;
        out.push({
          i: out.length,
          kind: 'text',
          tag: el.tagName.toLowerCase(),
          cls: typeof el.className === 'string' ? el.className : '',
          x: round(box.x + padL), y: round(box.y),
          w: round(Math.max(box.w - padL - padR, 0)), h: round(box.h),
          text: shown,
          color: el.value ? cs.color : getComputedStyle(el, '::placeholder').color || cs.color,
          fs,
          fw: cs.fontWeight,
          // 保留浏览器给的完整字体栈：只取第一个族名会丢掉 'PingFang SC'
          // 这一档，中文就落到默认字体上了。浏览器已经把引号规范化过。
          ff: cs.fontFamily,
          lh: box.h,
          align: cs.textAlign,
          placeholder: !el.value,
        });
      }
    }

    // ---- 直接文本节点：逐个量 ----
    for (const node of el.childNodes) {
      if (node.nodeType !== 3) continue;
      const text = node.textContent.replace(/\\s+/g, ' ').trim();
      if (!text) continue;

      const range = document.createRange();
      range.selectNodeContents(node);
      const tr = range.getBoundingClientRect();
      if (tr.width <= 0 || tr.height <= 0) continue;

      const fs = parseFloat(cs.fontSize);
      const lh = parseFloat(cs.lineHeight);

      // 逐行拆开。SVG 的 <text> **不会自动折行**，而 DOM 里的文本被 CSS
      // 折成几行时，getBoundingClientRect 给出的是整个折行块的框（宽 = 最宽
      // 那行，高 = 行数 × 行高）—— 照它画，两三行会被压成一行、基线还落在
      // 块中心上。从真实截图里能直接看出来（侧边栏底部那行说明文字）。
      //
      // 拆行按字符量：每个字符一个 Range，行盒 top 相同的归为一行。这样每行
      // 的文字内容与几何都是精确的，落到 Figma 里也是逐行独立图层。
      // 单行（绝大多数）走原路径，不付逐字符测量的代价。
      const rowRects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      // 注意不能写 { ...tr }：DOMRect 的 x/y/width/height 是原型上的 getter，
      // 展开一个 DOMRect 得到的是空对象。
      const lines =
        rowRects.length > 1
          ? measureLines(node)
          : [{ x: tr.x, y: tr.y, w: tr.width, h: tr.height, text }];

      for (const line of lines) {
        // 行落到滚动区外就整行不要。行数是按真实换行位置量的，所以这里丢掉的
        // 正是用户在截图里看不到的那部分；只露出不到六成的一行也按「没露出来」
        // 处理，免得把半个字画到滚动区外面去。
        if (clip) {
          const seen = intersect(clip, line);
          if (!seen || seen.h < line.h * 0.6) continue;
        }

        out.push({
          i: out.length,
          kind: 'text',
          tag: el.tagName.toLowerCase(),
          cls: typeof el.className === 'string' ? el.className : '',
          x: round(line.x), y: round(line.y), w: round(line.w), h: round(line.h),
          text: line.text !== undefined ? line.text : text,
          color: cs.color,
          fs,
          fw: cs.fontWeight,
          // 保留浏览器给的完整字体栈：只取第一个族名会丢掉 'PingFang SC'
          // 这一档，中文就落到默认字体上了。浏览器已经把引号规范化过。
          ff: cs.fontFamily,
          lh: Number.isFinite(lh) ? lh : fs * 1.2,
          align: cs.textAlign,
        });
      }
    }

    for (const child of el.children) walk(child, innerClip);
  };

  // 视口本身就是最外层的裁剪框：贴着窗口边的东西（比如卡片网格的右缘）
  // 在截图里也不完整。
  walk(document.body, { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
  return { width: window.innerWidth, height: window.innerHeight, nodes: out };
`;

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

const goView = (view) => `
  const btn = document.querySelector('[data-view="${view}"]');
  if (!btn) throw new Error('找不到导航项：${view}');
  btn.click();
  await new Promise((r) => setTimeout(r, 450));
`;

const clickButton = (selector, text) => `
  const el = ${
    text
      ? `[...document.querySelectorAll('${selector}')].find((b) => b.textContent.trim() === '${text}')`
      : `document.querySelector('${selector}')`
  };
  if (!el) throw new Error('找不到按钮：${text || selector}');
  el.click();
  await new Promise((r) => setTimeout(r, 500));
`;

const reload = async (client) => {
  await client.send('Page.reload');
  await sleep(1200);
  await waitForReady(client.evaluate);
};

/** 每个场景：先摆好界面状态，再抓几何。fresh=true 的先把界面复位再操作。 */
const SCENES = [
  { name: '01-providers', label: '供应商视图', setup: null },
  { name: '02-logs', label: '日志视图', setup: goView('logs') },
  { name: '03-usage', label: '用量视图', setup: goView('usage') },
  { name: '04-setup-modal', label: '接管弹窗', setup: clickButton('#btn-setup'), fresh: true },
  {
    name: '05-profile-modal',
    label: '供应商编辑弹窗',
    setup: clickButton('.card-actions .btn', '编辑'),
    fresh: true,
  },
];

// ---------------------------------------------------------------------------
// SVG 生成 —— 把几何数据翻译成矢量图
// ---------------------------------------------------------------------------
//
// 目标不是「渲染得像」，而是「拖进 Figma 后每一项都还是可编辑图层」：
//   · 盒子 → <rect>（可选中、可拖、可改色改圆角）
//   · 文本 → <text>（可改字、可调字号字重）
//   · 图标 → 原样内联的 <svg>（路径级可编辑）
// 所以绝不用 <image> 贴图，也绝不把文字转成路径。

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * 字体栈。ff 是浏览器给的完整 computed 栈（引号已规范化过，如
 * `-apple-system, "SF Pro Text", ...`），直接沿用 —— 千万别自己再包一层
 * 引号：`'-apple-system'` 会被当成一个名字字面叫「-apple-system」的字体族，
 * 找不到就一路回退，整套字都变了。末尾补中文与通用兜底（重复无害）。
 */
const fontStack = (ff) => {
  const base = String(ff || '').trim();
  // 浏览器给的 computed 栈末尾本来就带通用族（sans-serif / monospace），
  // 再补一遍会让「通用族」出现在中文之前，看着冗余。有就不用补。
  if (/\b(sans-serif|serif|monospace)\s*$/.test(base)) return base;
  return base ? `${base}, sans-serif` : 'sans-serif';
};

/**
 * 边框颜色。**不能直接取 borderTopColor** —— 只给某一边设了 border 的元素
 * （比如侧边栏只有 border-right），另外三边的 computed color 是 currentColor
 * 解出来的正文色，浅灰；拿它描边会在近黑底上勾出一道本不存在的亮边。
 * 取真正最粗的那条边的颜色。
 */
const borderColor = (n) => {
  const widths = n.bw || [0, 0, 0, 0];
  let best = 0;
  for (let k = 1; k < 4; k++) if (widths[k] > widths[best]) best = k;
  return (n.bc && n.bc[best]) || 'none';
};

/**
 * 切分顶层逗号。色标里的 rgba(110, 123, 242, 0.18) 自带逗号，
 * 不能在括号里断句。顺带丢掉 CSS 里占位的 none 层。
 */
const splitTop = (s) => {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x && x !== 'none');
};

/**
 * 把 computed 的 linear-gradient(…) 解析成 SVG 渐变的方向向量与色标。
 *
 * 只认简单情形：单层线性渐变、角度是 0/90/180/270 或 to <side>、色标是
 * `<color> [<pos>%]`。碰到别的（多层叠加、对角线、radial/conic）返回 null
 * 退回纯色 —— 画不准就别画，凭空编一个渐变比没有渐变更误导人。
 */
const parseLinear = (css) => {
  const layers = splitTop(String(css || ''));
  if (layers.length !== 1) return null;
  const m = /^linear-gradient\((.*)\)$/i.exec(layers[0]);
  if (!m) return null;

  const args = splitTop(m[1]);
  if (args.length < 2) return null;

  // 方向向量用 objectBoundingBox 单位（0~1），直接写进 <linearGradient>。
  let vec = { x1: 0, y1: 0, x2: 0, y2: 1 }; // CSS 缺省是 to bottom
  const head = args[0];
  const byAngle = /^(-?[\d.]+)deg$/i.exec(head);
  const bySide = /^to\s+(top|bottom|left|right)$/i.exec(head);
  if (byAngle) {
    args.shift();
    const deg = ((parseFloat(byAngle[1]) % 360) + 360) % 360;
    const dirs = {
      0: { x1: 0, y1: 1, x2: 0, y2: 0 },
      90: { x1: 0, y1: 0, x2: 1, y2: 0 },
      180: { x1: 0, y1: 0, x2: 0, y2: 1 },
      270: { x1: 1, y1: 0, x2: 0, y2: 0 },
    };
    if (!dirs[deg]) return null;
    vec = dirs[deg];
  } else if (bySide) {
    args.shift();
    const v = bySide[1].toLowerCase();
    vec =
      v === 'top'
        ? { x1: 0, y1: 1, x2: 0, y2: 0 }
        : v === 'bottom'
          ? { x1: 0, y1: 0, x2: 0, y2: 1 }
          : v === 'left'
            ? { x1: 1, y1: 0, x2: 0, y2: 0 }
            : { x1: 0, y1: 0, x2: 1, y2: 0 };
  }

  const stops = args.map((part) => {
    const sm = /^(.*?)\s+(-?[\d.]+)%$/.exec(part);
    return { color: (sm ? sm[1] : part).trim(), pos: sm ? parseFloat(sm[2]) : null };
  });
  if (stops.some((s) => !/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(s.color))) return null;

  // 位置缺省时按 CSS 的规则补：首标 0、末标 100、中间沿用前一个。
  if (stops[0].pos === null) stops[0].pos = 0;
  if (stops[stops.length - 1].pos === null) stops[stops.length - 1].pos = 100;
  for (let k = 1; k < stops.length - 1; k++) {
    if (stops[k].pos === null) stops[k].pos = stops[k - 1].pos;
  }

  return { vec, stops };
};

/**
 * 文本基线。SVG 的 <text> y 是基线，而 Range 量出来的是行盒 ——
 * y + h/2 是行盒中心，再往下 fs*0.3 落到基线上（ascent≈0.8em、descent≈0.2em）。
 */
const baseline = (n) => Math.round((n.y + n.h / 2 + n.fs * 0.3) * 100) / 100;

/**
 * 图标。原 <svg> 的事件属性、<style> 之类在导出件里没意义，只留几何属性；
 * 固有尺寸换成目标尺寸，viewBox 保留 —— 嵌套 <svg> 的 viewBox 会自动缩放。
 */
function iconToSvg(n) {
  const gt = n.html.indexOf('>');
  const openTag = gt > -1 ? n.html.slice(0, gt + 1) : '';
  const inner = (gt > -1 ? n.html.slice(gt + 1) : '').replace(/<\/svg>\s*$/, '');
  const attrs = openTag
    .replace(/^<svg\b/, '')
    .replace(/>$/, '')
    .replace(/\son\w+="[^"]*"/g, '')
    .replace(/\s(width|height|x|y|color)="[^"]*"/g, '')
    .trim();
  const withVb = /viewBox=/.test(attrs)
    ? attrs
    : `${attrs} viewBox="${n.viewBox || `0 0 ${n.w} ${n.h}`}"`;
  // color 顶着 currentColor：图标内部普遍写 stroke/fill="currentColor"，
  // 而 currentColor 在这里没有祖先可继承，不显式给一个就退化成黑色。
  return (
    `  <svg x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}"` +
    ` color="${n.color || '#fff'}" ${withVb}>${inner}</svg>`
  );
}

function nodeToSvg(n) {
  if (n.kind === 'icon') return iconToSvg(n);

  if (n.kind === 'text') {
    const anchor =
      n.align === 'right' || n.align === 'end' ? 'end' : n.align === 'center' ? 'middle' : 'start';
    const x = anchor === 'end' ? n.x + n.w : anchor === 'middle' ? n.x + n.w / 2 : n.x;
    return (
      `  <text x="${Math.round(x * 100) / 100}" y="${baseline(n)}"` +
      ` font-family="${esc(fontStack(n.ff))}" font-size="${n.fs}" font-weight="${n.fw}"` +
      ` fill="${n.color}"` +
      (anchor === 'start' ? '' : ` text-anchor="${anchor}"`) +
      `>${esc(n.text)}</text>`
    );
  }

  // box
  const hasBorder = n.bw && n.bw.some((v) => v > 0);
  const geom = [
    `x="${n.x}"`,
    `y="${n.y}"`,
    `width="${n.w}"`,
    `height="${n.h}"`,
    n.br ? `rx="${n.br}"` : '',
  ];

  const stroke = hasBorder ? ` stroke="${borderColor(n)}" stroke-width="${Math.max(...n.bw)}"` : '';

  const grad = n.bgImage ? parseLinear(n.bgImage) : null;
  if (!grad) {
    return `  <rect ${geom.join(' ')} fill="${n.bg || 'none'}"${stroke}/>`;
  }

  // 有渐变的盒子要画两层：底色一层、渐变一层。渐变常常带透明度
  // （激活卡片就是从 rgba(…,0.18) 淡出到全透明），只画渐变会漏掉卡片底色。
  const id = `bg${n.i}`;
  const stops = grad.stops
    .map((s) => `<stop offset="${s.pos}%" stop-color="${s.color}"/>`)
    .join('');
  const defs =
    `  <defs><linearGradient id="${id}" x1="${grad.vec.x1}" y1="${grad.vec.y1}"` +
    ` x2="${grad.vec.x2}" y2="${grad.vec.y2}">${stops}</linearGradient></defs>\n`;

  return (
    defs +
    (n.bg ? `  <rect ${geom.join(' ')} fill="${n.bg}"${stroke}/>\n` : '') +
    `  <rect ${geom.join(' ')} fill="url(#${id})"${stroke}/>`
  );
}

function buildSvg(geom) {
  const body = geom.nodes.map(nodeToSvg).join('\n');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${geom.width}" height="${geom.height}"` +
    ` viewBox="0 0 ${geom.width} ${geom.height}">\n` +
    `  <rect width="${geom.width}" height="${geom.height}" fill="#0c0d0e"/>\n` +
    `${body}\n</svg>\n`
  );
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const home = makeFakeHome();
  console.log(`假 HOME：${home}\n`);

  const quitFlag = path.join(home, `quit-${Date.now()}`);
  const { child, log } = launchApp(home, quitFlag);

  let exited = false;
  const exitPromise = new Promise((resolve) => {
    child.on('exit', () => {
      exited = true;
      resolve();
    });
  });

  const geomDir = JSON_ONLY || path.join(PROJECT_ROOT, 'docs', 'prototype', 'geom');
  const svgDir = JSON_ONLY ? null : path.join(PROJECT_ROOT, 'docs', 'prototype', 'svg');
  fs.mkdirSync(geomDir, { recursive: true });
  if (svgDir) fs.mkdirSync(svgDir, { recursive: true });

  try {
    console.log('起 Electron…');
    const page = await waitForPage();
    const client = await connect(page);

    if (!(await waitForReady(client.evaluate))) {
      throw new Error('界面没能把主进程状态拉回来 —— 可能白屏了');
    }

    for (const scene of SCENES) {
      if (scene.fresh) await reload(client);
      if (scene.setup) await client.evaluate(scene.setup);

      const geom = await client.evaluate(EXTRACT);
      fs.writeFileSync(path.join(geomDir, `${scene.name}.json`), JSON.stringify(geom));

      let svgNote = '';
      if (svgDir) {
        const svgFile = path.join(svgDir, `${scene.name}.svg`);
        fs.writeFileSync(svgFile, buildSvg(geom));
        svgNote = `  + ${path.relative(PROJECT_ROOT, svgFile)}`;
      }

      console.log(
        `  ✓ ${scene.label}  ${geom.width}×${geom.height}  ${geom.nodes.length} 个条目${svgNote}`
      );
    }

    console.log('\n完成。');
  } finally {
    if (!exited) {
      fs.writeFileSync(quitFlag, '1');
      const raced = await Promise.race([
        exitPromise.then(() => 'exited'),
        sleep(10000).then(() => 'timeout'),
      ]);
      if (raced === 'timeout') {
        console.log('\n应用没在 10 秒内退出，强制结束。');
        console.log(log.join('').slice(-2000));
        child.kill();
      }
    }
  }
}

main().catch((err) => {
  console.error('\n导出失败：', err.message);
  process.exit(1);
});
