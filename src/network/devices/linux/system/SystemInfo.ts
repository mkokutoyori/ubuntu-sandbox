/**
 * SystemInfo — `uname`, `date`, `uptime`, `tty`, `runlevel`,
 * `hostnamectl` and the shared uptime/load formatter.
 *
 * The debug transcript showed `date -u` identical to `date` in a
 * JS `Date.toString()` shape, `uptime` printing an AM/PM clock with
 * "0 min" while `w` claimed "up 1 day" (inconsistent), and `tty` /
 * `runlevel` / `hostnamectl` missing. These helpers centralise the
 * formatting so `uptime` and `w` cannot drift apart again.
 */

import type { HostLifecycle } from '../../host/lifecycle';
import type { KernelInfo } from '../../host/identity';

const LOAD_AVERAGE = '0.00, 0.01, 0.05';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function two(n: number): string {
  return String(n).padStart(2, '0');
}

function hhmmss(d: Date): string {
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}

/** `Tue May 19 16:32:55 UTC 2026` — the real coreutils `date` shape. */
function fullDate(d: Date): string {
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${two(d.getUTCDate())} ` +
    `${hhmmss(d)} UTC ${d.getUTCFullYear()}`;
}

/** Pretty uptime: `up 17 minutes` / `up 2 hours, 5 minutes`. */
function prettyUptime(totalMin: number): string {
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days > 1 ? 's' : ''}`);
  if (hours) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
  if (mins || parts.length === 0) parts.push(`${mins} minute${mins !== 1 ? 's' : ''}`);
  return `up ${parts.join(', ')}`;
}

/**
 * Format the `up …` clause of the uptime header: `5 min`, `2:05`,
 * `1 day,  3:42` — the procps shape, derived from a live uptime.
 */
function uptimeClause(uptimeSeconds: number): string {
  const days = Math.floor(uptimeSeconds / 86_400);
  const hours = Math.floor((uptimeSeconds % 86_400) / 3600);
  const mins = Math.floor((uptimeSeconds % 3600) / 60);
  const hm = hours > 0 ? `${hours}:${two(mins)}` : `${mins} min`;
  if (days > 0) return `${days} day${days > 1 ? 's' : ''}, ${hm}`;
  return hm;
}

/**
 * The shared `uptime`/`w` header line, e.g.
 * ` 16:32:55 up 5 min,  1 user,  load average: 0.00, 0.01, 0.05`.
 * `uptimeSeconds` comes from the host's {@link HostLifecycle}.
 */
export function uptimeHeader(users = 1, uptimeSeconds = 0): string {
  const now = new Date();
  return ` ${hhmmss(now)} up ${uptimeClause(uptimeSeconds)},  ${users} user${users !== 1 ? 's' : ''}, ` +
    ` load average: ${LOAD_AVERAGE}`;
}

/**
 * `uptime` — rendered live from the host's {@link HostLifecycle} so it tracks
 * real boot time and resets on power-cycle / reboot.
 */
export function cmdUptime(args: string[], lifecycle: HostLifecycle): string {
  const seconds = lifecycle.uptimeSeconds();
  const valid = new Set(['-p', '--pretty', '-s', '--since', '-h', '--help', '-V', '--version']);
  for (const a of args) {
    if (a.startsWith('-') && !valid.has(a)) return `uptime: invalid option -- '${a.replace(/^-+/, '')}'`;
  }
  if (args.includes('-p') || args.includes('--pretty')) {
    return prettyUptime(Math.floor(seconds / 60));
  }
  if (args.includes('-s') || args.includes('--since')) {
    const boot = lifecycle.bootedAt() ?? new Date();
    return `${boot.getUTCFullYear()}-${two(boot.getUTCMonth() + 1)}-${two(boot.getUTCDate())} ` +
      `${hhmmss(boot)}`;
  }
  return uptimeHeader(1, seconds);
}

/**
 * `uname` — rendered from the host's {@link KernelInfo} so the kernel name,
 * release, build version and architecture stay coherent with `/proc/version`
 * and `/proc/sys/kernel/*`.
 */
