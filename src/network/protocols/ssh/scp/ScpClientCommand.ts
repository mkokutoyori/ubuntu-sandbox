import type { SshSession } from '../session/SshSession';
import type { ISftpFileSystem } from '../sftp/ISftpFileSystem';
import { parseScpEndpoint, type ScpEndpoint } from '../Scp';
import { parseScpCommandLine, type ScpCommandLine } from './ScpCommandLine';
import { memoryPipe, ScpPeer } from './ScpPeer';
import { peerFaultReporter, runScpSink, runScpSource, type ScpNamedPath, type ScpReporter, type ScpRoleEnvironment } from './ScpRoles';
import { scpProgressLine } from './ScpProgress';

export interface ScpConnectRequest {
  readonly sshArguments: readonly string[];
  readonly password: string | undefined;
  readonly remoteCommand: string;
  readonly verbose: boolean;
}

export type ScpConnection =
  | { readonly kind: 'connected'; readonly session: SshSession; readonly release: () => void; readonly lines: readonly string[] }
  | { readonly kind: 'refused'; readonly lines: readonly string[]; readonly exitCode: number };

export interface ScpClientHost {
  readonly local: ISftpFileSystem;
  readonly cwd: string;
  readonly usage: string;
  readonly sshPrograms: readonly string[];
  readonly umask: number;
  connect(request: ScpConnectRequest): Promise<ScpConnection>;
}

export interface ScpClientOutcome {
  readonly output: string;
  readonly exitCode: number;
}

const remoteScpCommand = (line: ScpCommandLine, extra: string): string =>
  `scp${line.verbosity > 0 ? ' -v' : ''}${line.recursive ? ' -r' : ''}${line.preserve ? ' -p' : ''}${extra}`;

function sshDestination(endpoint: ScpEndpoint): string {
  return endpoint.user === undefined ? endpoint.host! : `${endpoint.user}@${endpoint.host}`;
}

function scpSpecification(endpoint: ScpEndpoint): string {
  const host = endpoint.host!.includes(':') ? `[${endpoint.host}]` : endpoint.host!;
  return `${endpoint.user === undefined ? '' : `${endpoint.user}@`}${host}:${endpoint.path}`;
}

function quoteForRemoteShell(path: string): string {
  return path.startsWith('-') ? `-- ${path}` : path;
}

class ScpClientRun {
  readonly lines: string[] = [];
  exitCode = 0;

  constructor(
    private readonly host: ScpClientHost,
    private readonly line: ScpCommandLine,
    private readonly password: string | undefined,
  ) {}

  reporter(): ScpReporter {
    return {
      fault: (message) => { this.lines.push(`scp: ${message}`); },
      relay: (text) => { this.lines.push(text.replace(/\n$/, '')); },
      progress: (name, bytes) => {
        if (!this.line.quiet) this.lines.push(scpProgressLine(name, bytes, this.line.limitKbit));
      },
      lostConnection: () => { this.lines.push('lost connection'); },
    };
  }

  private environment(peer: ScpPeer): ScpRoleEnvironment {
    return {
      peer, fs: this.host.local, reporter: this.reporter(), umask: this.host.umask,
      recursive: this.line.recursive, preserve: this.line.preserve,
    };
  }

  private async open(endpoint: ScpEndpoint, remoteCommand: string): Promise<{ release: () => void; peer: ScpPeer } | null> {
    const connection = await this.host.connect({
      sshArguments: [...this.line.sshArguments, sshDestination(endpoint)],
      password: this.password,
      remoteCommand,
      verbose: this.line.verbosity > 0,
    });
    this.lines.push(...connection.lines);
    if (connection.kind === 'refused') {
      this.exitCode = connection.exitCode;
      return null;
    }
    const stream = await connection.session.openExecStream(remoteCommand);
    if (stream === null) {
      connection.release();
      this.lines.push('lost connection');
      this.exitCode = 1;
      return null;
    }
    return { release: connection.release, peer: new ScpPeer(stream) };
  }

  async upload(sources: readonly ScpEndpoint[], target: ScpEndpoint): Promise<void> {
    const command = `${remoteScpCommand(this.line, sources.length > 1 ? ' -d' : '')} -t ${quoteForRemoteShell(target.path)}`;
    const opened = await this.open(target, command);
    if (opened === null) return;
    const names: ScpNamedPath[] = sources.map((source) => ({
      shown: source.path, path: this.host.local.normalizePath(source.path, this.host.cwd),
    }));
    const code = await runScpSource(this.environment(opened.peer), names);
    opened.peer.close();
    opened.release();
    if (code !== 0) this.exitCode = 1;
  }

  async download(source: ScpEndpoint, target: ScpEndpoint): Promise<void> {
    const command = `${remoteScpCommand(this.line, '')} -f ${quoteForRemoteShell(source.path)}`;
    const opened = await this.open(source, command);
    if (opened === null) return;
    const destination: ScpNamedPath = { shown: target.path, path: this.host.local.normalizePath(target.path, this.host.cwd) };
    const code = await runScpSink(this.environment(opened.peer), destination);
    opened.peer.close();
    opened.release();
    if (code !== 0) this.exitCode = 1;
  }

