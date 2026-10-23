/**
 * LinuxBashShell — concrete shell that runs bash on a Linux machine.
 *
 * Adapter over the legacy LinuxCommandExecutor: every line is forwarded
 * to the device's `executeCommand`, the result is split into output
 * lines, and known sub-shell launchers (`sqlplus`, `rman`, `python3`,
 * …) are intercepted so the right child shell can be pushed onto the
 * Shell stack rather than just printing their banner.
 *
 * Design pattern: **Adapter** — preserves the existing dispatch path
 * without ripping it out; the Shell layer is a thin facade.
 */

import { AbstractShell, type AbstractShellOptions } from '../AbstractShell';
import type { ShellLineResult } from '../IShell';
import { ShellFactory } from '../ShellFactory';
import { parseReadInvocation, performInteractiveRead } from '../input';
import { NestedSshLogin } from '../NestedSshLogin';
import { echoesInput } from '@/network/devices/linux/tty/TtyLineDiscipline';

import { LinuxMachine } from '@/network/devices/LinuxMachine';
import type { LinuxShellSession } from '@/network/devices/linux/shell/LinuxShellSession';
import { nextLineId } from '@/terminal/sessions/TerminalSession';
import { parseAnsiToSegments } from '@/terminal/core/OutputFormatter';
import type { RichOutputLine } from '@/terminal/core/types';


export interface LinuxBashShellOptions extends AbstractShellOptions {
  /**
   * Pre-existing per-terminal shell session. When supplied (typically by
   * `LinuxTerminalSession`, which already owns one for state isolation),
   * the shell DOES NOT open its own — it shares the caller's session so
   * cwd / env / suStack updates propagate to whoever owns it.
   */
  readonly preexistingSession?: LinuxShellSession | null;
  /**
   * When `preexistingSession` is supplied, this shell must not close it
   * on dispose (the owner is responsible). Defaults to false so legacy
   * call sites that omit this flag keep the old close-on-dispose behaviour.
   */
  readonly ownsSession?: boolean;
  /** OpenSSH-style SSH_CONNECTION string — set on the session env. */
  readonly sshConnection?: string;
  /** OpenSSH-style SSH_CLIENT string — set on the session env. */
  readonly sshClient?: string;
}

interface LinuxDevice {
  executeCommand(cmd: string): Promise<string>;
  executeCommandInSession?(cmd: string, s: LinuxShellSession): Promise<string>;
  getHostname(): string;
}

export class LinuxBashShell extends AbstractShell {
  readonly kind = 'bash';

  private session: LinuxShellSession | null = null;
  private readonly ownsSession: boolean;
  /** Pending nested-ssh auth waiting for the user's password. */
  private readonly nestedSsh = new NestedSshLogin();
  /** Remote command to exec after auth (exec mode); null = push a shell. */
  /** Per-shell known_hosts tracker — first connection prints the warning. */

  constructor(opts: LinuxBashShellOptions) {
    super(opts);
    if (opts.preexistingSession) {
      this.session = opts.preexistingSession;
      this.ownsSession = opts.ownsSession ?? false;
    } else if (opts.device instanceof LinuxMachine) {
      this.session = opts.device.openShellSession({
        user: opts.user,
        cwd: opts.context.cwd,
      });
      this.ownsSession = true;
      // Inject OpenSSH-style env vars when this shell is the remote side
      // of an SSH connection. `echo $SSH_CONNECTION` on the remote then
      // returns the same shape as real ssh: "client_ip client_port
      // server_ip server_port".
      if (opts.sshConnection) this.session.env.set('SSH_CONNECTION', opts.sshConnection);
      if (opts.sshClient) this.session.env.set('SSH_CLIENT', opts.sshClient);
      if (opts.connection === 'ssh') this.session.env.set('SSH_TTY', `/dev/${this.session.tty}`);
    } else {
      this.ownsSession = false;
    }
    if (opts.device instanceof LinuxMachine) {
      const um = (opts.device as unknown as { executor: { userMgr: { getUser: (n: string) => { uid?: number; gid?: number } | undefined } } })
        .executor.userMgr;
      const u = um.getUser(opts.user);
      if (u) {
        this.context.credentials = {
          ...this.context.credentials,
          uid: u.uid ?? this.context.credentials.uid,
          gid: u.gid ?? this.context.credentials.gid,
          euid: u.uid ?? this.context.credentials.euid,
          egid: u.gid ?? this.context.credentials.egid,
        };
      }
    }
  }

  override getActivationBanner(): readonly string[] {
    return [];
  }

  override getDeactivationBanner(): readonly string[] {
    return ['logout'];
  }

  /** Real bash recognises `clear` and `reset`, NOT `cls`. */
  protected override clearWords: ReadonlySet<string> = new Set(['clear', 'reset']);

  /**
   * Completion runs in THIS bash's session context (cwd / env / suStack)
   * so path completion sees the per-shell cwd, not the device-wide
   * default. Without this override, an SSH'd bash sitting in /etc would
   * complete relative to the device's local-console cwd — a bleed
   * regression equivalent to the per-terminal cwd issue
   * `terminal_gap.md §6` describes for Windows.
   */
  override getCompletions(line: string): readonly string[] {
    const dev = this.device as unknown as {
      getCompletionsForSession?: (p: string, s: LinuxShellSession) => string[];
      getCompletions?: (p: string) => string[];
    };
    if (this.session && dev.getCompletionsForSession) {
      return dev.getCompletionsForSession(line, this.session);
    }
    return dev.getCompletions ? dev.getCompletions(line) : [];
  }

