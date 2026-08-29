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
import { WireRemoteShell } from './WireRemoteShell';
import { openWireSshShell, openWireSshConnection, silentConnectIo } from '@/terminal/ssh/wireSshLogin';
import { SshInteractiveSubShell, findLinuxMachineByIp } from '@/terminal/subshells/SshInteractiveSubShell';
import type { IShell, ShellLineResult } from './IShell';
import { SshKnownHostsFile, type SshHostKeyType } from '@/network/protocols/ssh/SshKnownHostsFile';
import { readForceCommand, readMaxAuthTries } from '@/network/devices/linux/network/LinuxSshClient';
export { SSH_PASSWORD_PROMPTS } from '@/network/protocols/ssh/session/SshSession';
import { transportLiveness, establishedSessionLiveness } from '@/network/protocols/ssh/sessionLiveness';

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

import type { TcpWireOutcome } from '@/network/tcp/types';
export type { TcpWireOutcome };

export interface SshLaunchOptions {
  /** Default user when the ssh line omits `user@`. */
  readonly defaultUser: string;
  /**
   * The device this shell runs on — needed to check the launching
   * device's own `~/.ssh/known_hosts` against the target's real host key
   * (see {@link checkKnownHosts}). Omit to skip that check (falls back
   * to the pre-existing cosmetic "Warning: Permanently added" banner).
   */
  readonly sourceDevice?: Equipment;
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
  /** Local account the client runs as — picks which known_hosts store
   *  the connection reads and writes. */
  sourceUser?: string;
  /** The launching device — see {@link SshLaunchOptions.sourceDevice}. */
  sourceDevice?: Equipment;
  /** Carried across the password round-trip so the established session
   *  can keep probing the very same wire it was opened on. */
  wireProbe?: SshLaunchOptions['wireProbe'];
  /** Set for `ssh user@host cmd` — the command runs on the remote over
   *  its own exec channel instead of an interactive shell. */
  execCommand?: string;
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
  } else {
    const isOn = (target as unknown as { getIsPoweredOn?: () => boolean }).getIsPoweredOn?.() ?? true;
    if (!isOn) {
      return {
        kind: 'error',
        result: {
          output: [`ssh: connect to host ${parsed.host} port ${port}: No route to host`],
        },
      };
    }
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
        sourceUser: opts.defaultUser,
        sourceDevice: opts.sourceDevice,
        wireProbe: opts.wireProbe,
        execCommand: parsed.command,
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
      sourceIp: opts.sourceIp,
      sourceHostname: opts.sourceHostname,
      sourceUser: opts.defaultUser,
      sourceDevice: opts.sourceDevice,
      wireProbe: opts.wireProbe,
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

export type FinaliseAuthOutcome =
  | ({ kind: 'success' } & FinalisedAuth)
  /** `ssh user@host cmd` — the command already ran on the remote, over a
   *  real exec channel. `lines` is what it wrote. */
  | { kind: 'exec'; banner: string[]; lines: string[]; exitCode: number }
  | { kind: 'bad-password' }
  /** Password was right but the server refuses the session outright (host-key mismatch, ForceCommand=internal-sftp) — the caller must NOT re-prompt for a password. */
  | { kind: 'refused'; message: string };

const HOST_KEY_CHANGED_MESSAGE =
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n' +
  '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n' +
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n' +
  'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\n' +
  'Add correct host key in /root/.ssh/known_hosts to get rid of this message.\n' +
  'Offending key in /root/.ssh/known_hosts:1\n' +
  'Host key verification failed.';

interface DeviceVfsLike {
  readFile: (p: string) => string | null;
  writeFile: (p: string, c: string, uid: number, gid: number, umask: number) => void;
}

function vfsOf(device: unknown): DeviceVfsLike | null {
  return (device as { executor?: { vfs?: DeviceVfsLike } } | undefined)?.executor?.vfs ?? null;
}

/**
 * Real known_hosts comparison for the interactive `ssh` path — mirrors
 * {@link file://../network/devices/linux/network/LinuxSshClient.ts}'s
 * `updateKnownHosts`. Returns `'unsupported'` (skip, no-op) when either
 * side lacks a VFS — e.g. a non-Linux source or target — so this never
 * regresses cross-vendor SSH that isn't in scope for host-key checking.
 */
function checkKnownHosts(auth: PendingSshAuth): 'changed' | 'ok' | 'unsupported' {
  const targetVfs = vfsOf(auth.target);
  const sourceVfs = vfsOf(auth.sourceDevice);
  if (!targetVfs || !sourceVfs) return 'unsupported';
  const pubKeyRaw = targetVfs.readFile('/etc/ssh/ssh_host_ed25519_key.pub') ?? '';
  const tokens = pubKeyRaw.trim().split(/\s+/);
  if (tokens.length < 2) return 'unsupported';
  const keyType = tokens[0] as SshHostKeyType;
  const publicKey = tokens[1];

  const knownHostsPath = '/root/.ssh/known_hosts';
  const existing = sourceVfs.readFile(knownHostsPath) ?? '';
  const file = SshKnownHostsFile.parse(existing);
  if (file.hostKeyChanged(auth.host, keyType, publicKey)) return 'changed';
  if (!file.find(auth.host, keyType)) {
    const updated = file.add({ hostnames: [auth.host], keyType, publicKey });
    sourceVfs.writeFile(knownHostsPath, updated.serialize(), 0, 0, 0o022);
  }
  return 'ok';
}

/**
 * Verify the supplied password against the target device, then apply the
 * same server-side policy `LinuxSshClient`'s exec-mode path enforces
 * (host-key change, ForceCommand=internal-sftp) before handing back a
 * live interactive shell.
 */
export async function finalisePendingAuth(
  auth: PendingSshAuth,
  password: string,
): Promise<FinaliseAuthOutcome> {
  const serverAuthTryCap = readMaxAuthTries(
    auth.target as unknown as Parameters<typeof readMaxAuthTries>[0],
    auth.user, auth.sourceIp, auth.sourceHostname,
  );
  const tooManyAuthFailures = (): FinaliseAuthOutcome | null => (
    serverAuthTryCap !== null && auth.attempts >= serverAuthTryCap
      ? {
        kind: 'refused',
        message: [
          `Received disconnect from ${auth.host} port ${auth.port}:2: Too many authentication failures`,
          `Disconnected from ${auth.host} port ${auth.port}`,
        ].join('\n'),
      }
      : null
  );
  const alreadyDisconnected = tooManyAuthFailures();
  if (alreadyDisconnected) return alreadyDisconnected;

  if (!verifyCredentials(auth.target, auth.user, password)) {
    auth.attempts++;
    // Best-effort: record the failure for auth.log realism -- this is also
    // what feeds a device-wide `login block-for` LoginBlocker, so a failure
    // recorded HERE (not just OpenSSH's own 3-attempts cap) can be the one
    // that trips device-wide quiet-mode.
    tryRecordSshLogin(auth, false);
    const blocker = (auth.target as unknown as {
      getLoginBlocker?: () => { isBlocked: () => boolean; remainingBlockSeconds: () => number } | null;
    }).getLoginBlocker?.();
    if (blocker?.isBlocked()) {
      return {
        kind: 'refused',
        message: `% Blocking new login for ${blocker.remainingBlockSeconds()} secs (quota exceeded)`,
      };
    }
    const disconnected = tooManyAuthFailures();
    if (disconnected) return disconnected;
    return { kind: 'bad-password' };
  }

  // known_hosts is compared once, here: this check reads the target's
  // real host key and records it on first connection, so the connection
  // below is told not to repeat it rather than have two verdicts.
  if (checkKnownHosts(auth) === 'changed') {
    return { kind: 'refused', message: HOST_KEY_CHANGED_MESSAGE };
  }

  const forced = readForceCommand(
    auth.target as unknown as Parameters<typeof readForceCommand>[0],
    auth.user, auth.sourceIp, auth.sourceHostname,
  );
  if (forced === 'internal-sftp') {
    return { kind: 'refused', message: 'This service allows sftp connections only.' };
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
  const registry = (auth.target as unknown as {
    getSshSessionRegistry?: () => {
      open: (input: { user: string; fromIp: string; fromHost?: string; peerPort?: number }) => { id: string } | null;
      close: (id: string, reason?: string) => unknown;
    };
  }).getSshSessionRegistry?.();
  if (!auth.sourceDevice) {
    // Without the device that typed `ssh` there is nothing to connect
    // FROM. Dialling the target from itself would look fine and prove
    // nothing, so the launch fails instead.
    return {
      kind: 'refused',
      message: `ssh: connect to host ${auth.host} port ${auth.port}: Network is unreachable`,
    };
  }

  if (auth.execCommand !== undefined) {
    return runExecOverTheWire(auth, banner, password);
  }

  // The credentials were accepted, so open the connection they belong to
  // and drive the remote over it. Its prompt, completion, sub-shells,
  // editors and challenges are answered by the server on this channel
  // rather than reproduced locally.
  // The line is taken only once the connection is really up, so a login
  // that fails on the wire does not hold one.
  const outcome = await openWireSshShell({
    device: auth.sourceDevice,
    localUser: auth.sourceUser ?? auth.user,
    user: auth.user,
    host: auth.host,
    port: auth.port,
    io: silentConnectIo(),
    password,
    strict: 'no',
  });
  if (outcome.kind !== 'connected') {
    if (outcome.kind === 'host-key-changed') {
      return { kind: 'refused', message: HOST_KEY_CHANGED_MESSAGE };
    }
    if (outcome.kind === 'auth-failed') return { kind: 'bad-password' };
    if (outcome.kind === 'cancelled') return { kind: 'refused', message: '' };
    return { kind: 'refused', message: outcome.message };
  }

  const session = registry?.open({
    user: auth.user,
    fromIp: clientIp,
    fromHost: auth.sourceHostname,
    peerPort: clientPort,
  }) ?? null;

  const promptHost = (auth.target as unknown as { getSshHostname?: () => string })
    .getSshHostname?.() ?? auth.host;
  const wire = new SshInteractiveSubShell(
    outcome.session, outcome.channel, auth.user, auth.host,
    `/home/${auth.user}`,
    () => outcome.session.disconnect(),
    promptHost, findLinuxMachineByIp(auth.host) ?? undefined,
    // Socket AND path: this side's socket notices its own link dropping,
    // the path notices everything that breaks at the other end or in
    // between (docs/PRD-Pannes.md §F1, §F5).
    auth.sourceDevice
      ? establishedSessionLiveness(outcome.session, auth.sourceDevice, auth.host)
      : transportLiveness(outcome.session),
  );
  const shell = new WireRemoteShell({
    device: auth.target,
    user: auth.user,
    remoteHost: auth.host,
    primaryKind: auth.primaryKind,
    wire,
    sshConnection,
    sshClient,
    onClose: () => { if (session) registry?.close(session.id, 'logout'); },
  });
  return { kind: 'success', shell, banner };
}

async function runExecOverTheWire(
  auth: PendingSshAuth,
  banner: string[],
  password: string,
): Promise<FinaliseAuthOutcome> {
  const outcome = await openWireSshConnection({
    device: auth.sourceDevice!,
    localUser: auth.sourceUser ?? auth.user,
    user: auth.user,
    host: auth.host,
    port: auth.port,
    io: silentConnectIo(),
    password,
    strict: 'no',
  });
  if (outcome.kind !== 'connected') {
    if (outcome.kind === 'host-key-changed') return { kind: 'refused', message: HOST_KEY_CHANGED_MESSAGE };
    if (outcome.kind === 'auth-failed') return { kind: 'bad-password' };
    if (outcome.kind === 'cancelled') return { kind: 'refused', message: '' };
    return { kind: 'refused', message: outcome.message };
  }

  const channel = outcome.session.openExecChannel(auth.execCommand ?? '');
  if (!channel.ok) {
    outcome.session.disconnect();
    return { kind: 'refused', message: 'ssh: failed to open exec channel' };
  }
  try {
    const result = await channel.value.execute();
    const text = [result.stdout, result.stderr].filter((part) => part.length > 0).join('');
    const lines = text.length === 0 ? [] : text.replace(/\n+$/, '').split('\n');
    return { kind: 'exec', banner, lines, exitCode: result.exitCode };
  } finally {
    outcome.session.disconnect();
  }
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
  const target = auth.target as unknown as {
    getSshMotd?: () => string;
    sshBanner?: () => string;
    getLastSshLoginFor?: (u: string) => { at: Date; from: string } | null;
    getBanner?: (kind: string) => string;
  };
  // Cisco/Huawei: the real `banner motd` (mirrored into sshBannerText by
  // `banner motd` itself) — takes priority over the generic per-OS MOTD
  // concept below, which those device types don't otherwise populate.
  const ciscoMotd = target.sshBanner?.() ?? '';
  if (ciscoMotd) {
    for (const ln of ciscoMotd.replace(/\n+$/, '').split('\n')) {
      if (ln.length > 0) banner.push(ln);
    }
  } else {
    // Device-specific MOTD (Linux servers ship one; Windows / routers do not).
    const motd = target.getSshMotd?.() ?? '';
    for (const ln of motd.replace(/\n+$/, '').split('\n')) {
      if (ln.length > 0) banner.push(ln);
    }
  }
  // "Last login: " — best-effort, ISO date if the device exposes one.
  // OpenSSH format: "Last login: Mon Nov 18 14:23:01 2024 from 10.0.0.1"
  const last = target.getLastSshLoginFor?.(auth.user);
  if (last) {
    banner.push(`Last login: ${formatLoginDate(last.at)} from ${last.from}`);
  }
  // Real IOS/VRP: `banner exec` is shown on every successful EXEC session
  // start, independent of the client tooling used to reach it.
  const execBanner = target.getBanner?.('exec') ?? '';
  if (execBanner) {
    if (banner.length > 0) banner.push('');
    for (const ln of execBanner.replace(/\n+$/, '').split('\n')) banner.push(ln);
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
