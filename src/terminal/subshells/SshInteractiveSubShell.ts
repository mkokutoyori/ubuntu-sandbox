/**
 * SshInteractiveSubShell — real-wire interactive shell sub-shell for
 * Linux↔Linux SSH sessions.
 *
 * Unlike RemoteShellSubShell (one exec channel per line, client-side cwd
 * prefixing because exec channels are stateless), this wraps a single
 * persistent `ISshShellChannel` opened via `session.openShellChannel()`.
 * The server keeps one real, persistent shell session per channel
 * (LinuxSshServerContext.getShell's fullExecutor), so cwd/env genuinely
 * survive across lines with no client-side prefixing trick needed.
 *
 * Streaming commands (currently `ping`/`ping6`, see SshInteractiveShell)
 * push output line-by-line over the wire as `shell_output` messages while
 * still running server-side; this class forwards every pushed chunk to
 * the `onProgress` callback ISubShell.processLine() now accepts, so the
 * host terminal renders it in real time instead of buffering the whole
 * command. Ctrl+C is forwarded as a real `shell_signal` wire message
 * (see interruptForeground()) instead of only clearing local input.
 *
 * `su` is special-cased (see handleInput()) via the same generic
 * pendingInput/handleInput password-broker contract every other sub-shell
 * already uses: the host masks the typed password locally, and we pipe it
 * to the remote's own `su` the way the LOCAL terminal's interactive-flow
 * engine does (`printf '%s\n' '<pwd>' | su`, LinuxInteractionPlanner.ts's
 * suExecuteStep) — one extra plain round trip, no new wire message.
 *
 * A *nested* `ssh user@host` (bare — no flags, no trailing command) typed
 * inside this session is a REAL second hop, not a limitation: since this
 * whole simulator is one JS process, the instance driving hop N can just
 * construct a genuine SshSession from hop N's OWN device (its real
 * tcpConnect, its real known_hosts) straight to hop N+1, and recursively
 * wrap it in another SshInteractiveSubShell (see startNestedHop()) — the
 * exact same construction LinuxTerminalSession.connectAndEnterSsh() uses
 * for the first hop. Password/host-key prompts during that connect are
 * bridged to the SAME pendingInput/handleInput broker `su` uses, via
 * HopInteractionHandler (an ISshInteractionHandler whose prompt methods
 * return a promise this class resolves itself once the value arrives).
 * Once connected, every subsequent line/Ctrl+C/dispose delegates to the
 * nested instance until it reports `exit` (the user typed `exit` at hop
 * N+1), at which point control returns to this level.
 *
 * Still out of scope: multi-turn REPLs that aren't a single password
 * challenge (`sqlplus`, RMAN, `sftp`/`ftp` sub-shells, `vim`/`nano`) — those
 * relied on the old in-memory createSessionForDevice() bypass instantiating
 * a full client-side LinuxTerminalSession with its own SqlPlusSubShell/
 * editor machinery bound directly to the remote Equipment. `sudo`/`passwd`/
 * `adduser` could reuse the same single-password broker `su` and nested
 * ssh both use, but no current use case exercises them here yet.
 *
 * Reference: BRD-SSH-SFTP.md SSH-04.
 */

import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import { Equipment } from '@/network';
import { LinuxMachine } from '@/network/devices/LinuxMachine';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import type { ISshSession } from '@/network/protocols/ssh/session/ISshSession';
import type { ISshShellChannel } from '@/network/protocols/ssh/channels/ISshChannel';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { isOk } from '@/network/protocols/ssh/Result';
import {
  type HostKeyResponse,
  type ISshInteractionHandler,
  type SshConnectionInfo,
  hostKeyFingerprint,
  hostKeyNo,
  hostKeyYes,
} from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { composeSshLoginBanner } from '@/network/protocols/ssh/loginBanner';

/** Mirrors LinuxInteractionPlanner.ts's MAX_SU_ATTEMPTS (real su retries 3x). */
const MAX_SU_ATTEMPTS = 3;

