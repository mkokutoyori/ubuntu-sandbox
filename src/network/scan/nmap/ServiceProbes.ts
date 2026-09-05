export interface ServiceProbe {
  name: string;
  rarity: number;
  payload: string;
  ports: ReadonlySet<number>;
}

export interface ServiceMatch {
  service: string;
  pattern: RegExp;
  product?: string;
  version?: string;
  info?: string;
}

export const DEFAULT_VERSION_INTENSITY = 7;
export const LIGHT_VERSION_INTENSITY = 2;
export const ALL_VERSION_INTENSITY = 9;

function ports(spec: string): ReadonlySet<number> {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      for (let p = Number(range[1]); p <= Number(range[2]); p++) out.add(p);
    } else out.add(Number(part));
  }
  return out;
}

export const NULL_PROBE: ServiceProbe = {
  name: 'NULL', rarity: 5, payload: '', ports: new Set(),
};

const GET_REQUEST: ServiceProbe = {
  name: 'GetRequest',
  rarity: 1,
  payload: 'GET / HTTP/1.0\r\n\r\n',
  ports: ports('1,70,79,80-85,88,113,139,143,280,497,505,514,515,540,554,591,620,'
    + '631,783,888,898,900,901,1026,1080,1042,1214,1220,1234,1314,1344,1503,1610,'
    + '1611,1830,1900,2001,2002,2030,2064,2160,2306,2396,2525,2715,2869,3000,3002,'
    + '3052,3128,3280,3372,3531,3689,3872,4000,4444,4567,4660,4711,5000,5001,5427,'
    + '5060,5222,5269,5280,5432,5800-5803,5900,5985,6103,6346,6544,6600,6699,6969,'
    + '7002,7007,7070,7100,7402,7776,8000-8010,8080-8085,8088,8118,8181,8530,'
    + '8880-8888,9000,9001,9030,9050,9080,9090,9999,10000,10001,10005,11371,13013,'
    + '13666,13722,14534,15000,17988,18264,31337,40193,50000,55555'),
};

export const TCP_PROBES: ReadonlyArray<ServiceProbe> = [GET_REQUEST];

const HTTP_MATCHES: ReadonlyArray<ServiceMatch> = [
  {
    service: 'http',
    pattern: /^HTTP\/1\.[01] \d\d\d[\s\S]*?\r\nServer: nginx\/([\d.]+) \(([^)\r\n]+)\)\r\n/,
    product: 'nginx', version: '$1', info: '$2',
  },
  {
    service: 'http',
    pattern: /^HTTP\/1\.[01] \d\d\d[\s\S]*?\r\nServer: nginx\/([\d.]+)\r\n/,
    product: 'nginx', version: '$1',
  },
  {
    service: 'http',
    pattern: /^HTTP\/1\.[01] \d\d\d[\s\S]*?\r\nServer: nginx\r\n/,
    product: 'nginx',
  },
  {
    service: 'http',
    pattern: /^HTTP\/1\.[01] \d\d\d (?:[^\r\n]*\r\n(?!\r\n))*?Server: Apache[/ ](\d[-.\w]+) ([^\r\n]+)/,
    product: 'Apache httpd', version: '$1', info: '$2',
  },
  {
    service: 'http',
    pattern: /^HTTP\/1\.[01] \d\d\d (?:[^\r\n]*\r\n(?!\r\n))*?Server: Apache[/ ](\d[.\w-]+)\s*\r?\n/,
    product: 'Apache httpd', version: '$1',
  },
  {
    service: 'http',
    pattern: /^HTTP\/1\.[01][\s\S]*?\r\nServer: Microsoft-IIS\/([-.\w]+)\r\n/,
    product: 'Microsoft IIS httpd', version: '$1',
  },
];

export function probesForPort(port: number, intensity: number): ServiceProbe[] {
  const matching = TCP_PROBES.filter((p) => p.ports.has(port));
  const rest = TCP_PROBES.filter((p) => !p.ports.has(port) && p.rarity <= intensity);
  return [...matching, ...rest];
}

function expand(template: string | undefined, m: RegExpExecArray): string | undefined {
  if (template === undefined) return undefined;
  return template.replace(/\$(\d)/g, (_, d: string) => m[Number(d)] ?? '');
}

export function matchProbeResponse(
  response: string,
): { service: string; version?: string } | null {
  for (const rule of HTTP_MATCHES) {
    const m = rule.pattern.exec(response);
    if (!m) continue;
    const parts = [
      rule.product, expand(rule.version, m),
      rule.info === undefined ? undefined : `(${expand(rule.info, m)})`,
    ].filter((s): s is string => s !== undefined && s !== '');
    return {
      service: rule.service,
      version: parts.length > 0 ? parts.join(' ') : undefined,
    };
  }
  return null;
}
