const POOLS_MAX = 5;
const GROUPS_MAX = 2047;
const PRIORITY_POOL = [0, 0, 0, 1, 2, 3, 3, 4] as const;
const BURST_FLOOR_LOG2 = 20;
const BURST_LOG2_OFFSET = 16;

interface Pool {
  begin: number;
  num: number;
  suppressed: number;
}

interface Group {
  readonly id: string;
  interval: number;
  readonly pools: Pool[];
}

function log2Floor(value: number): number {
  return value < 1 ? 0 : Math.floor(Math.log2(value));
}

export function burstModulate(burst: number, availableBytes: number): number {
  const k = log2Floor(availableBytes);
  if (k <= BURST_FLOOR_LOG2) return burst;
  return Math.floor((burst * (k - BURST_LOG2_OFFSET)) / 4);
}

export class JournalRateLimit {
  private readonly groups = new Map<string, Group>();

  constructor(private readonly monotonicUsec: () => number) {}

  get groupCount(): number {
    return this.groups.size;
  }

  private expired(group: Group, ts: number): boolean {
    return group.pools.every((pool) => pool.begin + group.interval < ts);
  }

  private vacuum(ts: number): void {
    for (;;) {
      const oldest = this.groups.keys().next();
      if (oldest.done === true) return;
      const group = this.groups.get(oldest.value) as Group;
      if (this.groups.size < GROUPS_MAX && !this.expired(group, ts)) return;
      this.groups.delete(oldest.value);
    }
  }

  test(id: string, interval: number, burst: number, priority: number, availableBytes: number): number {
    const ts = this.monotonicUsec();
    let group = this.groups.get(id);
    if (group === undefined) {
      this.vacuum(ts);
      group = { id, interval, pools: Array.from({ length: POOLS_MAX }, () => ({ begin: 0, num: 0, suppressed: 0 })) };
      this.groups.set(id, group);
    } else group.interval = interval;
    if (interval === 0 || burst === 0) return 1;
    const modulated = burstModulate(burst, availableBytes);
    const pool = group.pools[PRIORITY_POOL[priority & 7]];
    if (pool.begin <= 0) {
      pool.suppressed = 0;
      pool.num = 1;
      pool.begin = ts;
      return 1;
    }
    if (pool.begin + interval < ts) {
      const suppressed = pool.suppressed;
      pool.suppressed = 0;
      pool.num = 1;
      pool.begin = ts;
      return 1 + suppressed;
    }
    if (pool.num < modulated) {
      pool.num++;
      return 1;
    }
    pool.suppressed++;
    return 0;
  }
}
