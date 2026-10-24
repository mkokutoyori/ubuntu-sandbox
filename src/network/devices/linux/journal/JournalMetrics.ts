import { type JournalMetrics } from './JournaldServer';

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const PAGE = 4096;
const JOURNAL_FILE_SIZE_MIN = 512 * KIB;
const COMPACT_SIZE_MAX = 0xffffffff;
const MAX_USE_LOWER = 1 * MIB;
const MAX_USE_UPPER = 4 * GIB;
const MIN_USE_LOW = 1 * MIB;
const MIN_USE_HIGH = 16 * MIB;
const MAX_SIZE_UPPER = 128 * MIB;
const KEEP_FREE_UPPER = 4 * GIB;
const DEFAULT_KEEP_FREE = 1 * MIB;
const DEFAULT_MAX_FILES = 100;

export interface ResolvedMetrics {
  minUse: number;
  maxUse: number;
  minSize: number;
  maxSize: number;
  keepFree: number;
  maxFiles: number;
}

const pageAlign = (value: number): number => Math.ceil(value / PAGE) * PAGE;
const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

export function resolveJournalMetrics(raw: JournalMetrics, fileSystemBytes: number): ResolvedMetrics {
  let maxUse: number;
  if (raw.maxUse === null) maxUse = fileSystemBytes > 0 ? clamp(pageAlign(Math.floor(fileSystemBytes / 10)), MAX_USE_LOWER, MAX_USE_UPPER) : MAX_USE_LOWER;
  else {
    maxUse = pageAlign(raw.maxUse);
    if (maxUse !== 0 && maxUse < JOURNAL_FILE_SIZE_MIN * 2) maxUse = JOURNAL_FILE_SIZE_MIN * 2;
  }
  let minUse = fileSystemBytes > 0 ? clamp(pageAlign(Math.floor(fileSystemBytes / 50)), MIN_USE_LOW, MIN_USE_HIGH) : MIN_USE_LOW;
  if (minUse > maxUse) minUse = maxUse;
  let maxSize = raw.maxSize === null ? Math.min(pageAlign(Math.floor(maxUse / 8)), MAX_SIZE_UPPER) : pageAlign(raw.maxSize);
  if (maxSize > COMPACT_SIZE_MAX) maxSize = COMPACT_SIZE_MAX;
  if (maxSize !== 0) {
    if (maxSize < JOURNAL_FILE_SIZE_MIN) maxSize = JOURNAL_FILE_SIZE_MIN;
    if (maxUse !== 0 && maxSize * 2 > maxUse) maxUse = maxSize * 2;
  }
  const minSize = clamp(JOURNAL_FILE_SIZE_MIN, JOURNAL_FILE_SIZE_MIN, maxSize || Number.MAX_SAFE_INTEGER);
  const keepFree = raw.keepFree === null ? (fileSystemBytes > 0 ? Math.min(pageAlign(Math.floor(fileSystemBytes / 20)), KEEP_FREE_UPPER) : DEFAULT_KEEP_FREE) : raw.keepFree;
  return { minUse, maxUse, minSize, maxSize, keepFree, maxFiles: raw.maxFiles ?? DEFAULT_MAX_FILES };
}
