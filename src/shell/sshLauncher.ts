/**
 * sshLauncher — OpenSSH-faithful entry point for `ssh` typed inside any
 * shell (bash, cmd, PowerShell).
 *
 * Goals:
 *  - Mirror real OpenSSH client behaviour as closely as the simulator
 *    permits: hostkey warning, MOTD, "Last login", proper exit codes,
 *    realistic error messages (Connection refused, No route to host,
 *    Permission denied (publickey,password)).
 *  - Support `-p <port>`, `-V` (version), and exec mode
 *    (`ssh user@host cmd args…`).
 *  - Issue the password challenge via `pendingInput` so the OUTER
 *    terminal masks keystrokes regardless of which shell intercepted.
 */

import { Equipment } from '@/network/equipment/Equipment';
import { IPAddress } from '@/network/core/types';
import { isCredentialAuthenticator } from '@/network/equipment/HostCapabilities';
import { findEquipmentByIp, findEquipmentByHostname } from './hostResolution';
import { primaryShellKindFor } from './shellKind';
import { CrossVendorRemoteShell } from './CrossVendorRemoteShell';
import type { IShell, ShellLineResult } from './IShell';

/** Tokenise an ssh command line into flags, optional value, user/host, and remaining argv. */
interface ParsedSshLine {
  flags: Record<string, string | true>;
  user: string | null;
  host: string;
  command: string | null;
}

function parseSshLine(line: string): ParsedSshLine | null {
  const trimmed = line.trim();
  if (!/^ssh(\s|$)/.test(trimmed)) return null;
  const tokens = trimmed.split(/\s+/).slice(1);

  const flags: Record<string, string | true> = {};
  let i = 0;
  // OpenSSH short flags that consume a value.
  const valueFlags = new Set(['p', 'i', 'l', 'o', 'b', 'c', 'D', 'E', 'F', 'I', 'J', 'L', 'R', 'S', 'W']);
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '-V' || t === '-q' || t === '-v' || t === '-vv' || t === '-vvv'
        || t === '-T' || t === '-t' || t === '-x' || t === '-X' || t === '-Y'
        || t === '-A' || t === '-a' || t === '-C' || t === '-N' || t === '-n'
        || t === '-f' || t === '-g' || t === '-K' || t === '-k' || t === '-M'
        || t === '-s' || t === '-y' || t === '-4' || t === '-6') {
      flags[t.slice(1)] = true; i++; continue;
    }
    if (t.startsWith('-') && t.length === 2 && valueFlags.has(t[1])) {
      const v = tokens[i + 1] ?? '';
      flags[t[1]] = v;
      i += 2; continue;
    }
    if (t.startsWith('--')) { flags[t.slice(2)] = true; i++; continue; }
    if (t.startsWith('-')) { i++; continue; } // unknown / multi-char short, ignore
    break;
  }

  if (i >= tokens.length) {
    // Only flags (e.g. `ssh -V`). No host present.
    return { flags, user: null, host: '', command: null };
  }
  const target = tokens[i++];
  let user: string | null = null;
  let host = target;
  if (target.includes('@')) {
    const [u, h] = target.split('@', 2);
    user = u; host = h;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(host)) return null;

  const remainder = tokens.slice(i).join(' ').trim();
  return { flags, user, host, command: remainder.length > 0 ? remainder : null };
}

export type TcpWireOutcome = 'open' | 'refused' | 'timeout';

export interface SshLaunchOptions {
  /** Default user when the ssh line omits `user@`. */
  readonly defaultUser: string;
  readonly wireProbe?: (host: string, port: number) => TcpWireOutcome;
  /**
   * Track which (user, host) pairs already wrote a known_hosts entry in
   * this session. The first connection prints the "Warning: Permanently
   * added" line; subsequent ones are silent. Optional — when omitted,
   * every connection prints it (still correct for short sessions).
   */
  readonly knownHostsTracker?: Set<string>;
  /** Source IP (the launching shell's device IP) — written to wtmp + auth.log. */
  readonly sourceIp?: string;
  /** Source hostname for the "from" field of last-login records. */
  readonly sourceHostname?: string;
}

