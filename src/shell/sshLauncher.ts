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
import { WireRemoteShell } from './WireRemoteShell';
import {
  openWireSshShell, openWireSshConnection, resolveSshTarget,
  type WireSshConnectOutcome, type WireSshLoginOutcome,
} from '@/terminal/ssh/wireSshLogin';
import { QueuedTerminalIO } from '@/network/protocols/ssh/session/QueuedTerminalIO';
import { OPENSSH_SSH } from '@/terminal/ssh/sshDialect';
import { SshInteractiveSubShell, findLinuxMachineByIp } from '@/terminal/subshells/SshInteractiveSubShell';
import type { IShell, ShellLineResult } from './IShell';
import { sshReplyWithoutSession } from '@/network/protocols/ssh/SshClientCommandLine';
import { parseSshCommandLine } from '@/terminal/sessions/sshArgs';
import type { SshAlgorithmPreferences } from '@/network/protocols/ssh/transport/SshTransport';
import { OPENSSH_UBUNTU_22_04, OPENSSH_WINDOWS_8_6 } from '@/network/protocols/ssh/OpenSshRelease';
import { parseBashPrompt } from '@/network/devices/linux/shell/BashPrompt';
export { SSH_PASSWORD_PROMPTS } from '@/network/protocols/ssh/session/SshSession';
import { establishedSessionLiveness } from '@/network/protocols/ssh/sessionLiveness';

import type { TcpWireOutcome } from '@/network/tcp/types';
export type { TcpWireOutcome };

export interface SshLaunchOptions {
  /** Default user when the ssh line omits `user@`. */
  readonly defaultUser: string;
  /** The device this shell runs on: the machine the connection leaves from. */
  readonly sourceDevice?: Equipment;
  /** Source IP (the launching shell's device IP). */
  readonly sourceIp?: string;
  /** Source hostname of the launching device. */
  readonly sourceHostname?: string;
}

/**
 * A login under way. It lives from the first password prompt to the
 * session (or the refusal): one TCP connection, so the SERVER counts the
 * failed attempts and the SERVER decides when to hang up.
 */
type LoginOutcome = WireSshConnectOutcome | WireSshLoginOutcome;

interface LoginRun {
  readonly io: QueuedTerminalIO;
  readonly lines: string[];
  readonly settled: Promise<LoginOutcome>;
  parked: LoginEvent | null;
  nextEvent(): Promise<LoginEvent>;
}

type LoginEvent =
  | { readonly kind: 'prompt'; readonly text: string; readonly secret: boolean }
  | { readonly kind: 'settled'; readonly outcome: LoginOutcome };

