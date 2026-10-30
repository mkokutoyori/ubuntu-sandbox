const SCALE = 1_000_000;
const DEFAULT_BURST = 5;
const GC_INTERVAL = 1000;
const MAX_BURST = 1_000_000;
const DEFAULT_TABLE_LIMIT = 65536;
const UNITS: ReadonlyArray<readonly [string, number]> = [['day', 86400], ['hour', 3600], ['min', 60], ['sec', 1]];

export interface HashlimitConfig {
  readonly above: boolean;
  readonly avg: number;
  readonly burst: number;
  readonly mult: number;
  readonly sourceIp: boolean;
  readonly sourcePort: boolean;
  readonly destinationIp: boolean;
  readonly destinationPort: boolean;
  readonly size: number;
  readonly max: number;
  readonly gcInterval: number;
  readonly expire: number;
  readonly srcMask: number | null;
  readonly dstMask: number | null;
  readonly name: string;
}

function parseRate(text: string): { avg: number; mult: number } | null {
  let mult = 1;
  const slash = text.indexOf('/');
  if (slash >= 0) {
    const unit = text.slice(slash + 1).toLowerCase();
    if (unit === '') return null;
    const names: ReadonlyArray<readonly [string, number]> = [['second', 1], ['minute', 60], ['hour', 3600], ['day', 86400]];
    const found = names.find(([name]) => name.startsWith(unit));
    if (found === undefined) return null;
    mult = found[1];
  }
  const rate = parseInt(text, 10);
  if (!(rate > 0)) return null;
  return { avg: Math.floor((SCALE * mult) / rate), mult };
}

export function parseHashlimit(
  options: ReadonlyMap<string, string>, negated: ReadonlySet<string>,
): HashlimitConfig | string {
  const upto = options.has('--hashlimit-upto');
  const above = options.has('--hashlimit-above');
  if (!upto && !above) return 'You have to specify --hashlimit';
  const optionName = upto ? '--hashlimit-upto' : '--hashlimit-above';
  const rateText = options.get(optionName) ?? '';
  if (rateText.includes('b/s')) return 'hashlimit: byte rates (b/s) are not supported by this simulator';
  const rate = parseRate(rateText);
  if (rate === null) return `hashlimit: Bad value for "${optionName}" option: "${rateText}"`;
  if (rate.avg === 0) return `Rate too fast "${rateText}"\n`;

  const burstText = options.get('--hashlimit-burst');
  const burst = burstText === undefined ? DEFAULT_BURST : Number(burstText);
  if (!Number.isInteger(burst) || burst < 1 || burst > MAX_BURST) {
    return `hashlimit: bad value for option "--hashlimit-burst", or out of range (1-${MAX_BURST}).`;
  }

  let mode = { sip: false, spt: false, dip: false, dpt: false };
  for (const token of (options.get('--hashlimit-mode') ?? '').split(/[,|]/).filter((part) => part !== '')) {
    if (token === 'srcip') mode = { ...mode, sip: true };
    else if (token === 'srcport') mode = { ...mode, spt: true };
    else if (token === 'dstip') mode = { ...mode, dip: true };
    else if (token === 'dstport') mode = { ...mode, dpt: true };
    else return `hashlimit: Bad value for "--hashlimit-mode" option: "${options.get('--hashlimit-mode')}"`;
  }

  const number = (name: string, fallback: number): number => (options.has(name) ? Number(options.get(name)) : fallback);
  const invertedUpto = upto && negated.has('--hashlimit-upto');
  const invertedAbove = above && !negated.has('--hashlimit-above');
  return {
    above: invertedUpto || invertedAbove,
    avg: rate.avg, burst, mult: rate.mult,
    sourceIp: mode.sip, sourcePort: mode.spt, destinationIp: mode.dip, destinationPort: mode.dpt,
    size: number('--hashlimit-htable-size', 0), max: number('--hashlimit-htable-max', 0),
    gcInterval: number('--hashlimit-htable-gcinterval', GC_INTERVAL),
    expire: number('--hashlimit-htable-expire', rate.mult * 1000),
    srcMask: options.has('--hashlimit-srcmask') ? Number(options.get('--hashlimit-srcmask')) : null,
    dstMask: options.has('--hashlimit-dstmask') ? Number(options.get('--hashlimit-dstmask')) : null,
    name: options.get('--hashlimit-name') ?? '',
  };
}

