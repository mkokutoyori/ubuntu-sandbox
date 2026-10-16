import type { ITerminalIO } from '../../session/TerminalSshInteractionHandler';
import { SftpClient, type SftpClientFlags, type SftpClientHost } from './SftpClient';
import { parseSftpCommandLine, type SftpCommandLine } from './SftpCommandLine';
import { SftpProtocolFailure, SftpWireClient, type SftpDiagnostics, type SftpPacketChannel } from './SftpWireClient';

export interface SftpConnectRequest {
  readonly sshArguments: readonly string[];
  readonly destination: string;
  readonly password: string | undefined;
  readonly verbose: boolean;
  readonly subsystem: string | null;
  readonly serverCommand: string | null;
  readonly io: ITerminalIO | null;
}

export type SftpConnection =
  | {
    readonly kind: 'connected';
    readonly channel: SftpPacketChannel;
    readonly release: () => void;
    readonly lines: readonly string[];
  }
  | { readonly kind: 'refused'; readonly lines: readonly string[]; readonly exitCode: number };

export interface SftpCommandHost extends SftpClientHost {
  readonly usage: string;
  readonly sshPrograms: readonly string[];
  readonly interactive: boolean;
  readonly stderrIsTerminal: boolean;
  readonly timeZoneOffsetMinutes: (atMs: number) => number;
  connect(request: SftpConnectRequest): Promise<SftpConnection>;
  attachServer(program: string): SftpPacketChannel | null;
  readBatch(path: string): { readonly content: string } | { readonly failure: string };
}

export interface SftpOutcome {
  readonly output: string;
  readonly exitCode: number;
}

const FATAL_EXIT = 255;

function clean(text: string): string {
  return text.replace(/\n$/, '');
}

function destinationText(line: SftpCommandLine): string {
  const destination = line.destination!;
  return destination.user === null ? destination.host : `${destination.user}@${destination.host}`;
}

export class SftpClientSession {
  private constructor(
    private readonly engine: SftpClient,
    private readonly line: SftpCommandLine,
    private readonly release: () => void,
    private readonly buffer: { text: string },
    private readonly startup: 'enter-loop' | 'done' | 'failed',
    readonly batchScript: string | null,
  ) {}

