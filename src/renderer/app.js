'use strict';

/**
 * 渲染进程逻辑。
 *
 * 两条贯穿全文件的约束：
 *
 * 1. **只能通过 window.ccnb 访问主进程能力。** 那是 preload 里显式声明的白名单，
 *    不是完整的 ipcRenderer。
 *
 * 2. **所有外部文本一律用 textContent 写入，绝不拼接进 innerHTML。**
 *    日志内容直接来自上游 API 响应 —— 供应商返回什么，这里就显示什么。
 *    一旦用 innerHTML 拼接，上游返回的内容就会被当作 HTML 解析执行。
 *    为此下面的 el() 辅助函数刻意不提供 innerHTML 形式的接口，
 *    从源头堵住这条路。
 */

const $ = (selector) => document.querySelector(selector);

/** 创建元素。只接受文本内容，不接受 HTML 字符串。 */
function el(tag, { className, text, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

const state = {
  profiles: [],
  activeId: null,
  /** 连接测试结果：profileId -> 结果对象 */
  testResults: new Map(),
};

// ---------------------------------------------------------------------------
// 视图切换
// ---------------------------------------------------------------------------

function switchView(name) {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === name);
  });
  document.querySelectorAll('.view').forEach((section) => {
    section.classList.toggle('is-active', section.id === `view-${name}`);
  });
  if (name === 'usage') refreshUsage();
}

// ---------------------------------------------------------------------------
// 代理状态
// ---------------------------------------------------------------------------

async function refreshProxyStatus() {
  const status = await window.ccnb.getProxyStatus();
  const dot = $('#proxy-dot');
  dot.className = `status-dot ${status.running ? 'is-on' : 'is-off'}`;
  $('#proxy-label').textContent = status.running ? '代理运行中' : '代理未运行';
  $('#proxy-url').textContent = status.baseUrl || '—';
}

// ---------------------------------------------------------------------------
// 供应商
// ---------------------------------------------------------------------------

async function refreshProfiles() {
  const { profiles, activeId } = await window.ccnb.listProfiles();
  state.profiles = profiles;
  state.activeId = activeId;
  renderProviders();
}

function describeTestResult(result) {
  if (!result) return null;
  if (result.pending) return { ok: null, text: '测试中…' };
  if (result.ok) return { ok: true, text: `✓ 连通正常（${result.durationMs}ms）` };

  const reasons = {
    auth_failed: '认证失败 —— 请检查 API key',
    model_not_found: '端点与凭证可用，但模型名不被接受',
    network_error: `无法连接 —— ${result.message || '网络错误'}`,
    invalid_url: 'baseUrl 不是合法 URL',
    upstream_error: `上游返回 ${result.status}`,
  };

  // 把上游的原始报错一并带出来。它通常直接点明原因（收到了什么模型名、
  // 缺哪个参数），撇开它只剩一句「模型名不被接受」，用户根本无从下手。
  const verboseKinds = ['model_not_found', 'upstream_error'];
  const detail = verboseKinds.includes(result.kind) ? result.message || '' : '';

  return {
    ok: false,
    text: `✗ ${reasons[result.kind] || result.message || '未知错误'}`,
    detail: detail.slice(0, 300),
    detailTitle: detail,
  };
}