  protected async dispatch(line: string): Promise<ShellLineResult> {
    const readIntercept = await this.tryInteractiveRead(line);
    if (readIntercept) return readIntercept;

    // Sub-shell launch intercept: a real Linux box would exec the
    // binary and hand the tty to it. Here we push the registered Shell
    // adapter for that interpreter pointed at the same device, so the
    // user lands in the child's real prompt instead of a single-shot
    // command transcript.
    const subShellKind = ShellFactory.launcherKindFor(line, this.kind);
    if (subShellKind) {
      const child = ShellFactory.tryCreateChild(subShellKind, {
        device: this.device,
        user: this.user,
        parent: this,
        launchLine: line,
      });
      if (child) {
        // Some adapters (SqlPlusShell, RmanShell) expose `isReady` and
        // refuse to be pushed against a device that lacks the backing
        // service. Mirror real bash by emitting "command not found".
        const ready = (child as unknown as { isReady?: boolean }).isReady;
        if (ready === false) {
          child.dispose();
          return { output: [`bash: ${subShellKind}: command not found`] };
        }
        return { output: [], childShell: child };
      }
      // Fall through if no adapter is registered — print the legacy
      // device output (banner / error) like the simulator did before.
    }

    const ssh = await this.nestedSsh.launch(line, {
      defaultUser: this.user,
      sourceIp: firstConfiguredIp(this.device),
      sourceHostname: (this.device as unknown as { getHostname?: () => string }).getHostname?.(),
      sourceDevice: this.device,
    }, this.input);
    if (ssh) return ssh;

    const dev = this.device as unknown as LinuxDevice;
    const raw = (this.session && this.device instanceof LinuxMachine
      && dev.executeCommandInSession)
      ? await dev.executeCommandInSession(line, this.session)
      : await dev.executeCommand(line);
    if (this.session) {
      this.context.cwd = this.session.cwd;
    }
    const output = this.splitOutput(raw);
    // Bash output may carry ANSI escape codes (ls --color, grep --color,
    // git, …). The shell — not the host terminal — owns its rendering, so
    // we parse the codes once here and forward pre-styled segments. The
    // host terminal renders them verbatim regardless of vendor; this is
    // what fixes "raw [1;36m on Windows over SSH".
    const styledOutput: RichOutputLine[] = output.map((line) => ({
      id: nextLineId(),
      segments: parseAnsiToSegments(line),
      lineType: 'output',
    }));
    // Plain text (for transcripts, recording) strips the ANSI escapes
    // so the recorded session reads cleanly without control bytes.
    const plain = output.map(stripAnsi);
    return { output: plain, styledOutput };
  }

  getPrompt(): string {
    const dev = this.device as unknown as { getHostname(): string };
    const host = dev.getHostname() || 'localhost';
    const home = `/home/${this.user}`;
    const cwd = this.session?.cwd ?? this.context.cwd;
    const cwdShort = cwd === home ? '~' : cwd;
    const ch = this.context.credentials.euid === 0 ? '#' : '$';
    return `${this.user}@${host}:${cwdShort}${ch} `;
  }

  protected override onDispose(): void {
    if (this.session && this.device instanceof LinuxMachine && this.ownsSession) {
      this.device.closeShellSession(this.session);
    }
  }

  private splitOutput(s: string): string[] {
    if (!s) return [];
    return s.replace(/\n+$/, '').split('\n');
  }

  private async tryInteractiveRead(line: string): Promise<ShellLineResult | null> {
    if (!this.input.capabilities().interactive) return null;
    const trimmed = line.trim();
    if (!/^read\b/.test(trimmed)) return null;
    if (/[|<>]/.test(trimmed)) return null;
    const typed = parseReadInvocation(trimmed);
    if (!typed) return null;
    const echoing = this.session === null || echoesInput(this.session.ttyDevice.tcgetattr());
    const parsed = { ...typed, silent: typed.silent || !echoing };
    const ifs = this.session?.env.get('IFS') ?? ' \t\n';
    const outcome = await performInteractiveRead(this.input, parsed, { ifs });
    if (!outcome.handled) return null;
    if (!this.session) return { output: [] };
    if (outcome.cancelled) { this.session.env.set('?', '130'); return { output: [] }; }
    for (const b of outcome.bindings ?? []) this.session.env.set(b.name, b.value);
    this.session.env.set('?', '0');
    return { output: [] };
  }

  async handleInput(value: string): Promise<ShellLineResult> {
    return this.nestedSsh.answer(value);
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string { return s.replace(ANSI_REGEX, ''); }

/** First configured IP of a device — used to label SSH source addresses. */
function firstConfiguredIp(dev: unknown): string | undefined {
  const ports = (dev as { ports?: Map<string, { getIPAddress: () => { toString(): string } | null }> }).ports;
  if (!ports) return undefined;
  for (const port of ports.values()) {
    const ip = port.getIPAddress?.();
    if (ip) return ip.toString();
  }
  return undefined;
}
