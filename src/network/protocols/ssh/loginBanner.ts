/**
 * composeSshLoginBanner — the post-auth banner (issue.net + motd +
 * "Last login: …" + `banner exec`) shared by every place that lands a
 * user on a real interactive session after SSH auth: the top-level
 * bypass (TerminalSession.adoptRemoteChild), the real-wire
 * SshInteractiveSubShell (first hop and any nested hop it opens).
 *
 * Extracted so a *nested* ssh (typed inside an already-connected
 * real-wire session) gets the exact same OpenSSH-shaped banner a
 * top-level connect does, without SshInteractiveSubShell needing to be
 * a TerminalSession subclass.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatLoginDate(d: Date): string {
  const dow = DAYS[d.getDay()];
  const mon = MONTHS[d.getMonth()];
  const day = d.getDate().toString().padStart(2, ' ');
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${dow} ${mon} ${day} ${hh}:${mm}:${ss} ${d.getFullYear()}`;
}

export interface SshBannerDevice {
  sshBanner?: () => string;
  getSshMotd?: () => string;
  getLastSshLoginFor?: (u: string) => { at: Date; from: string } | null;
  recordSshLogin?: (u: string, ip: string, host: string, ok: boolean, m?: 'password' | 'publickey') => void;
  getBanner?: (kind: string) => string;
}

export function composeSshLoginBanner(
  device: unknown,
  user: string,
  sourceIp: string,
  sourceHost: string,
  quiet = false,
): string[] {
  const dev = device as SshBannerDevice;
  const lines: string[] = [];
  if (!quiet) {
    const issueNet = dev.sshBanner?.() ?? '';
    for (const ln of issueNet.replace(/\n+$/, '').split('\n')) {
      if (ln.length > 0) lines.push(ln);
    }
    const motd = dev.getSshMotd?.() ?? '';
    for (const ln of motd.replace(/\n+$/, '').split('\n')) {
      if (ln.length > 0) lines.push(ln);
    }
    const last = dev.getLastSshLoginFor?.(user) ?? null;
    if (last) {
      if (lines.length > 0) lines.push('');
      lines.push(`Last login: ${formatLoginDate(last.at)} from ${last.from}`);
    }
  }
  dev.recordSshLogin?.(user, sourceIp, sourceHost, true, 'password');
  // Real IOS: `banner exec` is shown on every successful EXEC session
  // start (unlike `banner login`, which SSH2 never sends — it
  // authenticates before any banner exchange). Applies regardless of
  // `quiet`, matching that it's tied to the exec session, not the SSH
  // transport-level banner exchange.
  const execBanner = dev.getBanner?.('exec') ?? '';
  if (execBanner) {
    if (lines.length > 0) lines.push('');
    for (const ln of execBanner.replace(/\n+$/, '').split('\n')) lines.push(ln);
  }
  return lines;
}