/** Resolved SSH target a shell can finalise once it has the password. */
export interface PendingSshAuth {
  readonly target: Equipment;
  readonly user: string;
  readonly host: string;
  readonly port: number;
  readonly primaryKind: string;
  /** Number of failed attempts so far (capped at three). */
  attempts: number;
  /** Tracker shared with the launcher options, mutated on success. */
  knownHostsTracker?: Set<string>;
  /** Source IP / hostname propagated for auth.log + last-login records. */
  sourceIp?: string;
  sourceHostname?: string;
}

export type SshLaunchInterpretation =
  | { kind: 'noop'; result: ShellLineResult }
  | { kind: 'error'; result: ShellLineResult }
  | { kind: 'exec'; result: ShellLineResult }
  | { kind: 'pending'; result: ShellLineResult; pendingAuth: PendingSshAuth };

/**
 * Interpret `line` as an ssh invocation. Returns null when it is not an
 * ssh command at all. Otherwise emits:
 *  - `noop`  for informational forms (`ssh -V`).
 *  - `error` for unreachable / refused / unknown-host failures.
 *  - `exec`  for `ssh user@host cmd args…` — output produced inline,
 *            no shell push.
 *  - `pending` for interactive login — the caller must ask the user for
 *            a password via pendingInput, then call finalisePendingAuth.
 */
export async function tryInterpretSshLaunch(
  line: string,
  opts: SshLaunchOptions,
): Promise<SshLaunchInterpretation | null> {
  const parsed = parseSshLine(line);
  if (!parsed) return null;

  // `ssh -V` — print the simulator's client banner.
  if (parsed.flags['V']) {
    return {
      kind: 'noop',
      result: {
        output: [
          'OpenSSH_9.6p1 Ubuntu-3ubuntu13.4, OpenSSL 3.0.13 30 Jan 2024',
        ],
      },
    };
  }

  if (!parsed.host) {
    return {
      kind: 'error',
      result: {
        output: ['usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface]',
          '           [-b bind_address] [-c cipher_spec] [-D [bind_address:]port]',
          '           [-E log_file] [-F configfile] [-I pkcs11] [-i identity_file]',
          '           [-J [user@]host[:port]] [-L address] [-l login_name] [-m mac_spec]',
          '           [-O ctl_cmd] [-o option] [-p port] [-Q query_option] [-R address]',
          '           [-S ctl_path] [-W host:port] [-w local_tun[:remote_tun]]',
          '           destination [command [argument ...]]'],
      },
    };
  }

  const user = parsed.user ?? opts.defaultUser;
  const port = typeof parsed.flags['p'] === 'string'
    ? Number.parseInt(parsed.flags['p'] as string, 10) : 22;

  const target = findEquipmentByIp(parsed.host) ?? findEquipmentByHostname(parsed.host);
  if (!target) {
    return {
      kind: 'error',
      result: {
        output: [`ssh: Could not resolve hostname ${parsed.host}: Name or service not known`],
      },
    };
  }

  if (opts.wireProbe) {
    const probeHost = IPAddress.isValid(parsed.host)
      ? parsed.host
      : firstConfiguredIp(target);
    const outcome: TcpWireOutcome = probeHost
      ? opts.wireProbe(probeHost, port)
      : 'timeout';
    if (outcome !== 'open') {
      const reason = outcome === 'refused' ? 'Connection refused' : 'Connection timed out';
      return {
        kind: 'error',
        result: {
          output: [`ssh: connect to host ${parsed.host} port ${port}: ${reason}`],
        },
      };
    }
  }

  // Reachability — powered off device shows the realistic error.
  const isOn = (target as unknown as { getIsPoweredOn?: () => boolean }).getIsPoweredOn?.() ?? true;
  if (!isOn) {
    return {
      kind: 'error',
      result: {
        output: [`ssh: connect to host ${parsed.host} port ${port}: No route to host`],
      },
    };
  }

  // SSH server explicitly disabled on the target.
  const sshOn = (target as unknown as { isSshActive?: () => boolean }).isSshActive?.();
  if (sshOn === false) {
    return {
      kind: 'error',
      result: {
        output: [`ssh: connect to host ${parsed.host} port ${port}: Connection refused`],
      },
    };
  }

  const admission = (target as unknown as {
    vtyAdmissionVerdict?: (transport: 'ssh', sourceIp: string) => { accept: boolean };
  }).vtyAdmissionVerdict?.('ssh', opts.sourceIp ?? '');
  if (admission && !admission.accept) {
    return {
      kind: 'error',
      result: {
        output: [`ssh: connect to host ${parsed.host} port ${port}: Connection refused`],
      },
    };
  }

  const primaryKind = pickPrimaryShellKind(target);

  // Exec mode: `ssh user@host cmd args` — runs the command on the remote
  // and returns to the caller's shell. No frame is pushed. Authentication
  // is still validated through a password challenge.
  if (parsed.command !== null) {
    return {
      kind: 'pending',
      result: {
        output: [],
        pendingInput: {
          kind: 'password',
          promptText: `${user}@${parsed.host}'s password: `,
        },
      },
      pendingAuth: {
        target, user, host: parsed.host, port, primaryKind,
        attempts: 0,
        knownHostsTracker: opts.knownHostsTracker,
        sourceIp: opts.sourceIp,
        sourceHostname: opts.sourceHostname,
      },
    };
  }

  return {
    kind: 'pending',
    result: {
      output: [],
      pendingInput: {
        kind: 'password',
        promptText: `${user}@${parsed.host}'s password: `,
      },
    },
    pendingAuth: {
      target, user, host: parsed.host, port, primaryKind,
      attempts: 0,
      knownHostsTracker: opts.knownHostsTracker,
    },
  };
}