function renderProviderCard(profile) {
  const isActive = profile.id === state.activeId;
  const card = el('div', { className: `card${isActive ? ' is-active' : ''}` });

  const body = el('div', { className: 'card-body' });
  const titleChildren = [el('span', { text: profile.name })];
  if (isActive) titleChildren.push(el('span', { className: 'badge', text: '使用中' }));
  body.appendChild(el('div', { className: 'card-title' }, titleChildren));
  body.appendChild(el('div', { className: 'card-url', text: profile.baseUrl }));
  body.appendChild(buildCardModelControls(profile));

  const result = describeTestResult(state.testResults.get(profile.id));
  if (result) {
    const resultClass = result.ok === true ? 'ok' : result.ok === false ? 'fail' : '';
    body.appendChild(el('div', { className: `test-result ${resultClass}`, text: result.text }));
    if (result.detail) {
      // title 属性让鼠标悬停能看到未截断的完整报错
      body.appendChild(
        el('div', {
          className: 'test-detail',
          text: `上游原话：${result.detail}`,
          attrs: { title: result.detailTitle },
        })
      );
    }
  }

  const actions = el('div', { className: 'card-actions' });

  const testBtn = el('button', { className: 'btn btn-ghost btn-sm', text: '测试' });
  testBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    handleTest(profile.id);
  });

  const editBtn = el('button', { className: 'btn btn-ghost btn-sm', text: '编辑' });
  editBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    openProfileModal(profile);
  });

  const deleteBtn = el('button', { className: 'btn btn-ghost btn-sm btn-danger', text: '删除' });
  deleteBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    handleDelete(profile);
  });

  actions.append(testBtn, editBtn, deleteBtn);
  card.append(el('div', { className: 'card-radio' }), body, actions);

  // 点击卡片本身即切换供应商 —— 这是本工具最高频的操作
  card.addEventListener('click', () => handleActivate(profile.id));
  return card;
}

function renderProviders() {
  const list = $('#provider-list');
  list.replaceChildren();
  $('#provider-empty').hidden = state.profiles.length > 0;
  for (const profile of state.profiles) {
    list.appendChild(renderProviderCard(profile));
  }
}

async function handleActivate(id) {
  if (id === state.activeId) return;
  await window.ccnb.activateProfile(id);
  // 无需重启 Claude Code，也无需重启代理 —— 代理每次请求都会重新读取当前供应商
  await refreshProfiles();
}

async function handleTest(id) {
  state.testResults.set(id, { pending: true });
  renderProviders();
  try {
    state.testResults.set(id, await window.ccnb.testProfile(id));
  } catch (err) {
    state.testResults.set(id, { ok: false, kind: 'error', message: err.message });
  }
  renderProviders();
}

async function handleDelete(profile) {
  // 删除会一并丢失该供应商保存的 API key，属于不可逆操作，必须确认
  const confirmed = window.confirm(
    `确定要删除供应商「${profile.name}」吗？\n\n` +
      `该操作不可撤销，保存在本地的 API key 也会一并删除。`
  );
  if (!confirmed) return;
  await window.ccnb.removeProfile(profile.id);
  state.testResults.delete(profile.id);
  await refreshProfiles();
}

// ---------------------------------------------------------------------------
// 添加 / 编辑模态框
// ---------------------------------------------------------------------------

function closeModal() {
  const root = $('#modal-root');
  root.hidden = true;
  root.replaceChildren();
}

// parseModelMap / findModelMapProblems 来自 model-map.js（由 index.html 先行加载）。
// 拆出去是为了让这段解析逻辑有单元测试 —— 它曾静默写坏过用户的配置。

/**
 * 把「拉取模型列表」失败的原因翻译成用户能照着做的话。
 *
 * `unsupported` 是最常见的一种，而且**不是错误** —— 只是这个供应商没有该接口
 * （实测 DeepSeek 就是 404）。文案必须明确说"请手动填写"，
 * 否则用户会以为是自己哪里配错了，反复折腾一个根本不存在的东西。
 */
function describeFetchFailure(result) {
  const reasons = {
    // 只说事实，不说"请手动填写" —— 卡片上本来就可以直接手打，
    // 加一句指路的废话反而会让文案变长、重点变模糊
    unsupported: '该供应商没有 /v1/models 接口',
    auth_failed: '认证失败 —— 请检查 API key',
    network_error: `无法连接 —— ${result.message || '网络错误'}`,
    invalid_url: 'Base URL 不是合法 URL',
    empty: '接口有响应但没有返回任何模型',
  };
  return reasons[result.kind] || result.message || '拉取失败';
}

function formatModelMap(modelMap) {
  if (!modelMap) return '';
  return Object.entries(modelMap)
    .map(([from, to]) => `${from}=${to}`)
    .join('\n');
}

/**
 * Claude Code 实际会发出的模型名。
 *
 * 整页只读一次：它是 `settings.json` 里已经写好的**事实**，不会在运行中变化。
 * 每张卡片各读一次的话，供应商越多请求越多，而结果完全一样。
 */