/** Resolved SSH target a shell can finalise once it has the password. */
export interface PendingSshAuth {
  readonly user: string;
  readonly host: string;
  readonly port: number;
  /** The address the host name resolved to — where the SYN went. */
  readonly address: string;
  /** Number of failed attempts so far. */
  attempts: number;
  /** Source IP / hostname of the launching device. */
  sourceIp?: string;
  sourceHostname?: string;
  /** Local account the client runs as — picks which known_hosts store
   *  the connection reads and writes. */
  sourceUser?: string;
  /** The launching device — see {@link SshLaunchOptions.sourceDevice}. */
  sourceDevice?: Equipment;
  /** Set for `ssh user@host cmd` — the command runs on the remote over
   *  its own exec channel instead of an interactive shell. */
  execCommand?: string;
  readonly algorithms?: SshAlgorithmPreferences;
  run?: LoginRun;
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
 *  - `error` for unreachable / refused / unknown-host failures — whatever
 *            the wire answered to the first SYN, never what the target
 *            machine's own state says.
 *  - `pending` for a login — the caller must ask the user for a password
 *            via pendingInput, then call finalisePendingAuth.
 */
export async function tryInterpretSshLaunch(
  line: string,
  opts: SshLaunchOptions,
): Promise<SshLaunchInterpretation | null> {
  const parsed = parseSshCommandLine(line);
  if (!parsed) return null;

  const release = opts.sourceDevice?.getOSType?.() === 'windows' ? OPENSSH_WINDOWS_8_6 : OPENSSH_UBUNTU_22_04;
  const withoutSession = sshReplyWithoutSession(line.trim().split(/\s+/).slice(1), release);
  if (withoutSession) {
    return {
      kind: withoutSession.exitCode === 0 ? 'noop' : 'error',
      result: { output: withoutSession.output.split('\n') },
    };
  }

  const user = parsed.user ?? opts.defaultUser;
  const port = parsed.port;
  if (!opts.sourceDevice) {
    return {
      kind: 'error',
      result: { output: [OPENSSH_SSH.unreachable(parsed.host, port)] },
    };
  }
  const resolution = await resolveSshTarget(opts.sourceDevice, parsed.host, port, OPENSSH_SSH);
  if (resolution.kind === 'failed') {
    return { kind: 'error', result: { output: [resolution.line] } };
  }

  const pendingAuth: PendingSshAuth = {
    user, host: parsed.host, port, address: resolution.address,
    attempts: 0,
    sourceIp: opts.sourceIp,
    sourceHostname: opts.sourceHostname,
    sourceUser: opts.defaultUser,
    sourceDevice: opts.sourceDevice,
    ...(parsed.command !== null ? { execCommand: parsed.command } : {}),
    algorithms: parsed.algorithms,
  };
  const run = pendingAuth.run = startLoginRun(pendingAuth);
  const first = await run.nextEvent();
  if (first.kind === 'settled') {
    const refusal = await outcomeOf(pendingAuth, run, first.outcome);
    return {
      kind: 'error',
      result: { output: refusal.kind === 'refused' && refusal.message !== '' ? refusal.message.split('\n') : [] },
    };
  }
  run.parked = first;
  return {
    kind: 'pending',
    result: {
      output: drain(run),
      pendingInput: { kind: 'password', promptText: first.text },
    },
    pendingAuth,
  };
}

/** Result of accepting a successful authentication. */
export interface FinalisedAuth {
  readonly shell: IShell;
  /**
   * Lines to print BEFORE the shell becomes active — what the SSH layer
   * said while connecting (the known_hosts notice, the server's pre-auth
   * banner) and the server's own message of the day. The caller writes
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
  /** The server refuses the session outright (host-key mismatch, too many failures, ForceCommand=internal-sftp) — the caller must NOT re-prompt for a password. */
  | { kind: 'refused'; message: string };

const RETRY_NOTICE = 'Permission denied, please try again.';

function startLoginRun(auth: PendingSshAuth): LoginRun {
  const lines: string[] = [];
  let parked: LoginEvent | null = null;
  let waiter: ((event: LoginEvent) => void) | null = null;
  const io = new QueuedTerminalIO({
    writeLine: (text) => { lines.push(text); },
    beginPrompt: (text, secret) => {
      const event: LoginEvent = { kind: 'prompt', text, secret };
      if (waiter !== null) {
        const deliver = waiter;
        waiter = null;
        deliver(event);
      } else {
        parked = event;
      }
    },
    endPrompt: () => undefined,
  });
  const request = {
    device: auth.sourceDevice!,
    localUser: auth.sourceUser ?? auth.user,
    user: auth.user,
    host: auth.host,
    port: auth.port,
    io,
    strict: 'accept-new' as const,
    algorithms: auth.algorithms,
  };
  const settled = auth.execCommand !== undefined
    ? openWireSshConnection(request)
    : openWireSshShell(request);
  const run: LoginRun = {
    io, lines, settled,
    get parked() { return parked; },
    set parked(event) { parked = event; },
    nextEvent: () => {
      if (parked !== null) {
        const event = parked;
        parked = null;
        return Promise.resolve(event);
      }
      return Promise.race([
        settled.then((outcome): LoginEvent => ({ kind: 'settled', outcome })),
        new Promise<LoginEvent>((resolve) => { waiter = resolve; }),
      ]);
    },
  };
  return run;
}

function drain(run: LoginRun): string[] {
  return run.lines.splice(0).filter((line) => line !== RETRY_NOTICE);
}

export async function finalisePendingAuth(
  auth: PendingSshAuth,
  password: string,
): Promise<FinaliseAuthOutcome> {
  if (!auth.sourceDevice) {
    return {
      kind: 'refused',
      message: `ssh: connect to host ${auth.host} port ${auth.port}: Network is unreachable`,
    };
  }
  const run = auth.run ??= startLoginRun(auth);
  let event = await run.nextEvent();
  if (event.kind === 'prompt') {
    run.io.submitInput(password);
    event = await run.nextEvent();
    if (event.kind === 'prompt') {
      run.parked = event;
      auth.attempts++;
      return { kind: 'bad-password' };
    }
    if (event.outcome.kind === 'auth-failed' && !run.lines.some((line) => line.includes('Received disconnect'))) {
      run.lines.length = 0;
      auth.attempts++;
      return { kind: 'bad-password' };
    }
  }
  return outcomeOf(auth, run, event.outcome);
}

async function outcomeOf(
  auth: PendingSshAuth, run: LoginRun, outcome: LoginOutcome,
): Promise<FinaliseAuthOutcome> {
  const said = drain(run);
  if (outcome.kind !== 'connected') {
    if (outcome.kind === 'cancelled') return { kind: 'refused', message: '' };
    if (outcome.kind === 'host-key-changed') {
      return { kind: 'refused', message: [...said, 'Host key verification failed.'].join('\n') };
    }
    if (outcome.kind === 'auth-failed') {
      auth.attempts++;
      return { kind: 'refused', message: said.join('\n') };
    }
    return { kind: 'refused', message: outcome.message };
  }
  if (!('channel' in outcome)) return runExecOverTheWire(auth, outcome.session, said);

  const channel = outcome.channel;
  await channel.untilQuiet?.();
  if (!channel.isOpen) {
    outcome.session.disconnect();
    const closing = (channel.takeUnclaimedOutput?.() ?? '').replace(/\n+$/, '');
    return { kind: 'refused', message: closing };
  }
  const greeting = (channel.initialMotd?.() ?? '').replace(/\n+$/, '');
  const motd = greeting === '' ? [] : greeting.split('\n').filter((line) => line.length > 0);
  const opening = channel.initialPrompt?.() ?? null;
  const promptHost = (opening !== null ? parseBashPrompt(opening)?.hostname : undefined) ?? auth.host;
  const local = outcome.session.localEndpoint;
  const clientIp = local?.ip ?? auth.sourceIp ?? '0.0.0.0';
  const clientPort = local?.port ?? 0;
  const wire = new SshInteractiveSubShell(
    outcome.session, channel, auth.user, auth.host,
    `/home/${auth.user}`,
    () => outcome.session.disconnect(),
    promptHost, findLinuxMachineByIp(auth.host) ?? undefined,
    establishedSessionLiveness(outcome.session, auth.sourceDevice!, auth.host),
  );
  const shell = new WireRemoteShell({
    device: auth.sourceDevice!,
    user: auth.user,
    remoteHost: auth.host,
    primaryKind: channel.loginShellKind?.() ?? 'bash',
    wire,
    sshConnection: `${clientIp} ${clientPort} ${auth.address} ${auth.port}`,
    sshClient: `${clientIp} ${clientPort} ${auth.port}`,
  });
  return { kind: 'success', shell, banner: [...said, ...motd] };
}

async function runExecOverTheWire(
  auth: PendingSshAuth,
  session: Extract<LoginOutcome, { kind: 'connected' }>['session'],
  said: string[],
): Promise<FinaliseAuthOutcome> {
  const channel = session.openExecChannel(auth.execCommand ?? '');
  if (!channel.ok) {
    session.disconnect();
    return { kind: 'refused', message: 'ssh: failed to open exec channel' };
  }
  try {
    const result = await channel.value.execute();
    const text = [result.stdout, result.stderr].filter((part) => part.length > 0).join('');
    const lines = text.length === 0 ? [] : text.replace(/\n+$/, '').split('\n');
    return { kind: 'exec', banner: said, lines, exitCode: result.exitCode };
  } finally {
    session.disconnect();
  }
}
