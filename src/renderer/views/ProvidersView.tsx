import ProviderCard from './ProviderCard';
import type { ProfilesApi } from '../hooks/useProfiles';
import type { Profile } from '../types';

interface Props {
  api: ProfilesApi;
  onEdit: (profile: Profile | null) => void;
}

export default function ProvidersView({ api, onEdit }: Props) {
  return (
    <>
      <header className="view-header">
        <div>
          <h1>供应商</h1>
          <p className="view-sub">点击卡片即可切换，正在运行的 Claude Code 会话无需重启</p>
        </div>
        <button className="btn btn-primary" id="btn-add" onClick={() => onEdit(null)}>
          添加供应商
        </button>
      </header>

      <div className="list" id="provider-list">
        {api.profiles.map((p) => (
          <ProviderCard
            key={p.id}
            profile={p}
            isActive={p.id === api.activeId}
            testResult={api.testResults.get(p.id)}
            api={api}
            onEdit={onEdit}
          />
        ))}
      </div>

      <div className="empty" id="provider-empty" hidden={api.profiles.length > 0}>
        <p>还没有任何供应商。</p>
        <p className="hint">添加一个后，把 Claude Code 指向左侧的代理地址即可。</p>
      </div>
    </>
  );
}