let claudeModelsPromise = null;
function getClaudeModels() {
  if (!claudeModelsPromise) {
    claudeModelsPromise = window.ccnb.getClaudeModelNames().catch(() => ({ ok: false }));
  }
  return claudeModelsPromise;
}

/**
 * 卡片上的模型选择区。
 *
 * **为什么在卡片上而不是编辑框里**：加一个供应商是"配一次就不动"的事，换模型是
 * "想换就换"的事。把两件事捆进同一个表单，结果是每换一次模型都要打开编辑框走一遍流程。
 *
 * **为什么用 `<input list>` 而不是 `<select>`**：DeepSeek 这类供应商根本没有
 * `/v1/models` 接口（实测 404），下拉框会是空的，用户就彻底没法填了。
 * 带 datalist 的文本框既能边打边筛（OpenRouter 有 446 个模型），又永远允许手打。
 *
 * **改完立即保存**，没有"保存"按钮：换模型不该比换供应商更麻烦。
 *
 * 写进去的是 `profile.modelMap`，与「高级」里手写的映射是同一份数据 ——
 * 这样代理的改写逻辑一行都不用动（见设计文档 6.7）。
 */
function buildCardModelControls(profile) {
  const wrap = el('div', { className: 'card-models' });
  // 卡片本身"点击即切换供应商"，这里的控件不能连累整张卡
  wrap.addEventListener('click', (event) => event.stopPropagation());

  // datalist 的 id 必须每张卡片唯一，否则多张卡片的候选会互相串
  const listId = `ccnb-models-${profile.id}`;
  const options = el('datalist', { attrs: { id: listId } });
  const rows = el('div', { className: 'card-model-rows' });
  const hints = el('div', { className: 'card-model-hints' });
  const status = el('div', { className: 'card-model-status' });

  const map = { ...(profile.modelMap || {}) };
  /** @type {Array<{label: string, name: string, input: HTMLInputElement}>} */
  const fields = [];
  let modelIds = [];
  let fetchStarted = false;

  const setStatus = (text, warn = false) => {
    status.className = warn ? 'card-model-status is-warn' : 'card-model-status';
    status.textContent = text;
  };

  const persist = async () => {
    try {
      await window.ccnb.updateProfile(profile.id, { modelMap: map });
      /*
       * 落盘之后必须把内存里这份 profile 也同步掉。
       *
       * 这一步看着冗余（卡片马上会被重建），但漏掉它会丢数据：
       * 编辑框是用 `profile.modelMap` 预填「高级」文本框、并在保存时用文本框的
       * 内容整体覆盖 modelMap 的。内存里那份若还停在旧值，用户就会看到
       * —— 在卡片上选好了模型 → 打开编辑框，「高级」里空空如也 →
       * 点「保存」→ 刚选好的映射被空文本整体覆盖掉。
       *
       * 冒烟检查的 5b 步就是盯着这条：采纳建议后重开编辑框，「高级」标题
       * 必须如实显示「已有 N 条」。
       */
      profile.modelMap = { ...map };
    } catch (err) {
      setStatus(`⚠ 保存失败：${err.message}`, true);
    }
  };

  const addField = (label, name) => {
    const input = el('input', {
      attrs: { type: 'text', list: listId, spellcheck: 'false', placeholder: '原样透传' },
    });
    input.value = map[name] || '';
    input.addEventListener('focus', ensureModels);
    input.addEventListener('change', async () => {
      const value = input.value.trim();
      // 清空就是取消映射。不能留一条空规则 —— 那会让请求带一个空模型名出去
      if (value) map[name] = value;
      else delete map[name];
      await persist();
      setStatus(value ? '已保存' : '已改回原样透传');
    });

    fields.push({ label, name, input });
    rows.appendChild(
      el('div', { className: 'card-model-row' }, [
        // 标签直接用它对应的 Claude Code 配置键做悬停提示，
        // 省得用户去猜"主模型"到底对应哪个键
        el('span', { className: 'card-model-label', text: label, attrs: { title: name } }),
        input,
      ])
    );
  };

  /**
   * 拉一次模型列表，填充候选。
   * 只在第一次聚焦时发起 —— 卡片是每次刷新都重建的，若不这样每张卡都会打一轮请求。
   */
  async function ensureModels() {
    if (fetchStarted) return;
    fetchStarted = true;
    setStatus('正在拉取模型列表…');
    try {
      const result = await window.ccnb.listModels({
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
      });
      if (!result.ok) {
        setStatus(`${describeFetchFailure(result)}，可直接手打模型 ID`, true);
        return;
      }
      modelIds = result.models.map((model) => model.id);
      options.replaceChildren(
        ...result.models.map((model) =>
          el('option', { attrs: { value: model.id, label: model.name } })
        )
      );
      setStatus(`可选 ${modelIds.length} 个模型`);
      addSuggestions();
    } catch (err) {
      setStatus(`⚠ ${err.message}`, true);
    }
  }

  /**
   * 给出可一键采用的猜测值。
   *
   * 刻意**不自动填入**：那等于替用户改掉了他正在用的模型，而界面上没有任何提示。
   * 摆一个可点的建议，采不采纳由用户决定 —— 少一次点击不值得用"悄悄改配置"来换。
   */
  const addSuggestions = () => {
    for (const field of fields) {
      if (field.input.value.trim()) continue; // 用户已经选好了就别插手
      const guess = suggestModelMapping(field.name, modelIds);
      if (!guess) continue;

      const chip = el('button', {
        className: 'model-suggest',
        text: `${field.label}：建议 ${guess}`,
        attrs: { type: 'button' },
      });
      chip.addEventListener('click', async () => {
        field.input.value = guess;
        map[field.name] = guess;
        await persist();
        chip.remove();
        setStatus('已保存');
      });
      hints.appendChild(chip);
    }
  };

  // 源模型名读自 Claude Code 的配置：Claude Code 会发什么名字是**事实**，
  // 不该让用户去挑一个"源"（见设计文档 6.7）
  getClaudeModels().then((info) => {
    const pairs = [];
    if (info && info.ok) {
      if (info.main) pairs.push(['主模型', info.main]);
      if (info.fast) pairs.push(['后台小任务', info.fast]);
    }
    if (pairs.length === 0) {
      setStatus('读不到 Claude Code 的模型名，请到「编辑 → 高级」手动填写映射', true);
      return;
    }
    for (const [label, name] of pairs) addField(label, name);

    // 「高级」里手写的、这两个下拉覆盖不到的规则，必须让用户知道它们还在生效
    const managed = new Set(fields.map((f) => f.name));
    const extras = Object.keys(map).filter((key) => !managed.has(key));
    if (extras.length > 0) {
      wrap.appendChild(
        el('div', {
          className: 'card-note',
          text: `另有 ${extras.length} 条手动规则：${extras.join('，')}`,
        })
      );
    }
  });

  wrap.append(options, rows, hints, status);
  return wrap;
}

