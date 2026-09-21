import { useCallback, useEffect, useState } from 'react';
import { ccnb } from '../ccnb';
import type { UsageSummary } from '../types';

export function useUsage() {
  const [range, setRange] = useState('86400000'); // 最近 24 小时
  const [summary, setSummary] = useState<UsageSummary | null>(null);

  const refresh = useCallback(async (r: string) => {
    const sinceMs = r ? Number(r) : undefined;
    setSummary(await ccnb().getUsageSummary(sinceMs ? { sinceMs } : {}));
  }, []);

  // 同 useProxyStatus：range 变化即重新拉取，setSummary 在 await 之后才发生。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh(range).catch((err) => console.error('加载用量失败：', err));
  }, [range, refresh]);

  return { range, setRange, summary, refresh: () => refresh(range) };
}
