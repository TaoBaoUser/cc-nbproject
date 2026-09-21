import { useEffect, useState } from 'react';
import { ccnb } from '../ccnb';
import type { LogEvent } from '../types';

const MAX_LOG_ROWS = 500;

export function useLogs() {
  const [entries, setEntries] = useState<LogEvent[]>([]);

  useEffect(() => {
    const unsubscribe = ccnb().onLogEvent((entry) => {
      setEntries((prev) => {
        const next = [...prev, entry];
        return next.length > MAX_LOG_ROWS ? next.slice(next.length - MAX_LOG_ROWS) : next;
      });
    });
    return unsubscribe;
  }, []);

  return { entries, clear: () => setEntries([]) };
}