function openProfileModal(profile = null) {
  const isEdit = Boolean(profile);
  const root = $('#modal-root');
  root.replaceChildren();
  root.hidden = false;

  const modal = el('div', { className: 'modal' });
  modal.appendChild(el('h2', { text: isEdit ? '编辑供应商' : '添加供应商' }));
  modal.appendChild(
    el('p', {
      className: 'modal-sub',
      text: isEdit
        ? '修改后立即生效，无需重启。模型在卡片上直接选'
        : '填入 Anthropic 兼容端点的地址与凭证，模型稍后在卡片上选',
    })
  );

  const nameInput = el('input', { attrs: { type: 'text', placeholder: '例如：DeepSeek' } });
  nameInput.value = profile ? profile.name : '';

  const urlInput = el('input', {
    attrs: { type: 'text', placeholder: 'https://api.deepseek.com/anthropic' },
  });
  urlInput.value = profile ? profile.baseUrl : '';

  const keyInput = el('input', { attrs: { type: 'password', placeholder: 'sk-...' } });
  keyInput.value = profile ? profile.apiKey : '';

  const modelMapInput = el('textarea', {
    className: 'textarea',
    attrs: {
      rows: '4',
      spellcheck: 'false',
      // 占位示例必须是**真实可用**的一对。用户会直接照着改，示例里的目标名
      // 但凡写错，就变成了把人往坑里带 —— 这里曾把 flash 误写成 deepseek-chat
      // （那是 V3），照抄会把后台小任务模型指到错误的代次上。
      placeholder:
        'deepseek-v4-pro=deepseek/deepseek-v4-pro\ndeepseek-flash=deepseek/deepseek-v4-flash',
    },
  });
  modelMapInput.value = formatModelMap(profile && profile.modelMap);

  // 实时显示"解析成了几条规则"。
  // 这是映射功能唯一有效的自检手段：只填错一点点（比如换行没生效）也会让
  // 三条规则变成一条，而输入框本身看不出区别 —— 必须把解析结果摆出来。
  const mapStatus = el('div', { className: 'field-status' });
  const refreshMapStatus = () => {
    const parsed = parseModelMap(modelMapInput.value);
    const problems = findModelMapProblems(parsed);

    if (problems.length > 0) {
      mapStatus.className = 'field-status is-warn';
      mapStatus.textContent = `⚠ ${problems.join('；')}`;
      return;
    }
    mapStatus.className = 'field-status';
    const entries = Object.entries(parsed);
    mapStatus.textContent =
      entries.length > 0
        ? `已解析 ${entries.length} 条：${entries.map(([f, t]) => `${f} → ${t}`).join('，')}`
        : '';
  };
  modelMapInput.addEventListener('input', refreshMapStatus);
  refreshMapStatus();

  const field = (labelText, input, hint) => {
    const wrap = el('div', { className: 'field' });
    wrap.appendChild(el('label', { text: labelText }));
    wrap.appendChild(input);
    if (hint) wrap.appendChild(el('div', { className: 'field-hint', text: hint }));
    return wrap;
  };

  modal.appendChild(field('名称', nameInput));
  modal.appendChild(
    field('Base URL', urlInput, 'Anthropic 兼容端点，通常以 /anthropic 结尾（视供应商而定）')
  );
  modal.appendChild(
    field('API Key', keyInput, '仅保存在本机 ~/.cc-nbproject/，文件权限 600，不会进入任何版本库')
  );
  // 映射收进「高级」：常规用法是到卡片上选模型（见设计文档 6.7），
  // 只有下拉覆盖不到的边角情况才需要手写规则
  const mapField = field(
    '模型映射',
    modelMapInput,
    'Claude Code 发出的模型名在不同供应商那里叫法不同。每行一条「源=目标」，' +
      '未命中的模型名将原样转发。留空则不启用映射。'
  );
  mapField.appendChild(mapStatus);

  const advanced = el('details', { className: 'advanced' });
  const mapCount = profile && profile.modelMap ? Object.keys(profile.modelMap).length : 0;
  advanced.appendChild(
    el('summary', {
      text: mapCount > 0 ? `高级：手动映射规则（已有 ${mapCount} 条）` : '高级：手动映射规则',
    })
  );
  advanced.appendChild(mapField);
  modal.appendChild(advanced);

  const errorText = el('div', { className: 'error-text' });
  modal.appendChild(errorText);

  const cancelBtn = el('button', { className: 'btn', text: '取消' });
  cancelBtn.addEventListener('click', closeModal);

  const saveBtn = el('button', { className: 'btn btn-primary', text: isEdit ? '保存' : '添加' });
  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const baseUrl = urlInput.value.trim();
    const apiKey = keyInput.value.trim();
    const modelMap = parseModelMap(modelMapInput.value);

    if (!name || !baseUrl) {
      errorText.textContent = '名称和 Base URL 为必填项';
      return;
    }

    saveBtn.disabled = true;
    try {
      if (isEdit) {
        await window.ccnb.updateProfile(profile.id, { name, baseUrl, apiKey, modelMap });
      } else {
        await window.ccnb.addProfile({ name, baseUrl, apiKey, modelMap });
      }
      closeModal();
      await refreshProfiles();
    } catch (err) {
      errorText.textContent = err.message;
      saveBtn.disabled = false;
    }
  });

  const actions = el('div', { className: 'modal-actions' }, [cancelBtn, saveBtn]);
  modal.appendChild(actions);

  // 点击遮罩关闭；点击模态框内部不关闭
  root.addEventListener('click', (event) => {
    if (event.target === root) closeModal();
  });

  root.appendChild(modal);
  nameInput.focus();
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

