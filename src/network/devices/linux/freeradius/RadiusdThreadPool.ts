import { confBoolean, type ConfPair, type ConfSection } from './FreeradiusConf';

export interface RadiusdThreadPool {
  startServers: number;
  maxServers: number;
  minSpareServers: number;
  maxSpareServers: number;
  cleanupDelay: number;
}

const DEFAULTS: RadiusdThreadPool = { startServers: 5, maxServers: 32, minSpareServers: 3, maxSpareServers: 10, cleanupDelay: 5 };
const MAX_QUEUE_SIZE_RANGE = { min: 2, max: 1024 * 1024 };
const FALLBACK_MAX_SERVERS = 256;

function integerOf(pair: ConfPair): number | { error: string } {
  if (!/^[+-]?\d+$/.test(pair.value)) return { error: `${pair.file}[${pair.line}]: Invalid value "${pair.value}" for integer variable ${pair.name}` };
  const value = Number(pair.value);
  if (value < 0 || value > 0xffffffff) return { error: `${pair.file}[${pair.line}]: Invalid value "${pair.value}" for variable ${pair.name}` };
  return value;
}

export function readRadiusdThreadPool(root: ConfSection): RadiusdThreadPool | { error: string } {
  const pool: RadiusdThreadPool = { ...DEFAULTS };
  const section = root.sections.find((candidate) => candidate.name1 === 'thread' && candidate.name2 === 'pool');
  for (const pair of section?.pairs ?? []) {
    if (pair.name === 'auto_limit_acct') {
      const enabled = confBoolean(pair);
      if (typeof enabled === 'object') return enabled;
      if (enabled) return { error: `${pair.file}[${pair.line}]: The thread pool setting "auto_limit_acct" is not implemented in this simulator (there is no request queue to limit)` };
      continue;
    }
    const value = integerOf(pair);
    if (typeof value === 'object') return value;
    if (pair.name === 'start_servers') pool.startServers = value;
    else if (pair.name === 'max_servers') pool.maxServers = value;
    else if (pair.name === 'min_spare_servers') pool.minSpareServers = value;
    else if (pair.name === 'max_spare_servers') pool.maxSpareServers = value;
    else if (pair.name === 'cleanup_delay') pool.cleanupDelay = value;
    else if (pair.name === 'max_queue_size') {
      if (value < MAX_QUEUE_SIZE_RANGE.min || value > MAX_QUEUE_SIZE_RANGE.max) return { error: `${pair.file}[${pair.line}]: max_queue_size value must be in range ${MAX_QUEUE_SIZE_RANGE.min}-${MAX_QUEUE_SIZE_RANGE.max}` };
    } else if (pair.name === 'max_requests_per_server') {
      if (value !== 0) return { error: `${pair.file}[${pair.line}]: The thread pool setting "max_requests_per_server" is not implemented in this simulator (a worker never retires after a number of requests)` };
    } else return { error: `${pair.file}[${pair.line}]: Unknown thread pool setting "${pair.name}"` };
  }
  pool.minSpareServers = Math.max(1, pool.minSpareServers);
  pool.maxSpareServers = Math.max(pool.minSpareServers, Math.max(1, pool.maxSpareServers));
  if (pool.maxServers === 0) pool.maxServers = FALLBACK_MAX_SERVERS;
  if (pool.startServers > pool.maxServers) return { error: `start_servers (${pool.startServers}) must be <= max_servers (${pool.maxServers})` };
  return pool;
}

export function settledThreadCount(pool: RadiusdThreadPool, elapsedSeconds: number): number {
  const started = Math.min(pool.startServers, pool.maxServers);
  const raised = Math.min(pool.maxServers, Math.max(started, pool.minSpareServers));
  if (raised > pool.maxSpareServers) {
    const reaped = Math.max(0, Math.floor(elapsedSeconds) - pool.cleanupDelay + 1);
    return Math.max(pool.maxSpareServers, raised - reaped);
  }
  return raised;
}
