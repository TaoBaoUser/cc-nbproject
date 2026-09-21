import { useEffect, useRef, useState } from 'react';
import type { LogEvent } from '../types';

interface Props {
  entries: LogEvent[];
  onClear: () => void;
}

function toRow(entry: LogEvent) {
  const timestamp = entry.ts ? new Date(entry.ts) : new Date();
  const time = timestamp.toLocaleTimeString('zh-CN', { hour12: false });

  let message = '';
  let meta = '';
  let className = 'log-row';

  if (entry.kind === 'usage') {
    const tokens = (entry.inputTokens || 0) + (entry.outputTokens || 0);
    message = `${entry.profileName} · ${entry.model || '未知模型'}`;
    meta = `${entry.status} · ${entry.durationMs}ms · ${tokens} tokens`;
    if ((entry.status ?? 0) >= 400) className += ' is-error';
  } else if (entry.kind === 'switch') {
    message = `已切换到「${entry.profileName}」`;
    className += ' is-switch';
  } else if (entry.kind === 'request') {
    if (entry.phase === 'start') {
      message = `→ ${entry.method} ${entry.path}`;
      meta = entry.profileName ?? '';
    } else if (entry.phase === 'rewrite') {
      message = `模型映射：${entry.from} → ${entry.to}`;
      meta = entry.profileName ?? '';
      className += ' is-switch';
    } else if (entry.phase === 'error') {
      message = `上游错误：${entry.error}`;
      meta = entry.profileName ?? '';
      className += ' is-error';
    } else {
      // phase === 'end' 与 usage 事件重复，不单独展示，避免刷屏
      return null;
    }
  } else {
    return null;
  }

  return { time, message, meta, className };
}

export default function LogsView({ entries, onClear }: Props) {
  const [autoscroll, setAutoscroll] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoscroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [entries, autoscroll]);

  const rows = entries.map(toRow).filter((r): r is NonNullable<typeof r> => r !== null);

  return (
    <>
      <header className="view-header">
        <div>
          <h1>日志</h1>
          <p className="view-sub">实时请求记录</p>
        </div>
        <div className="actions">
          <label className="toggle">
            <input
              type="checkbox"
              id="log-autoscroll"
              checked={autoscroll}
              onChange={(e) => setAutoscroll(e.target.checked)}
            />
            <span>自动滚动</span>
          </label>
          <button className="btn btn-ghost btn-sm" id="btn-clear-logs" onClick={onClear}>
            清空
          </button>
        </div>
      </header>

      <div className="log-list" id="log-list" ref={listRef}>
        {rows.map((r, i) => (
          <div className={r.className} key={i}>
            <span className="log-time">{r.time}</span>
            <span className="log-msg">{r.message}</span>
            <span className="log-meta">{r.meta}</span>
          </div>
        ))}
      </div>
    </>
  );
}
