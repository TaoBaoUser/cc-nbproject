import type { ClaudeStatus, ProxyStatus } from '../types';

type ViewName = 'providers' | 'logs' | 'usage';

interface Props {
  status: ProxyStatus | null;
  claude: ClaudeStatus | null;
  claudeBusy: boolean;
  claudeError: string;
  view: ViewName;
  onSwitchView: (view: ViewName) => void;
  onSetup: () => void;
  onTakeover: () => void;
  onDisconnect: () => void;
}

const NAV: Array<{ name: ViewName; label: string }> = [
  { name: 'providers', label: '供应商' },
  { name: 'logs', label: '日志' },
  { name: 'usage', label: '用量' },
];

/**
 * 接管状态的三态文案（PRD 的 R9）。
 *
 * 区分 active 与 pending 是这个项目的要害：两者都「授权过」，差别在于
 * **本次到底写没写进用户的文件**。把 pending 显示成「已接管」会让用户在
 * Claude Code 连不上时完全摸不着头脑 —— 界面说一切正常，配置里却还是旧地址。
 */
const CLAUDE_STATE_TEXT: Record<ClaudeStatus['state'], string> = {
  off: 'Claude Code 未接管',
  active: '已接管 Claude Code',
  pending: '已授权，本次未生效',
};

export default function Sidebar({
  status,
  claude,
  claudeBusy,
  claudeError,
  view,
  onSwitchView,
  onSetup,
  onTakeover,
  onDisconnect,
}: Props) {
  const running = status?.running ?? false;
  const state = claude?.state ?? 'off';

  const claudeHint = (() => {
    if (state === 'active') {
      return '每次启动自动接管，退出时自动还原';
    }
    if (state === 'pending') {
      return claude?.lastApply?.reason || '接管未能写入，请查看启动日志';
    }
    return '接管后 Claude Code 会走本工具的代理';
  })();

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-name">cc-nbproject</div>
        <div className="brand-sub">Claude Code 供应商路由</div>
      </div>

      <nav className="nav">
        {NAV.map((n) => (
          <button
            key={n.name}
            className={`nav-item${view === n.name ? ' is-active' : ''}`}
            data-view={n.name}
            onClick={() => onSwitchView(n.name)}
          >
            {n.label}
          </button>
        ))}
      </nav>

      <div className="proxy-card">
        <div className="proxy-line">
          <span className={`status-dot ${running ? 'is-on' : 'is-off'}`} id="proxy-dot"></span>
          <span id="proxy-label">{running ? '代理运行中' : '代理未运行'}</span>
        </div>
        <code className="proxy-url" id="proxy-url">
          {status?.baseUrl || '—'}
        </code>

        {/* 接管状态。data-state 供样式与冒烟测试选取，别改成纯文案匹配。 */}
        <div className="proxy-line claude-line" data-claude-state={state} id="claude-line">
          <span
            className={`status-dot ${
              state === 'active' ? 'is-on' : state === 'pending' ? 'is-warn' : 'is-off'
            }`}
            id="claude-dot"
          ></span>
          <span id="claude-label">{CLAUDE_STATE_TEXT[state]}</span>
        </div>
        <p className="hint" id="claude-hint">
          {claudeHint}
        </p>

        {state === 'off' && (
          <button className="btn btn-ghost btn-sm" id="btn-setup" onClick={onSetup}>
            接管 Claude Code
          </button>
        )}

        {state === 'pending' && (
          <button
            className="btn btn-ghost btn-sm"
            id="btn-retakeover"
            onClick={onTakeover}
            disabled={claudeBusy}
          >
            {claudeBusy ? '处理中…' : '重试接管'}
          </button>
        )}

        {/* 断开不做二次确认（PRD 第 8 节第 1 条的既定决策）：还原是「回到原样」
            的低风险动作，失败时上面那行 hint 会带出 lastRestore 的原因。 */}
        {state === 'active' && (
          <button
            className="btn btn-ghost btn-sm"
            id="btn-disconnect"
            onClick={onDisconnect}
            disabled={claudeBusy}
          >
            {claudeBusy ? '处理中…' : '断开接入'}
          </button>
        )}

        <div className="error-text" id="claude-error">
          {claudeError}
        </div>
      </div>
    </aside>
  );
}
