import { useCallback, useEffect, useState } from 'react';
import { ccnb } from '../ccnb';
import type { ClaudeStatus, TakeoverActionResult } from '../types';

/**
 * 接管状态。侧边栏据此显示三态，并决定那个按钮是「接管」还是「断开接入」。
 *
 * 状态由主进程算（要读用户的 settings.json，渲染进程没有 fs），
 * 这里只负责拉取与在操作后刷新。
 */
export function useClaudeStatus() {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setStatus(await ccnb().getClaudeStatus());
  }, []);

  // 与 useProxyStatus 同一范式：挂载后拉一次主进程状态。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh().catch((err) => console.error('获取接管状态失败：', err));
  }, [refresh]);

  /**
   * 执行一次接管或断开，并在结束后刷新状态。
   *
   * 失败**不抛异常**：主进程把「代理没起来」「没有激活的供应商」这类准入失败
   * 也做成 ok:false 的返回值，它们是需要展示给用户的正常结果，不是异常。
   * 抛出去只会变成控制台里一行没人看的红字。
   */
  const run = useCallback(
    async (action: () => Promise<TakeoverActionResult>) => {
      setBusy(true);
      setError('');
      let result: TakeoverActionResult;
      try {
        result = await action();
      } catch (err) {
        result = { ok: false, reason: (err as Error).message };
      }
      if (!result.ok && !result.skipped) {
        setError(result.reason || '操作失败');
      }
      try {
        await refresh();
      } catch (err) {
        console.error('刷新接管状态失败：', err);
      }
      setBusy(false);
      return result;
    },
    [refresh]
  );

  const takeover = useCallback(() => run(() => ccnb().takeoverClaude()), [run]);
  const disconnect = useCallback(() => run(() => ccnb().disconnectClaude()), [run]);

  return { status, busy, error, refresh, takeover, disconnect };
}