export function cmdUname(args: string[], hostname: string, kernel: KernelInfo): string {
  const validShort = new Set(['a', 's', 'n', 'r', 'v', 'm', 'p', 'i', 'o']);
  for (const a of args) {
    if (a === '-' || !a.startsWith('-')) continue;
    if (a.startsWith('--')) {
      const long = a.slice(2);
      if (!['all', 'kernel-name', 'nodename', 'kernel-release', 'kernel-version', 'machine', 'processor', 'hardware-platform', 'operating-system', 'help', 'version'].includes(long)) {
        return `uname: unrecognized option '${a}'`;
      }
      continue;
    }
    for (const ch of a.slice(1)) {
      if (!validShort.has(ch)) return `uname: invalid option -- '${ch}'`;
    }
  }
  const flags = args.filter(a => a.startsWith('-')).join('').replace(/-/g, '');
  const all = flags.includes('a');
  const want = (f: string): boolean => all || flags.includes(f);

  if (args.length === 0 || (flags === '' && args.length > 0)) {
    return kernel.sysname;
  }

  // -a has a fixed canonical ordering: s n r v m p i o
  if (all) {
    return `${kernel.sysname} ${hostname} ${kernel.release} ${kernel.version} ` +
      `${kernel.machine} ${kernel.machine} ${kernel.machine} ${kernel.operatingSystem}`;
  }

  const parts: string[] = [];
  if (want('s')) parts.push(kernel.sysname);
  if (want('n')) parts.push(hostname);
  if (want('r')) parts.push(kernel.release);
  if (want('v')) parts.push(kernel.version);
  if (want('m') || want('p') || want('i')) parts.push(kernel.machine);
  if (want('o')) parts.push(kernel.operatingSystem);
  return parts.length > 0 ? parts.join(' ') : kernel.sysname;
}

const FULL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const FULL_DAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

/** Day of year, 1-366. */
function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const diff = d.getTime() - start;
  return Math.floor(diff / 86_400_000);
}

/**
 * Full strftime — every conversion from GNU date(1)'s SPECIFIERS table
 * that survives a TZ=UTC sandbox. Pre-fix this supported only nine
 * specifiers (`%Y %m %d %H %M %S %s %F %T`), so any script with `%a`,
 * `%b`, `%j`, `%p`, `%I`, `%w`, `%u`, `%U`, `%R`, `%c`, `%D`, etc.
 * came back with the placeholder unreplaced — visibly wrong, but
 * easy to miss when the format string itself was short.
 */
function strftime(fmt: string, d: Date): string {
  const Y = d.getUTCFullYear();
  const M = d.getUTCMonth();
  const D = d.getUTCDate();
  const H = d.getUTCHours();
  const m = d.getUTCMinutes();
  const S = d.getUTCSeconds();
  const dow = d.getUTCDay();
  const I12 = ((H + 11) % 12) + 1;
  const p = H >= 12 ? 'PM' : 'AM';
  // %V is ISO 8601 week; approximate via the Thursday-anchor rule.
  const thursday = new Date(Date.UTC(Y, M, D + 4 - (dow || 7)));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const weekISO = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);

  const map: Record<string, string> = {
    'Y': String(Y),
    'y': two(Y % 100),
    'C': two(Math.floor(Y / 100)),
    'm': two(M + 1),
    'd': two(D),
    'e': String(D).padStart(2, ' '),
    'j': String(dayOfYear(d)).padStart(3, '0'),
    'H': two(H),
    'k': String(H).padStart(2, ' '),
    'I': two(I12),
    'l': String(I12).padStart(2, ' '),
    'M': two(m),
    'S': two(S),
    'p': p,
    'P': p.toLowerCase(),
    'a': DAYS[dow],
    'A': FULL_DAYS[dow],
    'b': MONTHS[M],
    'h': MONTHS[M],
    'B': FULL_MONTHS[M],
    'w': String(dow),
    'u': String(dow === 0 ? 7 : dow),
    'U': two(Math.floor((dayOfYear(d) + 6 - dow) / 7)),
    'V': two(weekISO),
    'N': String(d.getUTCMilliseconds()).padStart(3, '0') + '000000',
    'Z': 'UTC',
    'z': '+0000',
    'F': `${Y}-${two(M + 1)}-${two(D)}`,
    'T': `${two(H)}:${two(m)}:${two(S)}`,
    'R': `${two(H)}:${two(m)}`,
    'r': `${two(I12)}:${two(m)}:${two(S)} ${p}`,
    'D': `${two(M + 1)}/${two(D)}/${two(Y % 100)}`,
    'c': fullDate(d),
    'x': `${two(M + 1)}/${two(D)}/${two(Y % 100)}`,
    'X': `${two(H)}:${two(m)}:${two(S)}`,
    'n': '\n',
    't': '\t',
    's': String(Math.floor(d.getTime() / 1000)),
    '%': '%',
  };
  return fmt.replace(/%([YyCmdejHkIlMSpPaAbhBwuUVNZzFTRrDcxXnts%])/g, (_, c) => map[c] ?? `%${c}`);
}

