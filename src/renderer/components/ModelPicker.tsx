import { useEffect, useRef, useState } from 'react';
import { ccnb } from '../ccnb';
import { suggestModelMapping } from '../model-map.js';
import { describeFetchFailure } from '../describe';
import Combobox from './Combobox';
import type { ModelListItem, Profile, ClaudeModelNames } from '../types';
import type { ProfilesApi } from '../hooks/useProfiles';

// Claude Code 实际会发出的模型名是 settings.json 里写好的事实，整页只读一次。
// 每张卡片各读一次的话，供应商越多请求越多，而结果完全一样。
//
// 但**失败不缓存**：读不到通常是因为 settings.json 里还没有 _MODEL 结尾的键，
// 而那是用户随时会补上的（首次引导刻意不写 ANTHROPIC_MODEL，见 setup.js 的
// buildNextSettings）。把失败记下来的话，卡片会永远停在「读不到」上，
// 补好了也不恢复，除非重启应用 —— 这正是「重新读取」按钮要解的那条路。
let claudeModelsPromise: Promise<ClaudeModelNames> | null = null;
function getClaudeModels() {
  if (!claudeModelsPromise) {
    claudeModelsPromise = ccnb()
      .getClaudeModelNames()
      .catch(() => ({ ok: false as const, settingsPath: '' }))
      .then((info) => {
        if (!info.ok) claudeModelsPromise = null;
        return info;
      });
  }
  return claudeModelsPromise;
}

interface Field {
  label: string;
  name: string;
}

interface Props {
  profile: Profile;
  api: ProfilesApi;
}