  static async open(
    args: readonly string[], host: SftpCommandHost, password: string | undefined, io: ITerminalIO | null = null,
  ): Promise<{ readonly kind: 'opened'; readonly session: SftpClientSession } | { readonly kind: 'ended'; readonly outcome: SftpOutcome }> {
    const parsed = parseSftpCommandLine(args);
    if (parsed.kind === 'usage') {
      return { kind: 'ended', outcome: { output: parsed.diagnostic === null ? host.usage : `${parsed.diagnostic}\n${host.usage}`, exitCode: 1 } };
    }
    if (parsed.kind === 'fatal') return { kind: 'ended', outcome: { output: clean(parsed.message), exitCode: FATAL_EXIT } };
    const line = parsed.line;
    let batchScript: string | null = null;
    if (line.batchFile !== null && line.batchFile !== '-') {
      const batch = host.readBatch(line.batchFile);
      if ('failure' in batch) {
        return { kind: 'ended', outcome: { output: `${batch.failure} (${line.batchFile}).`, exitCode: FATAL_EXIT } };
      }
      batchScript = batch.content;
    }
    const buffer = { text: '' };
    const emit = (text: string): void => { buffer.text += text; };
    if (line.sshProgram !== null && line.directServer === null && !host.sshPrograms.includes(line.sshProgram)) {
      return { kind: 'ended', outcome: { output: `exec: ${line.sshProgram}: No such file or directory\nConnection closed`, exitCode: FATAL_EXIT } };
    }
    let channel: SftpPacketChannel;
    let release: () => void = () => undefined;
    if (line.directServer !== null) {
      const attached = host.attachServer(line.directServer);
      if (attached === null) {
        return { kind: 'ended', outcome: { output: `exec: ${line.directServer}: No such file or directory\nConnection closed`, exitCode: FATAL_EXIT } };
      }
      channel = attached;
    } else {
      const shell = line.subsystem !== null && line.subsystem.includes('/');
      const connection = await host.connect({
        sshArguments: line.sshArguments,
        destination: destinationText(line),
        password,
        verbose: line.verbosity > 0,
        subsystem: shell ? null : (line.subsystem ?? 'sftp'),
        serverCommand: shell ? line.subsystem : null,
        io,
      });
      if (connection.kind === 'refused') {
        return {
          kind: 'ended',
          outcome: { output: [...connection.lines, 'Connection closed'].join('\n'), exitCode: FATAL_EXIT },
        };
      }
      emit(connection.lines.map((text) => `${text}\n`).join(''));
      channel = connection.channel;
      release = connection.release;
    }
    const diagnostics: SftpDiagnostics = {
      error: (text) => emit(`${text}\n`),
      notice: (text) => { if (!line.suppressNotices) emit(`${text}\n`); },
    };
    const flags: SftpClientFlags = {
      quiet: line.quiet,
      showProgress: line.showProgress && host.stderrIsTerminal,
      resumeAll: line.resumeAll,
      fsyncAll: line.fsyncAll,
      preserveAll: line.preserveAll,
      recursiveAll: line.recursiveAll,
      limitKbps: line.limitKbps,
      timeZoneOffsetMinutes: host.timeZoneOffsetMinutes,
    };
    const engine = new SftpClient(new SftpWireClient(channel, diagnostics), host, flags, diagnostics, emit);
    try {
      if (!engine.initialize()) {
        release();
        return { kind: 'ended', outcome: { output: clean(buffer.text), exitCode: FATAL_EXIT } };
      }
      if (!line.quiet) {
        emit(line.directServer === null ? `Connected to ${line.destination!.host}.\n` : `Attached to ${line.directServer}.\n`);
      }
      const startup = await engine.start(line.destination?.path ?? null, line.secondOperand);
      return { kind: 'opened', session: new SftpClientSession(engine, line, release, buffer, startup, batchScript) };
    } catch (failure) {
      release();
      if (failure instanceof SftpProtocolFailure) {
        emit(channel.remoteStderr ?? '');
        emit(`${failure.message}\n`);
        return { kind: 'ended', outcome: { output: clean(buffer.text), exitCode: FATAL_EXIT } };
      }
      throw failure;
    }
  }

  get finished(): boolean {
    return this.startup !== 'enter-loop';
  }

  drain(): string {
    const text = this.buffer.text;
    this.buffer.text = '';
    return text;
  }

  async execute(command: string, interactive: boolean): Promise<'continue' | 'quit' | 'abort'> {
    return this.engine.runLine(command, this.line.batchFile !== null, !interactive);
  }

  close(): void {
    this.release();
  }

  async runScript(script: string): Promise<SftpOutcome> {
    let failed = this.startup === 'failed';
    if (this.startup === 'enter-loop') {
      const lines = script.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      for (const text of lines) {
        const outcome = await this.execute(text, false);
        if (outcome === 'abort') {
          failed = true;
          break;
        }
        if (outcome === 'quit') break;
      }
    }
    this.close();
    return { output: clean(this.drain()), exitCode: failed ? 1 : 0 };
  }

}

export async function runSftpCommand(
  args: readonly string[], host: SftpCommandHost, password: string | undefined, standardInput: string,
): Promise<SftpOutcome> {
  const opened = await SftpClientSession.open(args, host, password);
  if (opened.kind === 'ended') return opened.outcome;
  const session = opened.session;
  try {
    return await session.runScript(session.batchScript ?? standardInput);
  } catch (failure) {
    session.close();
    if (failure instanceof SftpProtocolFailure) return { output: failure.message, exitCode: FATAL_EXIT };
    throw failure;
  }
}