/** Single-quote a value for safe use inside the remote `printf '%s\n' '<x>' | su` pipe. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Minimal in-process equivalent of LinuxTerminalSession's findLinuxMachineByIp(). */
function findLinuxMachineByIp(targetIp: string): LinuxMachine | null {
  const all = (Equipment as unknown as { getAllEquipment: () => unknown[] }).getAllEquipment();
  for (const eq of all) {
    if (!(eq instanceof LinuxMachine)) continue;
    const ports = (eq as unknown as { ports?: Map<string, { getIPAddress: () => { toString(): string } | null }> }).ports;
    if (!ports) continue;
    for (const port of ports.values()) {
      const ip = port.getIPAddress?.();
      if (ip && ip.toString() === targetIp) return eq;
    }
  }
  return null;
}

/**
 * Bridges SshSession's interactive callbacks (password / host-key
 * confirmation) to whoever is driving a nested hop's connect: prompt
 * methods return a promise that only resolves once `answer()` is called
 * from the outside (fed by the host terminal's pendingInput/handleInput
 * broker, exactly like `su`'s password round trip).
 */
class HopInteractionHandler implements ISshInteractionHandler {
  private pendingPasswordResolve: ((v: string) => void) | null = null;
  private pendingHostKeyResolve: ((v: HostKeyResponse) => void) | null = null;
  private waiters: Array<(p: { kind: 'password' | 'text'; promptText: string }) => void> = [];
  private readonly infoLines: string[] = [];

  /** Resolves the next time a prompt method is called. */
  waitForPrompt(): Promise<{ kind: 'password' | 'text'; promptText: string }> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private signal(p: { kind: 'password' | 'text'; promptText: string }): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(p);
  }

  promptPassword(user: string, host: string): Promise<string> {
    return new Promise((resolve) => {
      this.pendingPasswordResolve = resolve;
      this.signal({ kind: 'password', promptText: `${user}@${host}'s password:` });
    });
  }

  promptHostKeyConfirmation(host: string, fingerprint: string): Promise<HostKeyResponse> {
    return new Promise((resolve) => {
      this.pendingHostKeyResolve = resolve;
      this.signal({
        kind: 'text',
        promptText:
          `The authenticity of host '${host}' can't be established.\n` +
          `ED25519 key fingerprint is SHA256:${fingerprint}.\n` +
          `Are you sure you want to continue connecting (yes/no/[fingerprint])?`,
      });
    });
  }

  /** Feed the value the host terminal collected back into whichever prompt is pending. */
  answer(value: string): void {
    if (this.pendingHostKeyResolve) {
      const resolve = this.pendingHostKeyResolve;
      this.pendingHostKeyResolve = null;
      const v = value.trim().toLowerCase();
      resolve(v === 'yes' ? hostKeyYes() : v === 'no' ? hostKeyNo() : hostKeyFingerprint(value.trim()));
      return;
    }
    if (this.pendingPasswordResolve) {
      const resolve = this.pendingPasswordResolve;
      this.pendingPasswordResolve = null;
      resolve(value);
    }
  }

  showWarning(message: string): void { this.infoLines.push(message); }
  showInfo(message: string): void { this.infoLines.push(message); }
  onConnected(_info: SshConnectionInfo): void { /* banner handled by composeSshLoginBanner instead */ }

  drainInfoLines(): string[] {
    const lines = this.infoLines.splice(0, this.infoLines.length);
    return lines.flatMap((m) => m.replace(/\n+$/, '').split('\n')).filter((l) => l.length > 0);
  }
}

interface PendingHopConnect {
  readonly targetUser: string;
  readonly targetHost: string;
  readonly interaction: HopInteractionHandler;
  readonly connectResult: Promise<ReturnType<ISshSession['connect']>>;
  readonly session: SshSession;
}

export class SshInteractiveSubShell implements ISubShell {
  readonly kind = 'ssh-interactive-shell';
  readonly connection = 'ssh' as const;
  private cwd: string;
  /** True while a runLine() call is outstanding (streaming or not). */
  private inFlight = false;
  /** Set while `su`'s password broker is waiting on handleInput(). */
  private pendingSu: { targetUser: string; attemptsLeft: number } | null = null;
  /** Set while a nested `ssh`'s connect handshake is awaiting a password/host-key answer. */
  private pendingHopConnect: PendingHopConnect | null = null;
  /** A fully-connected nested hop: once set, every call delegates to it. */
  private nestedHop: SshInteractiveSubShell | null = null;

