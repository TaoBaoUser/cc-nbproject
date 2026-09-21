'use strict';

/**
 * 用量记录与聚合。
 *
 * 存储格式的选择：JSONL（每行一个 JSON 对象），而不是一个 JSON 数组。
 *
 * 原因是写入复杂度：JSONL 的追加是 O(1)；若用数组，每记录一条请求都要
 * 读出整个文件、push、再整体写回，开销随历史记录线性增长。用量数据是
 * 「只增不改」的典型场景，JSONL 天然合适，代价是读取时需要自己逐行解析。
 *
 * 参见设计文档第 7 节。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_DIR = path.join(os.homedir(), '.cc-nbproject');
const FILE_MODE = 0o600;

/**
 * 读取时最多回看这么多行。
 * 用量文件会无限增长，若不加限制，读取会随使用时间越来越慢。
 * 超过这个量级时应当改为按时间轮转 —— 记为 v0.2 的待办。
 */
const MAX_READ_LINES = 50000;

function createUsageStore({ dir = DEFAULT_DIR } = {}) {
  const usageFile = path.join(dir, 'usage.jsonl');

  function ensureDir() {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  function append(record) {
    ensureDir();
    // 追加写是原子性足够的：单次 appendFileSync 在大多数文件系统上
    // 不会被其他写入者从中间截断（O_APPEND 语义）。
    fs.appendFileSync(usageFile, JSON.stringify(record) + '\n', { mode: FILE_MODE });
  }

  function readAll() {
    if (!fs.existsSync(usageFile)) return [];
    const lines = fs.readFileSync(usageFile, 'utf8').split('\n');

    // 只保留最后 MAX_READ_LINES 行
    const start = Math.max(0, lines.length - 1 - MAX_READ_LINES);
    const records = [];
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // 单行损坏（例如上次写入时断电）不应该让整个统计功能失效
      }
    }
    return records;
  }

  /**
   * 按供应商聚合。
   *
   * 为什么缺失的 token 数记 0 而不是跳过：
   * 有些请求（例如流式响应被用户中途打断）拿不到完整的 usage，
   * 但它们确实发生过、确实消耗了额度。记 0 至少让请求数是对的，
   * 让用户知道"有请求发生了但费用未知"更接近事实。
   */
  function summarize({ sinceMs = null } = {}) {
    const cutoff = sinceMs ? Date.now() - sinceMs : null;
    const byProfile = new Map();
    const total = { requests: 0, inputTokens: 0, outputTokens: 0 };

    for (const record of readAll()) {
      if (cutoff !== null) {
        const ts = Date.parse(record.ts);
        if (!Number.isNaN(ts) && ts < cutoff) continue;
      }

      const key = record.profileId || 'unknown';
      if (!byProfile.has(key)) {
        byProfile.set(key, {
          profileId: key,
          profileName: record.profileName || '（已删除）',
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          errors: 0,
        });
      }

      const bucket = byProfile.get(key);
      bucket.requests += 1;
      // 用 || 0 兜底：字段可能为 null（未解析到用量）
      bucket.inputTokens += record.inputTokens || 0;
      bucket.outputTokens += record.outputTokens || 0;
      if (record.status >= 400) bucket.errors += 1;

      total.requests += 1;
      total.inputTokens += record.inputTokens || 0;
      total.outputTokens += record.outputTokens || 0;
    }

    return { total, byProfile: [...byProfile.values()] };
  }

  function recent(limit = 200) {
    const records = readAll();
    return records.slice(-limit).reverse();
  }

  return { append, readAll, summarize, recent, usageFile };
}

module.exports = { createUsageStore, DEFAULT_DIR };
