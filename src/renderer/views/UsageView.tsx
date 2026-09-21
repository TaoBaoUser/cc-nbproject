import { useUsage } from '../hooks/useUsage';

type UsageApi = ReturnType<typeof useUsage>;

function formatNumber(value: number) {
  return (value || 0).toLocaleString('zh-CN');
}

export default function UsageView({ usage }: { usage: UsageApi }) {
  const summary = usage.summary;

  return (
    <>
      <header className="view-header">
        <div>
          <h1>用量</h1>
          <p className="view-sub">按供应商统计的 token 消耗</p>
        </div>
        <div className="actions">
          <select
            className="select"
            id="usage-range"
            value={usage.range}
            onChange={(e) => usage.setRange(e.target.value)}
          >
            <option value="86400000">最近 24 小时</option>
            <option value="604800000">最近 7 天</option>
            <option value="2592000000">最近 30 天</option>
            <option value="">全部</option>
          </select>
          <button className="btn btn-ghost btn-sm" id="btn-refresh-usage" onClick={usage.refresh}>
            刷新
          </button>
        </div>
      </header>

      <div className="stat-row" id="usage-total">
        {summary && (
          <>
            <div className="stat">
              <div className="stat-value">{formatNumber(summary.total.requests)}</div>
              <div className="stat-label">请求数</div>
            </div>
            <div className="stat">
              <div className="stat-value">{formatNumber(summary.total.inputTokens)}</div>
              <div className="stat-label">输入 token</div>
            </div>
            <div className="stat">
              <div className="stat-value">{formatNumber(summary.total.outputTokens)}</div>
              <div className="stat-label">输出 token</div>
            </div>
          </>
        )}
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>供应商</th>
            <th className="num">请求数</th>
            <th className="num">输入 token</th>
            <th className="num">输出 token</th>
            <th className="num">错误</th>
          </tr>
        </thead>
        <tbody id="usage-table">
          {(summary?.byProfile ?? []).map((row) => (
            <tr key={row.profileId}>
              <td>{row.profileName}</td>
              <td className="num">{formatNumber(row.requests)}</td>
              <td className="num">{formatNumber(row.inputTokens)}</td>
              <td className="num">{formatNumber(row.outputTokens)}</td>
              <td className="num">{formatNumber(row.errors)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="empty" id="usage-empty" hidden={(summary?.byProfile.length ?? 0) > 0}>
        <p>还没有用量记录。</p>
        <p className="hint">通过代理发起的请求会自动记录在这里。</p>
      </div>
    </>
  );
}