  /** Latest prompt the remote published, or null while it has published none. */
  private serverPrompt: string | null = null;

  /**
   * True while an interpreter pushed on the server side of the wire
   * (SQL*Plus, RMAN, PowerShell, …) owns the remote's input.
   */
  private serverNested = false;

  /** Every line goes through here so the remote's prompt is never missed. */
  private async run(line: string) {
    const result = await this.channel.runLine(line);
    if (result.prompt) this.serverPrompt = result.prompt;
    this.serverNested = result.nested === true;
    return result;
  }

  constructor(
    private readonly session: ISshSession,
    private readonly channel: ISshShellChannel,
    private readonly remoteUser: string,
    /** Connection address as given on the command line — used verbatim in
     *  OpenSSH-style messages ("Connection to X closed."), matching real
     *  ssh which never substitutes the remote's own hostname there. */
    private readonly remoteHost: string,
    initialCwd: string = '~',
    private readonly onDispose?: () => void,
    /** The remote's own hostname (bash PS1's `\h`) for the prompt —
     *  defaults to `remoteHost` when the caller has no better value
     *  (e.g. a bare SshServerHandler in tests with no resolvable device). */
    private readonly promptHost: string = remoteHost,
    /** The LinuxMachine this instance's channel/session connects TO — its
     *  own tcpConnect/vfs/userMgr are what a *nested* ssh typed inside
     *  this session needs to open the next hop from. Undefined disables
     *  nested-ssh support (falls through to the generic passthrough). */
    private readonly remoteDevice?: LinuxMachine,
    /** Liveness of the transport, probed before each command on the same
     *  wire the session was opened on. Omitted means "never check"
     *  (docs/PRD-Link-State.md §3.3). */
    private readonly probeAlive?: () => boolean,
  ) {
    this.cwd = initialCwd === '~' ? `/home/${remoteUser}` : initialCwd;
  }

  getPrompt(): string {
    if (this.nestedHop) return this.nestedHop.getPrompt();
    // The remote's own prompt when it published one: it knows the real
    // home (which may not be /home/<user>, or may not exist at all) and,
    // for a router, the current CLI mode. The local guess below is only
    // a fallback for servers that publish nothing.
    if (this.serverPrompt !== null) return this.serverPrompt;
    const homeDir = `/home/${this.remoteUser}`;
    const cwdShort = this.cwd === homeDir ? '~' : this.cwd;
    return `${this.remoteUser}@${this.promptHost}:${cwdShort}$ `;
  }

  /**
   * Tab candidates answered by the remote over the channel, so they
   * reflect its commands, filesystem and CLI mode. A nested hop answers
   * for its own level.
   */
  async getCompletionsAsync(line: string): Promise<string[]> {
    if (this.nestedHop) return this.nestedHop.getCompletionsAsync(line);
    if (this.inFlight) return [];
    return this.channel.complete(line);
  }

  /** True when `?` is a help key on this remote rather than a plain character. */
  supportsInlineHelp(): boolean {
    if (this.nestedHop) return this.nestedHop.supportsInlineHelp();
    return this.channel.supportsInlineHelp();
  }

  /**
   * The help the device would print for `<line>?`, without consuming the
   * line the user is composing or changing the CLI mode.
   */
  async inlineHelpAsync(line: string): Promise<string[]> {
    if (this.nestedHop) return this.nestedHop.inlineHelpAsync(line);
    if (this.inFlight) return [];
    const result = await this.run(`${line}?`);
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    return text.split('\n').filter((l) => l.length > 0);
  }

  /** Ctrl+D exits the sub-shell. */
  handleKey(e: KeyEvent): boolean {
    if (this.nestedHop) return this.nestedHop.handleKey(e);
    return e.key === 'd' && e.ctrlKey;
  }