/**
 * Parse a `-d`/`--date=` argument. Real coreutils accepts a huge
 * grammar; we cover the common shapes used in scripts:
 *   - ISO timestamps: `2026-05-19`, `2026-05-19T10:00:00`, `2026-05-19 10:00:00`
 *   - Unix epoch: `@1716115200`
 *   - Relative: `now`, `today`, `yesterday`, `tomorrow`
 *   - Anything Date.parse() recognises (e.g. `May 19 2026 16:32:55 UTC`)
 * Returns null when the string can't be parsed — the caller mirrors
 * coreutils' "date: invalid date '<x>'" error in that case.
 */
function parseDateSpec(spec: string): Date | null {
  const s = spec.trim();
  if (!s || s === 'now') return new Date();
  if (s === 'today') {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  if (s === 'yesterday') {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  if (s === 'tomorrow') {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  if (s.startsWith('@')) {
    const seconds = parseInt(s.slice(1), 10);
    return isNaN(seconds) ? null : new Date(seconds * 1000);
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}

export function cmdDate(args: string[]): string {
  // Accept -d <spec> / --date=<spec> / --date <spec>.
  let when = new Date();
  let fmtArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-d' || a === '--date') {
      const spec = args[++i];
      const parsed = spec !== undefined ? parseDateSpec(spec) : null;
      if (!parsed) return `date: invalid date '${spec ?? ''}'`;
      when = parsed;
      continue;
    }
    if (a.startsWith('--date=')) {
      const parsed = parseDateSpec(a.slice('--date='.length));
      if (!parsed) return `date: invalid date '${a.slice('--date='.length)}'`;
      when = parsed;
      continue;
    }
    if (a.startsWith('+')) {
      fmtArg = a.slice(1);
      continue;
    }
    // -u / --utc are no-ops here (sandbox TZ is already UTC).
  }
  if (fmtArg !== undefined) return strftime(fmtArg, when);
  return fullDate(when);
}

export function cmdTty(currentTty: string): string {
  return currentTty.startsWith('/dev/') ? currentTty : `/dev/${currentTty}`;
}

/** Default systemd target is graphical (5) for a PC, multi-user (3) for a server. */
export function cmdRunlevel(isServer: boolean): string {
  return isServer ? 'N 3' : 'N 5';
}

/** Canonical /etc/os-release content for the simulated Ubuntu. */
export const OS_RELEASE = [
  'PRETTY_NAME="Ubuntu 22.04.4 LTS"',
  'NAME="Ubuntu"',
  'VERSION_ID="22.04"',
  'VERSION="22.04.4 LTS (Jammy Jellyfish)"',
  'VERSION_CODENAME=jammy',
  'ID=ubuntu',
  'ID_LIKE=debian',
  'HOME_URL="https://www.ubuntu.com/"',
  'SUPPORT_URL="https://help.ubuntu.com/"',
  'BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"',
  'UBUNTU_CODENAME=jammy',
  '',
].join('\n');
