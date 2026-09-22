import ModelPicker from '../components/ModelPicker';
import { describeTestResult } from '../describe';
import type { Profile, TestResult } from '../types';
import type { ProfilesApi } from '../hooks/useProfiles';

interface Props {
  profile: Profile;
  isActive: boolean;
  testResult?: TestResult;
  api: ProfilesApi;
  onEdit: (profile: Profile) => void;
}

export default function ProviderCard({ profile, isActive, testResult, api, onEdit }: Props) {
  const result = describeTestResult(testResult);

  const handleDelete = async () => {
    // 删除会一并丢失该供应商保存的 API key，属于不可逆操作，必须确认
    const confirmed = window.confirm(
      `确定要删除供应商「${profile.name}」吗？\n\n` +
        `该操作不可撤销，保存在本地的 API key 也会一并删除。`
    );
    if (!confirmed) return;
    await api.remove(profile.id);
  };

  return (
    <div className={`card${isActive ? ' is-active' : ''}`} onClick={() => api.activate(profile.id)}>
      <div className="card-radio"></div>

      <div className="card-body">
        <div className="card-title">
          <span>{profile.name}</span>
          {isActive && <span className="badge">使用中</span>}
        </div>
        <div className="card-url">{profile.baseUrl}</div>

        <ModelPicker profile={profile} api={api} />

        {result && (
          <>
            <div
              className={`test-result ${result.ok === true ? 'ok' : result.ok === false ? 'fail' : ''}`}
            >
              {result.text}
            </div>
            {result.detail && (
              <div className="test-detail" title={result.detailTitle}>
                上游原话：{result.detail}
              </div>
            )}
          </>
        )}
      </div>

      <div className="card-actions">
        <button
          className="btn btn-ghost btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            api.test(profile.id);
          }}
        >
          测试
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(profile);
          }}
        >
          编辑
        </button>
        <button
          className="btn btn-ghost btn-sm btn-danger"
          onClick={(e) => {
            e.stopPropagation();
            handleDelete();
          }}
        >
          删除
        </button>
      </div>
    </div>
  );
}