  async copyLocally(sources: readonly ScpEndpoint[], target: ScpEndpoint): Promise<void> {
    const [sinkEnd, sourceEnd] = memoryPipe();
    const sinkPeer = new ScpPeer(sinkEnd);
    const sourcePeer = new ScpPeer(sourceEnd);
    const destination: ScpNamedPath = { shown: target.path, path: this.host.local.normalizePath(target.path, this.host.cwd) };
    const names: ScpNamedPath[] = sources.map((source) => ({
      shown: source.path, path: this.host.local.normalizePath(source.path, this.host.cwd),
    }));
    const sinkSide = runScpSink({ ...this.environment(sinkPeer), reporter: peerFaultReporter(sinkPeer) }, destination);
    const sourceSide = runScpSource(this.environment(sourcePeer), names).then((code) => {
      sourcePeer.close();
      return code;
    });
    const [sinkCode, sourceCode] = await Promise.all([sinkSide, sourceSide]);
    if (sinkCode !== 0 || sourceCode !== 0) this.exitCode = 1;
  }

  async relayThroughClient(source: ScpEndpoint, target: ScpEndpoint): Promise<void> {
    const reading = await this.open(source, `${remoteScpCommand(this.line, '')} -f ${quoteForRemoteShell(source.path)}`);
    if (reading === null) return;
    const writing = await this.open(target, `${remoteScpCommand(this.line, '')} -t ${quoteForRemoteShell(target.path)}`);
    if (writing === null) {
      reading.peer.close();
      reading.release();
      return;
    }
    reading.peer.relayTo(writing.peer);
    writing.peer.relayTo(reading.peer);
    await Promise.all([reading.peer.whenClosed(), writing.peer.whenClosed()]);
    reading.release();
    writing.release();
    const statuses = [reading.peer.exitStatus, writing.peer.exitStatus];
    if (statuses.some((status) => status !== null && status !== 0)) this.exitCode = 1;
  }

  async runOnSourceHost(sources: readonly ScpEndpoint[], target: ScpEndpoint): Promise<void> {
    const first = sources[0];
    const forwarded = `${remoteScpCommand(this.line, '')}${this.line.quiet ? ' -q' : ''}`;
    const destination = scpSpecification(target);
    const command = `${forwarded} -- ${first.path} ${destination}`;
    const connection = await this.host.connect({
      sshArguments: [...this.line.sshArguments, sshDestination(first)],
      password: this.password,
      remoteCommand: command,
      verbose: this.line.verbosity > 0,
    });
    this.lines.push(...connection.lines);
    if (connection.kind === 'refused') {
      this.exitCode = connection.exitCode;
      return;
    }
    const channel = connection.session.openExecChannel(command);
    if (!channel.ok) {
      connection.release();
      this.exitCode = 1;
      return;
    }
    const result = await channel.value.execute();
    channel.value.close();
    connection.release();
    const text = result.stdout.replace(/\n+$/, '');
    if (text !== '') this.lines.push(text);
    if (result.exitCode !== 0) this.exitCode = 1;
  }
}

export async function runScpClient(
  args: readonly string[], host: ScpClientHost, password: string | undefined,
): Promise<ScpClientOutcome> {
  const parsed = parseScpCommandLine(args);
  if (parsed.kind === 'rejected') {
    return { output: parsed.diagnostic === null ? host.usage : `${parsed.diagnostic}\n${host.usage}`, exitCode: 1 };
  }
  const line = parsed.line;
  const endpoints = line.operands.map(parseScpEndpoint);
  const target = endpoints[endpoints.length - 1];
  const sources = endpoints.slice(0, -1);
  if (line.sshProgram !== null && endpoints.some((endpoint) => endpoint.remote) && !host.sshPrograms.includes(line.sshProgram)) {
    return { output: `exec: ${line.sshProgram}: No such file or directory`, exitCode: 1 };
  }
  const run = new ScpClientRun(host, line, password);
  const remoteSources = sources.filter((source) => source.remote);
  const localSources = sources.filter((source) => !source.remote);
  if (!target.remote && sources.length > 1) {
    const type = host.local.getEntryType(host.local.normalizePath(target.path, host.cwd));
    if (type !== 'directory') {
      return { output: `scp: ${target.path}: ${type === null ? 'No such file or directory' : 'Not a directory'}`, exitCode: 1 };
    }
  }
  if (target.remote) {
    if (localSources.length > 0) await run.upload(localSources, target);
    for (const source of remoteSources) {
      if (line.viaClient) await run.relayThroughClient(source, target);
      else await run.runOnSourceHost([source], target);
    }
  } else if (remoteSources.length === 0) {
    await run.copyLocally(localSources, target);
  } else {
    for (const source of sources) {
      if (source.remote) await run.download(source, target);
      else await run.copyLocally([source], target);
    }
  }
  return { output: run.lines.join('\n'), exitCode: run.exitCode };
}
