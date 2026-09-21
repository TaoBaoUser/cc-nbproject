import { useState } from 'react';
import { parseModelMap, findModelMapProblems } from '../model-map.js';
import { formatModelMap } from '../describe';
import type { Profile } from '../types';
import type { ProfilesApi } from '../hooks/useProfiles';

interface Props {
  /** null 表示「添加」 */
  profile: Profile | null;
  api: ProfilesApi;
  onClose: () => void;
}

export default function ProfileModal({ profile, api, onClose }: Props) {
  const isEdit = Boolean(profile);

  const [name, setName] = useState(profile?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(profile?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(profile?.apiKey ?? '');
  const [mapText, setMapText] = useState(formatModelMap(profile?.modelMap));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // 实时显示「解析成了几条规则」。这是映射功能唯一有效的自检手段：
  // 只填错一点点（比如换行没生效）也会让三条规则变成一条，而输入框本身看不出区别。
  const parsed = parseModelMap(mapText);
  const problems = findModelMapProblems(parsed);
  const parsedEntries = Object.entries(parsed);
  const mapStatus = problems.length
    ? { isWarn: true, text: `⚠ ${problems.join('；')}` }
    : {
        isWarn: false,
        text:
          parsedEntries.length > 0
            ? `已解析 ${parsedEntries.length} 条：${parsedEntries
                .map(([from, to]) => `${from} → ${to}`)
                .join('，')}`
            : '',
      };

  const mapCount = profile?.modelMap ? Object.keys(profile.modelMap).length : 0;

  const handleSave = async () => {
    const trimmed = { name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim() };
    if (!trimmed.name || !trimmed.baseUrl) {
      setError('名称和 Base URL 为必填项');
      return;
    }

    setSaving(true);
    try {
      const modelMap = parseModelMap(mapText);
      if (isEdit && profile) {
        await api.update(profile.id, { ...trimmed, modelMap });
      } else {
        await api.add({ ...trimmed, modelMap });
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="modal">
      <h2>{isEdit ? '编辑供应商' : '添加供应商'}</h2>
      <p className="modal-sub">
        {isEdit
          ? '修改后立即生效，无需重启。模型在卡片上直接选'
          : '填入 Anthropic 兼容端点的地址与凭证，模型稍后在卡片上选'}
      </p>

      <div className="field">
        <label>名称</label>
        <input
          type="text"
          placeholder="例如：DeepSeek"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="field">
        <label>Base URL</label>
        <input
          type="text"
          placeholder="https://api.deepseek.com/anthropic"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <div className="field-hint">Anthropic 兼容端点，通常以 /anthropic 结尾（视供应商而定）</div>
      </div>

      <div className="field">
        <label>API Key</label>
        <input
          type="password"
          placeholder="sk-..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <div className="field-hint">
          仅保存在本机 ~/.cc-nbproject/，文件权限 600，不会进入任何版本库
        </div>
      </div>

      {/* 映射收进「高级」：常规用法是到卡片上选模型，只有下拉覆盖不到的边角情况才需要手写规则 */}
      <details className="advanced">
        <summary>
          {mapCount > 0 ? `高级：手动映射规则（已有 ${mapCount} 条）` : '高级：手动映射规则'}
        </summary>
        <div className="field">
          <label>模型映射</label>
          <textarea
            className="textarea"
            rows={4}
            spellCheck={false}
            /* 占位示例必须是真实可用的一对。用户会直接照着改，示例里的目标名
               但凡写错，就变成了把人往坑里带 —— 这里曾把 flash 误写成 deepseek-chat
               （那是 V3），照抄会把后台小任务模型指到错误的代次上。 */
            placeholder={
              'deepseek-v4-pro=deepseek/deepseek-v4-pro\ndeepseek-flash=deepseek/deepseek-v4-flash'
            }
            value={mapText}
            onChange={(e) => setMapText(e.target.value)}
          />
          <div className="field-hint">
            Claude Code 发出的模型名在不同供应商那里叫法不同。每行一条「源=目标」，
            未命中的模型名将原样转发。留空则不启用映射。
          </div>
          <div className={mapStatus.isWarn ? 'field-status is-warn' : 'field-status'}>
            {mapStatus.text}
          </div>
        </div>
      </details>

      <div className="error-text">{error}</div>

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {isEdit ? '保存' : '添加'}
        </button>
      </div>
    </div>
  );
}