/** Result of accepting a successful authentication. */
export interface FinalisedAuth {
  readonly shell: IShell;
  /**
   * Banner lines to print BEFORE the shell becomes active — known_hosts
   * warning (first connection), MOTD, last-login, etc. The caller writes
   * them to the host terminal so the SSH push looks like a real login.
   */
  readonly banner: readonly string[];
}

/**
 * Verify the supplied password against the target device. Returns the
 * built CrossVendorRemoteShell with the OpenSSH-style banner on success,
 * or null on failure (caller drives retry).
 */
export function finalisePendingAuth(
  auth: PendingSshAuth,
  password: string,
): FinalisedAuth | null {
  if (!verifyCredentials(auth.target, auth.user, password)) {
    auth.attempts++;
    // Best-effort: record the failure for auth.log realism.
    tryRecordSshLogin(auth, false);
    return null;
  }
  // Build the banner BEFORE recording — the OpenSSH "Last login" line
  // must reflect the PREVIOUS login, not this one.
  const banner = buildLoginBanner(auth);
  tryRecordSshLogin(auth, true);
  const serverIp = firstConfiguredIp(auth.target) ?? auth.host;
  const clientIp = auth.sourceIp ?? '0.0.0.0';
  // OpenSSH exposes synthetic ephemeral client port and the canonical
  // server port. The simulator picks a stable-looking pair so values are
  // reproducible across runs but still look real.
  const clientPort = 50_000 + (auth.user.length * 7 % 10_000);
  const sshConnection = `${clientIp} ${clientPort} ${serverIp} ${auth.port}`;
  const sshClient = `${clientIp} ${clientPort} ${auth.port}`;
  const shell = new CrossVendorRemoteShell({
    device: auth.target,
    user: auth.user,
    remoteHost: auth.host,
    primaryKind: auth.primaryKind,
    sshConnection,
    sshClient,
  });
  return { shell, banner };
}

function firstConfiguredIp(dev: Equipment): string | undefined {
  const ports = (dev as unknown as { ports?: Map<string, { getIPAddress: () => { toString(): string } | null }> }).ports;
  if (!ports) return undefined;
  for (const port of ports.values()) {
    const ip = port.getIPAddress?.();
    if (ip) return ip.toString();
  }
  return undefined;
}

