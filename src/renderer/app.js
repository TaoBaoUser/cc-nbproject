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

  // 映射规则是隐式生效的，不显示出来用户很容易忘了自己配过
  const mapCount = profile.modelMap ? Object.keys(profile.modelMap).length : 0;
  if (mapCount > 0) {
    const rules = Object.entries(profile.modelMap)
      .map(([from, to]) => `${from} → ${to}`)
      .join('，');
    body.appendChild(
      el('div', { className: 'card-note', text: `模型映射 ${mapCount} 条：${rules}` })
    );
  }

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
    unsupported: '该供应商没有 /v1/models 接口，请手动填写下方的映射',
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
 * 构建「模型映射」下方的辅助区：一个拉取按钮 + 拉取成功后展开的选择区。
 *
 * 目标模型用 `<input list>` + `<datalist>` 而不是 `<select>`：OpenRouter 有 446 个模型，
 * 原生下拉框翻起来是灾难；datalist 能边打边筛，且零依赖。
 *
 * 源模型名的候选读自 Claude Code 的 settings.json —— 让用户从**实际会发出的名字**里挑，
 * 而不是默写。这是从根上消灭"模型名写错"的办法（见设计文档 6.5 / 6.6）。
 *
 * 拉取失败不改变任何既有行为：按钮给出原因后，用户照旧手写文本框。
 */
function buildModelHelper({ urlInput, keyInput, modelMapInput, refreshMapStatus }) {
  const wrap = el('div', { className: 'model-helper' });

  const fetchBtn = el('button', {
    className: 'btn btn-ghost btn-sm',
    text: '从供应商拉取模型列表',
    attrs: { type: 'button' },
  });
  const status = el('div', { className: 'field-status' });

  // 拉取成功后才展开
  const picker = el('div', { className: 'model-picker' });
  picker.hidden = true;

  const targetOptions = el('datalist', { attrs: { id: 'ccnb-target-models' } });
  const sourceOptions = el('datalist', { attrs: { id: 'ccnb-source-models' } });

  const sourceInput = el('input', {
    attrs: { type: 'text', list: 'ccnb-source-models', placeholder: '源模型名' },
  });
  const targetInput = el('input', {
    attrs: { type: 'text', list: 'ccnb-target-models', placeholder: '目标模型 ID' },
  });
  const addBtn = el('button', {
    className: 'btn btn-sm btn-primary',
    text: '添加',
    attrs: { type: 'button' },
  });

  let availableModels = [];

  const setStatus = (text, warn = false) => {
    status.className = warn ? 'field-status is-warn' : 'field-status';
    status.textContent = text;
  };

  const applySuggestion = () => {
    if (availableModels.length === 0) return;
    const suggestion = suggestModelMapping(
      sourceInput.value.trim(),
      availableModels.map((model) => model.id)
    );
    // 猜不出来就保持原样，别把用户已经填好的内容清掉
    if (suggestion) targetInput.value = suggestion;
  };

  // 源模型名的候选来自 Claude Code 的实际配置
  window.ccnb
    .getClaudeModelNames()
    .then((info) => {
      if (!info || !info.ok) return;
      for (const entry of info.entries) {
        sourceOptions.appendChild(
          el('option', { attrs: { value: entry.name, label: entry.keys.join(' / ') } })
        );
      }
      if (!sourceInput.value) sourceInput.value = info.entries[0].name;
    })
    .catch(() => {
      // 读不到就退化成普通输入框，用户照样能手填
    });

  fetchBtn.addEventListener('click', async () => {
    const baseUrl = urlInput.value.trim();
    if (!baseUrl) {
      setStatus('⚠ 请先填写 Base URL', true);
      return;
    }
    fetchBtn.disabled = true;
    setStatus('正在拉取…');
    try {
      const result = await window.ccnb.listModels({ baseUrl, apiKey: keyInput.value.trim() });
      if (result.ok) {
        availableModels = result.models;
        targetOptions.replaceChildren();
        for (const model of result.models) {
          targetOptions.appendChild(
            el('option', { attrs: { value: model.id, label: model.name } })
          );
        }
        picker.hidden = false;
        setStatus(
          `已拉取 ${result.models.length} 个模型${result.cached ? '（来自缓存）' : ''}，` +
            '选好后点「添加」写入上方文本框。'
        );
        applySuggestion();
      } else {
        availableModels = [];
        picker.hidden = true;
        setStatus(`⚠ ${describeFetchFailure(result)}`, true);
      }
    } catch (err) {
      setStatus(`⚠ ${err.message}`, true);
    } finally {
      fetchBtn.disabled = false;
    }
  });

  sourceInput.addEventListener('input', applySuggestion);

  addBtn.addEventListener('click', () => {
    const source = sourceInput.value.trim();
    const target = targetInput.value.trim();
    if (!source || !target) {
      setStatus('⚠ 源模型名和目标模型都要填', true);
      return;
    }
    modelMapInput.value = upsertModelMapLine(modelMapInput.value, source, target);
    refreshMapStatus();
    targetInput.value = '';
    setStatus(`已写入：${source} → ${target}`);
  });

  picker.append(
    el('div', { className: 'picker-row' }, [
      el('span', { className: 'picker-label', text: '源模型名' }),
      sourceInput,
    ]),
    el('div', { className: 'picker-row' }, [
      el('span', { className: 'picker-label', text: '目标模型' }),
      targetInput,
    ]),
    el('div', { className: 'picker-actions' }, [addBtn])
  );

  wrap.append(fetchBtn, status, sourceOptions, targetOptions, picker);
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
      text: isEdit ? '修改后立即生效，无需重启' : '填入 Anthropic 兼容端点的地址与凭证',
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
  const mapField = field(
    '模型映射（可选）',
    modelMapInput,
    'Claude Code 发出的模型名在不同供应商那里叫法不同。每行一条「源=目标」，' +
      '未命中的模型名将原样转发。留空则不启用映射。'
  );
  mapField.appendChild(mapStatus);
  mapField.appendChild(buildModelHelper({ urlInput, keyInput, modelMapInput, refreshMapStatus }));
  modal.appendChild(mapField);

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
