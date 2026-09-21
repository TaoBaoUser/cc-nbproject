import { useCallback, useEffect, useState } from 'react';
import { ccnb } from '../ccnb';
import type { ProxyStatus } from '../types';

export function useProxyStatus() {
  const [status, setStatus] = useState<ProxyStatus | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await ccnb().getProxyStatus());
  }, []);

  // 「挂载后拉一次主进程状态」是 effect 的正当用法：这里没有外部订阅可挂，
  // setStatus 也确实发生在 await 之后（不在 effect 同步执行段里）。
  // 规则认不出跨越 await 的调用，只能就地豁免。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh().catch((err) => console.error('获取代理状态失败：', err));
  }, [refresh]);

  return { status, refresh };
}