  /**
   * Ctrl+C: forward a real SIGINT over the wire to whatever is running on
   * this channel. Returns false (host falls back to its default local-only
   * "clear input, echo ^C") when nothing is actually in flight.
   */
  interruptForeground(): boolean {
    if (this.nestedHop) return this.nestedHop.interruptForeground();
    if (!this.inFlight) return false;
    this.channel.sendSignal('SIGINT');
    return true;
  }

  async processLine(line: string, onProgress?: (text: string) => void): Promise<SubShellResult> {
    if (this.nestedHop) {
      const result = await this.nestedHop.processLine(line, onProgress);
      return this.afterNestedResult(result);
    }

    if (this.probeAlive && !this.probeAlive()) {
      this.session.disconnect();
      return {
        output: ['client_loop: send disconnect: Broken pipe'],
        exit: true,
        prompt: '',
      };
    }

    if (this.inFlight) {
      // Mirror the local terminal's hasForegroundAsyncJob guard: a
      // streaming job (e.g. ping) already owns this channel's one
      // outstanding runLine() slot — swallow Enter as a blank line
      // rather than racing a second runLine() call against it.
      return done([''], this.getPrompt());
    }

    const trimmed = line.trim();

    // `exit` belongs to whichever shell owns the remote's input. While
    // an interpreter is stacked server-side it pops that interpreter, so
    // the line has to travel the wire like any other
    // (docs/PRD-SSH-Unification.md §4bis B2); only the login shell's own
    // `exit` ends the session.
    if ((trimmed === 'exit' || trimmed === 'logout') && !this.serverNested) {
      this.session.disconnect();
      return {
        output: ['logout', `Connection to ${this.remoteHost} closed.`],
        exit: true,
        prompt: '',
      };
    }

    if (!trimmed) return done([''], this.getPrompt());

    // clear: signal the host terminal to wipe the screen (Ctrl+L also works)
    if (trimmed === 'clear') {
      return { output: [''], exit: false, prompt: this.getPrompt(), clearScreen: true };
    }

    // cd: tracked client-side purely so the prompt shows the right cwd —
    // the server's persistent shell session is the real cwd authority and
    // needs no prefixing trick (unlike RemoteShellSubShell's exec channels).
    if (/^cd(\s|$)/.test(trimmed)) {
      return this.handleCd(trimmed);
    }

    // su [-|-l|--login] [user]: no `-c` (that's a single non-interactive
    // command, left to the generic path below). Real su always prompts
    // for a password unless the caller is already root — this simulator
    // has no client-side notion of "am I root", so we always challenge;
    // beginSuSession() itself no-ops the check when currentUid is 0.
    const suMatch = /^su(?:\s+(?:-l|--login|-))?(?:\s+(\S+))?$/.exec(trimmed);
    if (suMatch) {
      this.pendingSu = { targetUser: suMatch[1] ?? 'root', attemptsLeft: MAX_SU_ATTEMPTS };
      return {
        output: [], exit: false, prompt: this.getPrompt(),
        pendingInput: { kind: 'password', promptText: 'Password:' },
      };
    }

    // Bare `ssh [user@]host` — a real second hop (see class docs). Flagged
    // or exec-mode ("ssh host cmd") invocations fall through to the
    // generic passthrough below, unchanged.
    const sshMatch = this.remoteDevice && /^ssh\s+(?:(\S+)@)?(\S+)$/.exec(trimmed);
    if (sshMatch) {
      return this.startNestedHop(sshMatch[1] ?? this.remoteUser, sshMatch[2]);
    }

    const collected: string[] = [];
    const emit = (chunk: string): void => {
      const lines = chunk.replace(/\n$/, '').split('\n');
      for (const l of lines) {
        if (onProgress) onProgress(l);
        else collected.push(l);
      }
    };
    const off = this.channel.onData(emit);
    this.inFlight = true;
    try {
      await this.run(trimmed);
    } finally {
      this.inFlight = false;
      off();
    }
    // Every line of output — streamed chunks and the final one-shot merged
    // reply alike — already reached the terminal via emit()/onProgress
    // above; `output` only needs to carry it when nobody wanted progress.
    if (onProgress) return { output: [], exit: false, prompt: this.getPrompt() };
    return done(collected.length ? collected : [''], this.getPrompt());
  }

