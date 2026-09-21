import { useCallback, useEffect, useState } from 'react';
import { ccnb } from '../ccnb';
import type { Profile, TestResult } from '../types';

export interface ProfilesApi {
  profiles: Profile[];
  activeId: string | null;
  testResults: Map<string, TestResult>;
  refresh(): Promise<void>;
  activate(id: string): Promise<void>;
  test(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  add(payload: {
    name: string;
    baseUrl: string;
    apiKey?: string;
    modelMap?: Record<string, string>;
  }): Promise<void>;
  update(
    id: string,
    patch: Partial<Pick<Profile, 'name' | 'baseUrl' | 'apiKey' | 'modelMap'>>
  ): Promise<void>;
}

export function useProfiles(): ProfilesApi {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Map<string, TestResult>>(new Map());

  const refresh = useCallback(async () => {
    const state = await ccnb().listProfiles();
    setProfiles(state.profiles);
    setActiveId(state.activeId);
  }, []);

  useEffect(() => {
    refresh().catch((err) => console.error('加载供应商失败：', err));
  }, [refresh]);

  const activate = useCallback(
    async (id: string) => {
      if (id === activeId) return;
      await ccnb().activateProfile(id);
      await refresh();
    },
    [activeId, refresh]
  );

  const test = useCallback(async (id: string) => {
    setTestResults((prev) => new Map(prev).set(id, { pending: true }));
    try {
      const result = await ccnb().testProfile(id);
      setTestResults((prev) => new Map(prev).set(id, result));
    } catch (err) {
      setTestResults((prev) =>
        new Map(prev).set(id, { ok: false, kind: 'error', message: (err as Error).message })
      );
    }
  }, []);

  const remove = useCallback(
    async (id: string) => {
      await ccnb().removeProfile(id);
      setTestResults((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      await refresh();
    },
    [refresh]
  );

  const add = useCallback(
    async (payload: Parameters<ProfilesApi['add']>[0]) => {
      await ccnb().addProfile(payload);
      await refresh();
    },
    [refresh]
  );

  const update = useCallback(async (id: string, patch: Parameters<ProfilesApi['update']>[1]) => {
    const updated = await ccnb().updateProfile(id, patch);
    setProfiles((prev) => prev.map((p) => (p.id === id ? updated : p)));
  }, []);

  return { profiles, activeId, testResults, refresh, activate, test, remove, add, update };
}
