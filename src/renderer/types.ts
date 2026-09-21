// 与主进程 / preload 交换的数据结构（见 src/preload/index.js 与 src/main/*）。

export interface Profile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelMap: Record<string, string>;
  createdAt: string;
}

export interface ProfilesState {
  profiles: Profile[];
  activeId: string | null;
}

export interface ProxyStatus {
  running: boolean;
  port: number | null;
  baseUrl: string | null;
  activeProfile: Profile | null;
}

// 连接测试结果（src/main/proxy.js 的 testUpstream）
export interface TestResult {
  ok?: boolean;
  pending?: boolean;
  kind?: string;
  status?: number;
  durationMs?: number;
  message?: string;
  // 配了模型映射时会逐个候选探测（第一个可用的模型未必排在第一条），
  // 这两个字段记录探测过程，供界面说明「最后是哪个模型测通的」。
  probedModel?: string;
  tried?: string[];
  failures?: { model: string; kind: string; status?: number; message?: string }[];
}

export interface ModelListItem {
  id: string;
  name: string;
}

export interface ModelListOk {
  ok: true;
  models: ModelListItem[];
  durationMs?: number;
  cached?: boolean;
}

export interface ModelListFail {
  ok: false;
  kind: string;
  status?: number;
  message?: string;
}

export type ModelListResult = ModelListOk | ModelListFail;

export interface ClaudeModelNamesOk {
  ok: true;
  entries: { name: string; keys: string[] }[];
  main?: string;
  fast?: string;
  settingsPath: string;
}

export interface ClaudeModelNamesFail {
  ok: false;
  settingsPath: string;
  reason?: string;
}

export type ClaudeModelNames = ClaudeModelNamesOk | ClaudeModelNamesFail;

export interface UsageSummary {
  total: { requests: number; inputTokens: number; outputTokens: number };
  byProfile: {
    profileId: string;
    profileName: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    errors: number;
  }[];
}

export interface PreviewChange {
  key: string;
  from?: string;
  to: string;
}

export interface PreviewOk {
  ok: true;
  settingsPath: string;
  exists: boolean;
  changes: PreviewChange[];
  before?: Record<string, string>;
  after?: Record<string, string>;
  // 是否会在写入前创建备份。**只给布尔语义、不给路径**：
  // 备份文件名带时间戳，预览阶段算出来的名字与真正生成的对不上，
  // 用户照提示去找必然扑空。真路径由接管结果返回。
  willBackup: boolean;
  managedConflict?: { path: string; baseUrl: string } | null;
}

/** 代理未就绪等情况下，主进程拒绝出预览，并给出原因。 */
export interface PreviewFail {
  ok: false;
  reason: string;
}

export type PreviewResult = PreviewOk | PreviewFail;

/** 一次接管/还原的时间与结果记录，失败时 reason 说明原因。 */
export interface TakeoverAttempt {
  ok: boolean;
  at: string;
  reason: string | null;
}

/**
 * 界面用的接管状态。
 *
 * `state` 就是 PRD R9 的三态：
 *   off     未接管
 *   active  已接管，且文件里确实是我们写进去的值
 *   pending 已授权，但本次没写进去（代理没起来 / 写入失败）
 *
 * 判定以文件内容（`fileMatches`）为准，`enabled` 只表示「用户此前授权过」。
 */
export interface ClaudeStatus {
  state: 'off' | 'active' | 'pending';
  enabled: boolean;
  fileMatches: boolean;
  settingsPath: string;
  applied: Record<string, string> | null;
  previous: Record<string, string | null> | null;
  backupPath: string | null;
  lastApply: TakeoverAttempt | null;
  lastRestore: TakeoverAttempt | null;
  proxyBaseUrl: string | null;
}

/** 接管 / 断开的结果。失败时只有 ok:false 与 reason 是必有的。 */
export interface TakeoverActionResult {
  ok: boolean;
  reason?: string | null;
  skipped?: boolean;
  settingsPath?: string;
  backupPath?: string | null;
  createdBackup?: boolean;
  residualDetected?: boolean;
}

// 主进程推送的日志事件（broadcast('log:event', ...)）
export interface LogEvent {
  kind: 'usage' | 'request' | 'switch';
  ts?: number;
  profileId?: string;
  profileName?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  status?: number;
  durationMs?: number;
  phase?: 'start' | 'end' | 'error' | 'rewrite';
  method?: string;
  path?: string;
  from?: string;
  to?: string;
  error?: string;
  bytesSent?: number;
}