  /** Feed a value the host collected for a pending su / nested-ssh challenge. */
  async handleInput(value: string): Promise<SubShellResult> {
    if (this.nestedHop) {
      const result = await this.nestedHop.handleInput(value);
      return this.afterNestedResult(result);
    }

    if (this.pendingHopConnect) {
      this.pendingHopConnect.interaction.answer(value);
      return this.pumpHopConnect(this.pendingHopConnect);
    }

    const su = this.pendingSu;
    if (su) {
      su.attemptsLeft -= 1;
      const target = su.targetUser === 'root' ? '' : ` ${su.targetUser}`;
      this.inFlight = true;
      let result;
      try {
        result = await this.run(`printf '%s\\n' ${shQuote(value)} | su${target}`);
      } finally {
        this.inFlight = false;
      }

      const failed = /Authentication failure/.test(result.stdout + result.stderr);
      if (!failed) {
        this.pendingSu = null;
        return done([''], this.getPrompt());
      }
      if (su.attemptsLeft > 0) {
        return {
          output: ['su: Authentication failure'], exit: false, prompt: this.getPrompt(),
          pendingInput: { kind: 'password', promptText: 'Password:' },
        };
      }
      this.pendingSu = null;
      return done(['su: Authentication failure'], this.getPrompt());
    }

    return done([''], this.getPrompt());
  }

  dispose(): void {
    this.nestedHop?.dispose();
    this.channel.close();
    if (this.onDispose) this.onDispose();
    else this.session.disconnect();
  }

  // ─── private ────────────────────────────────────────────────────

  /**
   * A nested hop's result bubbles up almost unchanged — its own `prompt`
   * already reflects its own getPrompt(). The one thing this level owns:
   * when the nested hop reports `exit` (the user typed `exit` AT that
   * hop), that must pop back to THIS level, not propagate further up as
   * if the whole outer session were closing.
   */
  private afterNestedResult(result: SubShellResult): SubShellResult {
    if (result.exit) {
      this.nestedHop = null;
      return { output: result.output, exit: false, prompt: this.getPrompt() };
    }
    return result;
  }

  /** Run `<cdCmd> && pwd`; the last stdout line becomes the new cwd. */
  private async handleCd(cdCmd: string): Promise<SubShellResult> {
    this.inFlight = true;
    let result;
    try {
      result = await this.run(`${cdCmd} && pwd`);
    } finally {
      this.inFlight = false;
    }

    const succeeded = result.exitCode === 0 || (!result.stderr && result.stdout.trim().startsWith('/'));
    if (succeeded) {
      const lines = result.stdout.trim().split('\n');
      const newCwd = lines[lines.length - 1];
      if (newCwd && newCwd.startsWith('/')) this.cwd = newCwd;
      return done([''], this.getPrompt());
    }

    const errLines = result.stderr
      ? result.stderr.replace(/\n$/, '').split('\n')
      : ['cd: no such file or directory'];
    return done(errLines, this.getPrompt());
  }

  /**
   * Open a real second hop FROM this instance's own device (remoteDevice)
   * to targetHost — the same construction connectAndEnterSsh() uses for
   * the first hop, just originating from the remote instead of the local
   * terminal. Real password/host-key prompts during connect are bridged
   * via HopInteractionHandler + pumpHopConnect() to this sub-shell's own
   * pendingInput/handleInput broker.
   */
  private async startNestedHop(targetUser: string, targetHost: string): Promise<SubShellResult> {
    const dev = this.remoteDevice as unknown as {
      tcpConnect: (host: string, port: number) => Promise<unknown>;
      executor?: {
        vfs?: unknown;
        userMgr?: { getUser(name: string): { uid?: number; gid?: number; home?: string } | undefined };
      };
    };
    const userEntry = dev.executor?.userMgr?.getUser(this.remoteUser);
    const homeDir = userEntry?.home ?? `/home/${this.remoteUser}`;
    const localVfs = dev.executor?.vfs;
    if (!localVfs) return done([`ssh: ${this.promptHost} does not support nested SSH`], this.getPrompt());

    const interaction = new HopInteractionHandler();
    const session2 = new SshSession({
      tcpConnector: (host, port) => dev.tcpConnect(host, port) as ReturnType<typeof dev.tcpConnect> as never,
      vfs: localVfs as never,
      localUser: this.remoteUser,
      localUid: userEntry?.uid ?? 1000,
      localGid: userEntry?.gid ?? 1000,
      knownHostsPath: `${homeDir}/.ssh/known_hosts`,
      interactionHandler: interaction,
    });
    const opts = SshConnectOptionsBuilder.create()
      .host(targetHost).user(targetUser).port(22)
      .strictHostKeyChecking('accept-new')
      .build();

    const pending: PendingHopConnect = {
      targetUser, targetHost, interaction, session: session2,
      connectResult: session2.connect(opts),
    };
    this.pendingHopConnect = pending;
    return this.pumpHopConnect(pending);
  }