const MAX_LOG_ROWS = 500;

function renderLogRow(entry) {
  const list = $('#log-list');
  const timestamp = entry.ts ? new Date(entry.ts) : new Date();
  const time = timestamp.toLocaleTimeString('zh-CN', { hour12: false });

  let message = '';
  let meta = '';
  let className = 'log-row';

  if (entry.kind === 'usage') {
    const tokens = (entry.inputTokens || 0) + (entry.outputTokens || 0);
    message = `${entry.profileName} · ${entry.model || '未知模型'}`;
    meta = `${entry.status} · ${entry.durationMs}ms · ${tokens} tokens`;
    if (entry.status >= 400) className += ' is-error';
  } else if (entry.kind === 'switch') {
    message = `已切换到「${entry.profileName}」`;
    className += ' is-switch';
  } else if (entry.kind === 'request') {
    if (entry.phase === 'start') {
      message = `→ ${entry.method} ${entry.path}`;
      meta = entry.profileName;
    } else if (entry.phase === 'rewrite') {
      message = `模型映射：${entry.from} → ${entry.to}`;
      meta = entry.profileName;
      className += ' is-switch';
    } else if (entry.phase === 'error') {
      message = `上游错误：${entry.error}`;
      meta = entry.profileName;
      className += ' is-error';
    } else {
      // phase === 'end' 与 usage 事件重复，不单独展示，避免刷屏
      return;
    }
  } else {
    return;
  }

  list.appendChild(
    el('div', { className }, [
      el('span', { className: 'log-time', text: time }),
      el('span', { className: 'log-msg', text: message }),
      el('span', { className: 'log-meta', text: meta }),
    ])
  );

  while (list.childElementCount > MAX_LOG_ROWS) {
    list.removeChild(list.firstElementChild);
  }

  if ($('#log-autoscroll').checked) {
    list.scrollTop = list.scrollHeight;
  }
}

