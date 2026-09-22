import type {
  Profile,
  ProfilesState,
  ProxyStatus,
  TestResult,
  ModelListResult,
  ClaudeModelNames,
  UsageSummary,
  LogEvent,
  PreviewResult,
  ClaudeStatus,
  TakeoverActionResult,
} from './types';

// preload 通过 contextBridge 暴露的白名单（见 src/preload/index.js）。
// 这里只声明类型，运行时对象由 preload 注入到 window.ccnb。
export interface CcnbApi {
  listProfiles(): Promise<ProfilesState>;
  addProfile(payload: {
    name: string;
    baseUrl: string;
    apiKey?: string;
    modelMap?: Record<string, string>;
  }): Promise<Profile>;
  updateProfile(
    id: string,
    patch: Partial<Pick<Profile, 'name' | 'baseUrl' | 'apiKey' | 'modelMap'>>
  ): Promise<Profile>;
  removeProfile(id: string): Promise<boolean>;
  activateProfile(id: string): Promise<Profile>;
  testProfile(id: string): Promise<TestResult>;
  getUsageSummary(range: { sinceMs?: number }): Promise<UsageSummary>;
  getRecentUsage(limit?: number): Promise<unknown[]>;
  getProxyStatus(): Promise<ProxyStatus>;
  getClaudeStatus(): Promise<ClaudeStatus>;
  previewClaudeSettings(): Promise<PreviewResult>;
  takeoverClaude(): Promise<TakeoverActionResult>;
  disconnectClaude(): Promise<TakeoverActionResult>;
  listModels(payload: {
    baseUrl: string;
    apiKey?: string;
    force?: boolean;
  }): Promise<ModelListResult>;
  getClaudeModelNames(): Promise<ClaudeModelNames>;
  onLogEvent(callback: (event: LogEvent) => void): () => void;
}

declare global {
  interface Window {
    ccnb: CcnbApi;
  }
}

export function ccnb(): CcnbApi {
  return window.ccnb;
}