/** Record success/failure on the target device so /var/log/auth.log and
 *  the lastlog tracker stay coherent with what the user observes. */
function tryRecordSshLogin(auth: PendingSshAuth, accepted: boolean): void {
  const dev = auth.target as unknown as {
    recordSshLogin?: (
      u: string, ip: string, host: string, ok: boolean, method?: 'password' | 'publickey',
    ) => void;
  };
  if (typeof dev.recordSshLogin === 'function') {
    dev.recordSshLogin(
      auth.user,
      auth.sourceIp ?? '0.0.0.0',
      auth.sourceHostname ?? '',
      accepted,
      'password',
    );
  }
}

/** Build the banner lines OpenSSH prints once authentication succeeds. */
function buildLoginBanner(auth: PendingSshAuth): string[] {
  const banner: string[] = [];
  // Known-hosts acceptance — only on first connection in this session.
  const key = `${auth.user}@${auth.host}:${auth.port}`;
  const firstTime = !auth.knownHostsTracker?.has(key);
  if (firstTime) {
    banner.push(`Warning: Permanently added '${auth.host}' (ssh-ed25519) to the list of known hosts.`);
    auth.knownHostsTracker?.add(key);
  }
  // Device-specific MOTD (Linux servers ship one; Windows / routers do not).
  const motd = (auth.target as unknown as { getSshMotd?: () => string }).getSshMotd?.();
  if (motd) {
    for (const ln of motd.replace(/\n+$/, '').split('\n')) {
      if (ln.length > 0) banner.push(ln);
    }
  }
  // "Last login: " — best-effort, ISO date if the device exposes one.
  // OpenSSH format: "Last login: Mon Nov 18 14:23:01 2024 from 10.0.0.1"
  const last = (auth.target as unknown as { getLastSshLoginFor?: (u: string) => { at: Date; from: string } | null })
    .getLastSshLoginFor?.(auth.user);
  if (last) {
    banner.push(`Last login: ${formatLoginDate(last.at)} from ${last.from}`);
  }
  return banner;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function formatLoginDate(d: Date): string {
  const dow = DAYS[d.getDay()];
  const mon = MONTHS[d.getMonth()];
  const day = d.getDate().toString().padStart(2, ' ');
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${dow} ${mon} ${day} ${hh}:${mm}:${ss} ${d.getFullYear()}`;
}

function verifyCredentials(
  device: Equipment, user: string, password: string,
): boolean {
  if (isCredentialAuthenticator(device)) return device.checkPassword(user, password);
  const dev = device as unknown as {
    userMgr?: { checkPassword?: (u: string, p: string) => boolean };
  };
  if (typeof dev.userMgr?.checkPassword === 'function') return dev.userMgr.checkPassword(user, password);
  return true;
}

/** Run `ssh user@host cmd args` exec mode after a successful auth. */
export async function runSshExec(
  auth: PendingSshAuth,
  command: string,
): Promise<string[]> {
  const dev = auth.target as unknown as { executeCommand: (c: string) => Promise<string> };
  try {
    const out = await dev.executeCommand(command);
    if (!out) return [];
    return out.replace(/\n+$/, '').split('\n');
  } catch (err) {
    return [`ssh: exec failed: ${err instanceof Error ? err.message : String(err)}`];
  }
}

// ─── Equipment lookup helpers (shared with the Oracle Net client) ────

function pickPrimaryShellKind(dev: Equipment): string {
  return primaryShellKindFor(dev);
}

export function wireProbeFor(device: unknown): SshLaunchOptions['wireProbe'] {
  const source = device as {
    tcpConnectOutcome?: (ip: IPAddress, port: number) => TcpWireOutcome;
  };
  if (typeof source.tcpConnectOutcome !== 'function') return undefined;
  return (host, port) => {
    const ip = IPAddress.tryParse(host);
    if (!ip) return 'timeout';
    return source.tcpConnectOutcome!(ip, port);
  };
}