// ---------------------------------------------------------------------------
// 用量
// ---------------------------------------------------------------------------

function formatNumber(value) {
  return (value || 0).toLocaleString('zh-CN');
}

async function refreshUsage() {
  const raw = $('#usage-range').value;
  const summary = await window.ccnb.getUsageSummary(raw ? { sinceMs: Number(raw) } : {});

  const stats = $('#usage-total');
  stats.replaceChildren(
    el('div', { className: 'stat' }, [
      el('div', { className: 'stat-value', text: formatNumber(summary.total.requests) }),
      el('div', { className: 'stat-label', text: '请求数' }),
    ]),
    el('div', { className: 'stat' }, [
      el('div', { className: 'stat-value', text: formatNumber(summary.total.inputTokens) }),
      el('div', { className: 'stat-label', text: '输入 token' }),
    ]),
    el('div', { className: 'stat' }, [
      el('div', { className: 'stat-value', text: formatNumber(summary.total.outputTokens) }),
      el('div', { className: 'stat-label', text: '输出 token' }),
    ])
  );

  const tbody = $('#usage-table');
  tbody.replaceChildren();
  for (const row of summary.byProfile) {
    tbody.appendChild(
      el('tr', {}, [
        el('td', { text: row.profileName }),
        el('td', { className: 'num', text: formatNumber(row.requests) }),
        el('td', { className: 'num', text: formatNumber(row.inputTokens) }),
        el('td', { className: 'num', text: formatNumber(row.outputTokens) }),
        el('td', { className: 'num', text: formatNumber(row.errors) }),
      ])
    );
  }

  $('#usage-empty').hidden = summary.byProfile.length > 0;
}

// ---------------------------------------------------------------------------
// Claude Code 配置引导
// ---------------------------------------------------------------------------

