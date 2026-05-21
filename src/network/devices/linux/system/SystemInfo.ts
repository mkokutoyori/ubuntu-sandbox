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

export function cmdDate(args: string[]): string {
  const now = new Date();
  const fmt = args.find(a => a.startsWith('+'));
  if (fmt) {
    return fmt.slice(1)
      .replace(/%Y/g, String(now.getUTCFullYear()))
      .replace(/%m/g, two(now.getUTCMonth() + 1))
      .replace(/%d/g, two(now.getUTCDate()))
      .replace(/%H/g, two(now.getUTCHours()))
      .replace(/%M/g, two(now.getUTCMinutes()))
      .replace(/%S/g, two(now.getUTCSeconds()))
      .replace(/%s/g, String(Math.floor(now.getTime() / 1000)))
      .replace(/%F/g, `${now.getUTCFullYear()}-${two(now.getUTCMonth() + 1)}-${two(now.getUTCDate())}`)
      .replace(/%T/g, hhmmss(now));
  }
  // `date` and `date -u` are identical here: the sandbox TZ is UTC.
  return fullDate(now);
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
