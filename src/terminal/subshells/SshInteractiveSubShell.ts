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
 * Known, accepted limitation: commands that are themselves a multi-turn
 * REPL rather than a single password challenge — `sqlplus`, RMAN, `sftp`/
 * `ftp` sub-shells, `vim`/`nano`, a *nested* `ssh` typed from inside this
 * session — do NOT work here. Those relied on the old in-memory
 * createSessionForDevice() bypass instantiating a full client-side
 * LinuxTerminalSession (with its own SqlPlusSubShell/editor/nested-SSH
 * machinery) bound directly to the remote Equipment; a real wire-only
 * session has no such client-side stand-in, and turning each of those
 * into its own wire-driven protocol is out of scope here. `sudo`/`passwd`/
 * `adduser` are equally out of scope for now (same broker mechanism could
 * cover `sudo`/`passwd`'s single-password case like `su` does, but no
 * current use case exercises them over a real-wire session).
 *
 * Reference: BRD-SSH-SFTP.md SSH-04.
 */

import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import type { ISshSession } from '@/network/protocols/ssh/session/ISshSession';
import type { ISshShellChannel } from '@/network/protocols/ssh/channels/ISshChannel';

/** Mirrors LinuxInteractionPlanner.ts's MAX_SU_ATTEMPTS (real su retries 3x). */
const MAX_SU_ATTEMPTS = 3;

/** Single-quote a value for safe use inside the remote `printf '%s\n' '<x>' | su` pipe. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export class SshInteractiveSubShell implements ISubShell {
  readonly kind = 'ssh-interactive-shell';
  readonly connection = 'ssh' as const;
  private cwd: string;
  /** True while a runLine() call is outstanding (streaming or not). */
  private inFlight = false;
  /** Set while `su`'s password broker is waiting on handleInput(). */
  private pendingSu: { targetUser: string; attemptsLeft: number } | null = null;

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
  ) {
    this.cwd = initialCwd === '~' ? `/home/${remoteUser}` : initialCwd;
  }

  getPrompt(): string {
    const homeDir = `/home/${this.remoteUser}`;
    const cwdShort = this.cwd === homeDir ? '~' : this.cwd;
    return `${this.remoteUser}@${this.promptHost}:${cwdShort}$ `;
  }

  /** Ctrl+D exits the sub-shell. */
  handleKey(e: KeyEvent): boolean {
    return e.key === 'd' && e.ctrlKey;
  }

  /**
   * Ctrl+C: forward a real SIGINT over the wire to whatever is running on
   * this channel. Returns false (host falls back to its default local-only
   * "clear input, echo ^C") when nothing is actually in flight.
   */
  interruptForeground(): boolean {
    if (!this.inFlight) return false;
    this.channel.sendSignal('SIGINT');
    return true;
  }

  async processLine(line: string, onProgress?: (text: string) => void): Promise<SubShellResult> {
    if (this.inFlight) {
      // Mirror the local terminal's hasForegroundAsyncJob guard: a
      // streaming job (e.g. ping) already owns this channel's one
      // outstanding runLine() slot — swallow Enter as a blank line
      // rather than racing a second runLine() call against it.
      return done([''], this.getPrompt());
    }

    const trimmed = line.trim();

    if (trimmed === 'exit' || trimmed === 'logout') {
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
      await this.channel.runLine(trimmed);
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

  /** Feed the password the host collected for `su`'s pendingInput challenge. */
  async handleInput(value: string): Promise<SubShellResult> {
    const su = this.pendingSu;
    if (!su) return done([''], this.getPrompt());
    su.attemptsLeft -= 1;

    const target = su.targetUser === 'root' ? '' : ` ${su.targetUser}`;
    this.inFlight = true;
    let result;
    try {
      result = await this.channel.runLine(`printf '%s\\n' ${shQuote(value)} | su${target}`);
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

  dispose(): void {
    this.channel.close();
    if (this.onDispose) this.onDispose();
    else this.session.disconnect();
  }

  // ─── private ────────────────────────────────────────────────────

  /** Run `<cdCmd> && pwd`; the last stdout line becomes the new cwd. */
  private async handleCd(cdCmd: string): Promise<SubShellResult> {
    this.inFlight = true;
    let result;
    try {
      result = await this.channel.runLine(`${cdCmd} && pwd`);
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
}

function done(output: string[], prompt: string): SubShellResult {
  return { output, exit: false, prompt };
}