async function runClaudeSetup() {
  const root = $('#modal-root');
  root.replaceChildren();
  root.hidden = false;

  let preview;
  try {
    preview = await window.ccnb.previewClaudeSettings();
  } catch (err) {
    const modal = el('div', { className: 'modal' }, [
      el('h2', { text: '无法读取 Claude Code 配置' }),
      el('p', { className: 'modal-sub', text: err.message }),
      el('div', { className: 'modal-actions' }, [
        (() => {
          const btn = el('button', { className: 'btn', text: '关闭' });
          btn.addEventListener('click', closeModal);
          return btn;
        })(),
      ]),
    ]);
    root.appendChild(modal);
    return;
  }

  const modal = el('div', { className: 'modal' });
  modal.appendChild(el('h2', { text: '配置 Claude Code' }));
  modal.appendChild(
    el('p', {
      className: 'modal-sub',
      text: '将 Claude Code 的 Anthropic 端点指向本工具的本地代理。这是本工具唯一会修改你现有文件的操作。',
    })
  );

  // 企业强制配置会覆盖一切用户级设置，这种失败是静默的，必须显式告警
  if (preview.managedConflict) {
    modal.appendChild(
      el('div', {
        className: 'notice notice-warn',
        text:
          `检测到企业级强制配置：${preview.managedConflict.path}\n` +
          `其中已下发 ANTHROPIC_BASE_URL（${preview.managedConflict.baseUrl}）。` +
          `它的优先级高于用户配置，本工具将无法生效。`,
      })
    );
  }

  modal.appendChild(
    el('div', {
      className: 'notice notice-info',
      text: preview.exists
        ? `目标文件：${preview.settingsPath}\n写入前会自动备份为：${preview.backupPath}`
        : `目标文件尚不存在，将被创建：${preview.settingsPath}`,
    })
  );

  // 改动对照表：让用户在点确认前，逐项看清到底改了什么
  const table = el('table', { className: 'diff-table' });
  table.appendChild(
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: '配置项' }),
        el('th', { text: '当前值' }),
        el('th', { text: '将改为' }),
      ]),
    ])
  );
  const tbody = el('tbody');
  for (const change of preview.changes) {
    tbody.appendChild(
      el('tr', {}, [
        el('td', { text: change.key }),
        el('td', { className: 'diff-from', text: change.from || '（未设置）' }),
        el('td', { className: 'diff-to', text: change.to }),
      ])
    );
  }
  table.appendChild(tbody);
  modal.appendChild(table);

  modal.appendChild(
    el('p', {
      className: 'hint',
      text: '注意：真实 API key 由本工具管理，Claude Code 侧只写入占位符，因此你的凭证不会再散落在 Claude Code 的配置里。',
    })
  );

  const errorText = el('div', { className: 'error-text' });
  modal.appendChild(errorText);

  const cancelBtn = el('button', { className: 'btn', text: '取消' });
  cancelBtn.addEventListener('click', closeModal);

  const confirmBtn = el('button', { className: 'btn btn-primary', text: '确认写入' });
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    try {
      const result = await window.ccnb.applyClaudeSettings();
      const done = el('div', { className: 'modal' }, [
        el('h2', { text: '写入完成' }),
        el('p', { className: 'modal-sub', text: '请重启 Claude Code 以加载新的配置。' }),
        el('div', {
          className: 'notice notice-info',
          text: result.backupPath
            ? `原配置已备份至：\n${result.backupPath}`
            : '原文件不存在，未产生备份。',
        }),
        el('div', { className: 'modal-actions' }, [
          (() => {
            const btn = el('button', { className: 'btn btn-primary', text: '好' });
            btn.addEventListener('click', closeModal);
            return btn;
          })(),
        ]),
      ]);
      root.replaceChildren(done);
    } catch (err) {
      errorText.textContent = err.message;
      confirmBtn.disabled = false;
    }
  });

  modal.appendChild(el('div', { className: 'modal-actions' }, [cancelBtn, confirmBtn]));
  root.appendChild(modal);
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

async function init() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  $('#btn-add').addEventListener('click', () => openProfileModal());
  $('#btn-setup').addEventListener('click', runClaudeSetup);

  $('#btn-clear-logs').addEventListener('click', () => {
    $('#log-list').replaceChildren();
  });

  $('#btn-refresh-usage').addEventListener('click', refreshUsage);
  $('#usage-range').addEventListener('change', refreshUsage);

  // 订阅主进程推送的实时事件
  window.ccnb.onLogEvent(renderLogRow);

  await refreshProxyStatus();
  await refreshProfiles();
}

init().catch((err) => {
  console.error('初始化失败：', err);
});