  /**
   * Race the connect's own settlement against the interaction handler
   * wanting the next prompt answered — whichever happens first. Called
   * once to start, and again from handleInput() every time a password/
   * host-key answer arrives, until the connect either fails or succeeds.
   */
  private async pumpHopConnect(pending: PendingHopConnect): Promise<SubShellResult> {
    const outcome = await Promise.race([
      pending.connectResult.then((r) => ({ kind: 'settled' as const, result: r })),
      pending.interaction.waitForPrompt().then((p) => ({ kind: 'prompt' as const, prompt: p })),
    ]);

    if (outcome.kind === 'prompt') {
      return {
        output: [], exit: false, prompt: this.getPrompt(),
        pendingInput: { kind: outcome.prompt.kind, promptText: outcome.prompt.promptText },
      };
    }

    this.pendingHopConnect = null;
    const infoLines = pending.interaction.drainInfoLines();
    if (!isOk(outcome.result)) {
      const err = outcome.result.error;
      const lines = [...infoLines];
      // AUTH_FAILED's "Permission denied (...)." is already pushed into
      // infoLines by SshSession.doAuthenticate() via showWarning() — don't
      // duplicate it (mirrors connectAndEnterSsh()'s own error handling).
      if (err.kind !== 'AUTH_FAILED') {
        lines.push(
          err.kind === 'CONNECTION_REFUSED'
            ? `ssh: connect to host ${pending.targetHost} port 22: Connection refused`
            : err.kind === 'HOST_KEY_REJECTED' || err.kind === 'HOST_KEY_CHANGED'
            ? 'Host key verification failed.'
            : `${pending.targetUser}@${pending.targetHost}: Permission denied (publickey,password).`,
        );
      }
      return done(lines, this.getPrompt());
    }

    const channelResult = pending.session.openShellChannel();
    if (!isOk(channelResult)) {
      pending.session.disconnect();
      return done([...infoLines, 'ssh: failed to open shell channel'], this.getPrompt());
    }

    const targetDevice = findLinuxMachineByIp(pending.targetHost);
    const sourceIp = this.firstDeviceIp(this.remoteDevice) ?? '0.0.0.0';
    const banner = targetDevice
      ? composeSshLoginBanner(targetDevice, pending.targetUser, sourceIp, this.promptHost, false)
      : [];

    this.nestedHop = new SshInteractiveSubShell(
      pending.session, channelResult.value, pending.targetUser, pending.targetHost,
      `/home/${pending.targetUser}`,
      () => pending.session.disconnect(),
      targetDevice?.getSshHostname() ?? pending.targetHost,
      targetDevice ?? undefined,
    );
    return done([...infoLines, ...banner], this.getPrompt());
  }

  private firstDeviceIp(device: LinuxMachine | undefined): string | null {
    const ports = (device as unknown as { getPorts?: () => Array<{ getIPAddress: () => { toString(): string } | null; getIsUp: () => boolean }> } | undefined)?.getPorts?.();
    if (!ports) return null;
    for (const port of ports) {
      const ip = port.getIPAddress();
      if (ip && port.getIsUp()) return ip.toString();
    }
    return null;
  }
}

function done(output: string[], prompt: string): SubShellResult {
  return { output, exit: false, prompt };
}
