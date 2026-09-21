import type { TestResult } from './types';

// 把「连接测试」与「拉取模型列表」的原始结果翻译成用户能照着做的话。
// 文案与旧 app.js 保持一致，迁移不改措辞。

export interface DescribedTestResult {
  ok: boolean | null;
  text: string;
  detail?: string;
  detailTitle?: string;
}

export function describeTestResult(result: TestResult | undefined): DescribedTestResult | null {
  if (!result) return null;
  if (result.pending) return { ok: null, text: '测试中…' };

  if (result.ok) {
    // 试了多个候选才通时，说明是哪个模型通的 —— 否则用户会以为测的不是自己要的那个
    const triedCount = result.tried?.length ?? 0;
    const used = triedCount > 1 && result.probedModel ? `，用 ${result.probedModel}` : '';
    return { ok: true, text: `✓ 连通正常（${result.durationMs}ms${used}）` };
  }

  const reasons: Record<string, string> = {
    auth_failed: '认证失败 —— 请检查 API key',
    model_not_found: '端点与凭证可用，但模型名不被接受',
    // 403 的 permission_error 与 401 是两回事：key 是好的，是模型本身用不了
    model_unavailable: 'key 有效，但该模型在你所在地区或账号下不可用',
    network_error: `无法连接 —— ${result.message || '网络错误'}`,
    invalid_url: 'baseUrl 不是合法 URL',
    upstream_error: `上游返回 ${result.status}`,
  };

  // 把上游的原始报错一并带出来。它通常直接点明原因，撇开它只剩一句「模型名不被接受」。
  const verboseKinds = ['model_not_found', 'model_unavailable', 'upstream_error'];
  const verbose = verboseKinds.includes(result.kind ?? '') ? result.message || '' : '';

  // 逐个候选探测过之后，把每条的结论也带上 —— 配了三条映射时，
  // 只看一句总结无法知道是哪几条不通、分别为什么。
  const perModel = (result.failures ?? [])
    .map((f) => `${f.model}：${f.status ? `HTTP ${f.status} ` : ''}${f.message || f.kind}`)
    .join('；');
  const showPerModel = (result.failures?.length ?? 0) > 1 ? perModel : '';

  const detail = [verbose, showPerModel].filter(Boolean).join(' ｜ ');

  return {
    ok: false,
    text: `✗ ${reasons[result.kind ?? ''] || result.message || '未知错误'}`,
    detail: detail.slice(0, 300),
    detailTitle: detail,
  };
}

export function describeFetchFailure(result: { kind?: string; message?: string }): string {
  const reasons: Record<string, string> = {
    // unsupported 是「这个供应商没有该接口」，不是错误 —— 文案只陈述事实
    unsupported: '该供应商没有 /v1/models 接口',
    auth_failed: '认证失败 —— 请检查 API key',
    network_error: `无法连接 —— ${result.message || '网络错误'}`,
    invalid_url: 'Base URL 不是合法 URL',
    empty: '接口有响应但没有返回任何模型',
  };
  return reasons[result.kind ?? ''] || result.message || '拉取失败';
}

export function formatModelMap(modelMap: Record<string, string> | undefined): string {
  if (!modelMap) return '';
  return Object.entries(modelMap)
    .map(([from, to]) => `${from}=${to}`)
    .join('\n');
}