export default function ModelPicker({ profile, api }: Props) {
  const [map, setMap] = useState<Record<string, string>>({ ...profile.modelMap });
  const [fields, setFields] = useState<Field[]>([]);
  const [modelItems, setModelItems] = useState<ModelListItem[]>([]);
  const [status, setStatus] = useState<{ text: string; warn: boolean }>({ text: '', warn: false });
  // 只有在读完一次之后才谈得上「读不到」—— 否则首帧也会闪出一个重试按钮
  const [namesChecked, setNamesChecked] = useState(false);
  // 点一次「重新读取」加一，靠它重跑下面那个 effect
  const [namesRetry, setNamesRetry] = useState(0);
  /*
   * 拉取是否在途。**只挡并发，不挡重试**。
   *
   * 早先这里是一个 fetchStarted 标志，在发起时就置位，于是 key 填错一次、
   * 改对之后再聚焦也不会重拉，候选永远空着 —— 只能重启应用。而主进程那侧
   * 特意做了两件事来支持「改完 key 重试」：失败结果不进缓存、
   * 缓存键带上 key 的尾部（见 models.js）。那个标志把它们全废掉了。
   *
   * 现在不设「已拉过」这道门：重复聚焦由主进程的 10 分钟缓存接住（不再打上游），
   * 失败则每次聚焦都真的重试一次。
   */
  const fetchingRef = useRef(false);

  // 外部改动（如编辑框「高级」里保存了映射）时同步回来。
  // 同 Combobox：用渲染期间调整而不是 useEffect，避免先渲染一帧旧值。
  // 比较的是对象身份 —— 每次 listProfiles/updateProfile 都会给出新对象，
  // 所以落盘后的真值一定会被读回来。
  const [lastModelMap, setLastModelMap] = useState(profile.modelMap);
  if (profile.modelMap !== lastModelMap) {
    setLastModelMap(profile.modelMap);
    setMap({ ...profile.modelMap });
  }

  // 读取源模型名（主模型 / 后台小任务）
  useEffect(() => {
    let cancelled = false;
    getClaudeModels().then((info) => {
      if (cancelled) return;
      const pairs: Field[] = [];
      if (info.ok) {
        if (info.main) pairs.push({ label: '主模型', name: info.main });
        if (info.fast) pairs.push({ label: '后台小任务', name: info.fast });
      }
      setFields(pairs);
      setNamesChecked(true);
      if (pairs.length === 0) {
        setStatus({
          text: '读不到 Claude Code 的模型名，请到「编辑 → 高级」手动填写映射',
          warn: true,
        });
      } else if (namesRetry > 0) {
        // 重读成功：把上一次的警告清掉，否则行出来了、警告还挂在下面
        setStatus({ text: '', warn: false });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [namesRetry]);

  const persist = async (next: Record<string, string>) => {
    try {
      await api.update(profile.id, { modelMap: next });
    } catch (err) {
      setStatus({ text: `⚠ 保存失败：${(err as Error).message}`, warn: true });
    }
  };

  const commit = (name: string, value: string) => {
    const next = { ...map };
    if (value) next[name] = value;
    else delete next[name];
    setMap(next);
    setStatus({ text: value ? '已保存' : '已改回原样透传', warn: false });
    persist(next);
  };

  const requestModels = async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    // 已经有候选时不再复述「正在拉取」，否则每次聚焦都会闪一下这句话
    if (modelItems.length === 0) setStatus({ text: '正在拉取模型列表…', warn: false });
    try {
      const result = await ccnb().listModels({ baseUrl: profile.baseUrl, apiKey: profile.apiKey });
      if (!result.ok) {
        setStatus({ text: `${describeFetchFailure(result)}，可直接手打模型 ID`, warn: true });
        return;
      }
      setModelItems(result.models);
      setStatus({ text: `可选 ${result.models.length} 个模型`, warn: false });
    } catch (err) {
      setStatus({ text: `⚠ ${(err as Error).message}`, warn: true });
    } finally {
      fetchingRef.current = false;
    }
  };

  // 对空字段给出可一键采纳的猜测（刻意不自动填入，避免悄悄改掉用户正在用的模型）
  const suggestions: Array<{ field: Field; guess: string }> = [];
  for (const field of fields) {
    if (map[field.name]) continue;
    const guess = suggestModelMapping(
      field.name,
      modelItems.map((m) => m.id)
    );
    if (guess) suggestions.push({ field, guess });
  }

  // 「高级」里手写的、这两个下拉覆盖不到的规则，必须让用户知道它们还在生效
  const managed = new Set(fields.map((f) => f.name));
  const extras = Object.keys(map).filter((k) => !managed.has(k));

  return (
    <div className="card-models" onClick={(e) => e.stopPropagation()}>
      <div className="card-model-rows">
        {fields.map((field) => (
          <div className="card-model-row" key={field.name}>
            <span className="card-model-label" title={field.name}>
              {field.label}
            </span>
            <Combobox
              value={map[field.name] || ''}
              options={modelItems}
              placeholder="原样透传"
              onCommit={(value) => commit(field.name, value)}
              onRequestModels={requestModels}
            />
          </div>
        ))}
      </div>

      <div className="card-model-hints">
        {suggestions.map(({ field, guess }) => (
          <button
            key={field.name}
            className="model-suggest"
            type="button"
            onClick={() => {
              const next = { ...map, [field.name]: guess };
              setMap(next);
              setStatus({ text: '已保存', warn: false });
              persist(next);
            }}
          >
            {field.label}：建议 {guess}
          </button>
        ))}
      </div>

      {extras.length > 0 && (
        <div className="card-note">
          另有 {extras.length} 条手动规则：{extras.join('，')}
        </div>
      )}

      <div className={`card-model-status${status.warn ? ' is-warn' : ''}`}>
        {status.text}
        {/* 读不到源模型名时给一条出路。读 Claude Code 配置失败**不进缓存**，
            所以点一下就是一个新的读取，不需要重启应用。 */}
        {namesChecked && fields.length === 0 && (
          <button className="card-retry" type="button" onClick={() => setNamesRetry((n) => n + 1)}>
            重新读取
          </button>
        )}
      </div>
    </div>
  );
}