function printRate(period: number): { text: string; quantumMs: number } {
  const multipliers = UNITS.map(([name, seconds]) => [name, seconds * SCALE] as const);
  let i = 1;
  for (; i < multipliers.length; i++) {
    const mult = multipliers[i][1];
    if (period > mult || Math.floor(mult / period) < mult % period) break;
  }
  const [name, mult] = multipliers[i - 1];
  return { text: ` ${Math.floor(mult / period)}/${name}`, quantumMs: Math.floor(mult / SCALE) * 1000 };
}

export function hashlimitListing(config: HashlimitConfig, defaultMask: number): string {
  const { text, quantumMs } = printRate(config.avg);
  const parts = [`limit: ${config.above ? 'above' : 'up to'}${text} burst ${config.burst}`];
  const names = [config.sourceIp && 'srcip', config.sourcePort && 'srcport', config.destinationIp && 'dstip', config.destinationPort && 'dstport']
    .filter((name): name is string => typeof name === 'string');
  if (names.length > 0) parts.push(`mode ${names.join('-')}`);
  if (config.size !== 0) parts.push(`htable-size ${config.size}`);
  if (config.max !== 0) parts.push(`htable-max ${config.max}`);
  if (config.gcInterval !== GC_INTERVAL) parts.push(`htable-gcinterval ${config.gcInterval}`);
  if (config.expire !== quantumMs) parts.push(`htable-expire ${config.expire}`);
  if ((config.srcMask ?? defaultMask) !== defaultMask) parts.push(`srcmask ${config.srcMask}`);
  if ((config.dstMask ?? defaultMask) !== defaultMask) parts.push(`dstmask ${config.dstMask}`);
  return parts.join(' ');
}

interface Bucket {
  credit: number;
  last: number;
}

export interface HashlimitFacts {
  readonly srcIP: string;
  readonly dstIP: string;
  readonly srcPort: number;
  readonly dstPort: number;
}

export type HashlimitOutcome = 'under' | 'over' | 'hotdrop';

export class HashlimitTables {
  private readonly tables = new Map<string, Map<string, Bucket>>();

  clear(): void {
    this.tables.clear();
  }

  evaluate(
    config: HashlimitConfig, facts: HashlimitFacts, nowMs: number, mask: (ip: string, bits: number | null) => string,
  ): HashlimitOutcome {
    let table = this.tables.get(config.name);
    if (table === undefined) {
      table = new Map();
      this.tables.set(config.name, table);
    }
    const key = [
      config.sourceIp ? mask(facts.srcIP, config.srcMask) : '',
      config.sourcePort ? facts.srcPort : '',
      config.destinationIp ? mask(facts.dstIP, config.dstMask) : '',
      config.destinationPort ? facts.dstPort : '',
    ].join('|');
    const capacity = config.avg * config.burst;
    const nowMicros = nowMs * 1000;
    let bucket = table.get(key);
    if (bucket !== undefined && nowMs - bucket.last / 1000 > config.expire) {
      table.delete(key);
      bucket = undefined;
    }
    if (bucket === undefined) {
      if (table.size >= (config.max > 0 ? config.max : DEFAULT_TABLE_LIMIT)) return 'hotdrop';
      bucket = { credit: capacity, last: nowMicros };
      table.set(key, bucket);
    } else {
      bucket.credit = Math.min(capacity, bucket.credit + (nowMicros - bucket.last));
      bucket.last = nowMicros;
    }
    if (bucket.credit >= config.avg) {
      bucket.credit -= config.avg;
      return 'under';
    }
    return 'over';
  }
}
