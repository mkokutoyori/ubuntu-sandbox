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

const KERNEL_RELEASE = '5.15.0-130-generic';
const KERNEL_VERSION = '#140-Ubuntu SMP Wed Apr 16 12:00:00 UTC 2025';
const MACHINE = 'x86_64';
const OS_NAME = 'GNU/Linux';

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

export function cmdUname(args: string[], hostname = 'localhost'): string {
  const flags = args.filter(a => a.startsWith('-')).join('').replace(/-/g, '');
  const all = flags.includes('a');
  const want = (f: string): boolean => all || flags.includes(f);

  if (args.length === 0 || (flags === '' && args.length > 0)) {
    return 'Linux';
  }

  // -a has a fixed canonical ordering: s n r v m p i o
  if (all) {
    return `Linux ${hostname} ${KERNEL_RELEASE} ${KERNEL_VERSION} ${MACHINE} ${MACHINE} ${MACHINE} ${OS_NAME}`;
  }

  const parts: string[] = [];
  if (want('s')) parts.push('Linux');
  if (want('n')) parts.push(hostname);
  if (want('r')) parts.push(KERNEL_RELEASE);
  if (want('v')) parts.push(KERNEL_VERSION);
  if (want('m') || want('p') || want('i')) parts.push(MACHINE);
  if (want('o')) parts.push(OS_NAME);
  return parts.length > 0 ? parts.join(' ') : 'Linux';
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

export function cmdHostnamectl(hostname: string): string {
  return [
    `   Static hostname: ${hostname}`,
    `         Icon name: computer-vm`,
    `           Chassis: vm`,
    `        Machine ID: 0a1b2c3d4e5f60718293a4b5c6d7e8f9`,
    `           Boot ID: f9e8d7c6b5a4039281706f5e4d3c2b1a`,
    `    Virtualization: kvm`,
    `  Operating System: Ubuntu 22.04.4 LTS`,
    `            Kernel: Linux ${KERNEL_RELEASE}`,
    `      Architecture: ${MACHINE}`,
  ].join('\n');
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
