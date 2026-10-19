import type { TcpConnector } from '@/network/tcp/types';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import type { ISshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { VfsSftpFileSystem } from '@/network/protocols/ssh/sftp/VfsSftpFileSystem';
import { SftpLocalPort } from '@/network/protocols/ssh/sftp/client/SftpLocalPort';
import { SftpClient } from '@/network/protocols/ssh/sftp/client/SftpClient';
import { SftpWireClient, type SftpDiagnostics } from '@/network/protocols/ssh/sftp/client/SftpWireClient';
import { isOk } from '@/network/protocols/ssh/Result';

export interface SftpTestClientDeps {
  readonly tcpConnector: TcpConnector;
  readonly localVfs: VirtualFileSystem;
  readonly localUser: string;
  readonly localUid: number;
  readonly localGid: number;
  readonly localCwd: string;
  readonly knownHostsPath: string;
  readonly interactionHandler: ISshInteractionHandler;
  readonly homeDirectory: string;
}

export class SftpTestClient {
  private ssh: SshSession | null = null;
  private engine: SftpClient | null = null;
  private port: SftpLocalPort | null = null;
  private text = '';
  private connected = false;

  constructor(private readonly deps: SftpTestClientDeps) {}

  async connect(userAtHost: string, options: { port?: number; password?: string } = {}): Promise<string> {
    const [user, host] = userAtHost.includes('@') ? userAtHost.split('@') : [this.deps.localUser, userAtHost];
    this.ssh = new SshSession({
      tcpConnector: this.deps.tcpConnector,
      vfs: this.deps.localVfs,
      localUser: this.deps.localUser,
      localUid: this.deps.localUid,
      localGid: this.deps.localGid,
      knownHostsPath: this.deps.knownHostsPath,
      interactionHandler: this.deps.interactionHandler,
    });
    const builder = SshConnectOptionsBuilder.create().host(host).user(user).port(options.port ?? 22)
      .strictHostKeyChecking('accept-new');
    if (options.password !== undefined) builder.password(options.password);
    const outcome = await this.ssh.connect(builder.build());
    if (outcome.ok === false) return `${user}@${host}: Permission denied (publickey,password).`;
    const channel = this.ssh.openSftpChannel();
    if (!isOk(channel) || !(await channel.value.accepted())) {
      this.ssh.disconnect();
      return 'subsystem request failed on channel 0';
    }
    const diagnostics: SftpDiagnostics = {
      error: (line) => { this.text += `${line}\n`; },
      notice: (line) => { this.text += `${line}\n`; },
    };
    const files = new VfsSftpFileSystem(this.deps.localVfs, {
      uid: this.deps.localUid, gid: this.deps.localGid, umask: 0o022,
    });
    this.port = new SftpLocalPort(files, this.deps.localCwd, 0o022, false, this.deps.homeDirectory);
    this.engine = new SftpClient(
      new SftpWireClient(channel.value, diagnostics),
      {
        local: this.port,
        listCommand: (rest) => `ls ${rest}`,
        runShell: () => Promise.resolve({ output: '', exitCode: 0 }),
      },
      {
        quiet: false, showProgress: false, resumeAll: false, fsyncAll: false, preserveAll: false, recursiveAll: false,
        limitKbps: null, timeZoneOffsetMinutes: () => 0,
      },
      diagnostics,
      (chunk) => { this.text += chunk; },
    );
    this.engine.initialize();
    this.connected = true;
    return `Connected to ${host}.`;
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnect(): void {
    this.connected = false;
    this.ssh?.disconnect();
  }

  run(line: string): string {
    this.text = '';
    this.engine!.executeSync(line);
    return this.text.replace(/\n$/, '');
  }

  pwd(): string { return this.run('pwd'); }
  lpwd(): string { return this.run('lpwd'); }
  cd(path: string): string { return this.run(`cd "${path}"`); }
  lcd(path: string): string { return this.run(`lcd "${path}"`); }
  mkdir(path: string): string { return this.run(`mkdir "${path}"`); }
  lmkdir(path: string): string { return this.run(`lmkdir "${path}"`); }
  rmdir(path: string): string { return this.run(`rmdir "${path}"`); }
  rm(path: string): string { return this.run(`rm "${path}"`); }
  rename(from: string, to: string): string { return this.run(`rename "${from}" "${to}"`); }
  chmod(mode: string, path: string): string { return this.run(`chmod ${mode} "${path}"`); }
  chown(owner: string, path: string): string { return this.run(`chown ${owner} "${path}"`); }
  version(): string { return this.run('version'); }
  df(path: string | undefined, human: boolean): string {
    return this.run(`df ${human ? '-h ' : ''}${path === undefined ? '' : `"${path}"`}`);
  }
  get(remote: string, local?: string): string { return this.run(`get "${remote}"${local === undefined ? '' : ` "${local}"`}`); }
  put(local: string, remote?: string): string { return this.run(`put "${local}"${remote === undefined ? '' : ` "${remote}"`}`); }
  getRecursive(remote: string, local?: string): string { return this.run(`get -r "${remote}"${local === undefined ? '' : ` "${local}"`}`); }
  putRecursive(local: string, remote?: string): string { return this.run(`put -r "${local}"${remote === undefined ? '' : ` "${remote}"`}`); }
  ls(args: readonly string[], flags: ReadonlySet<string>): string {
    const letters = [...flags].filter((flag) => flag !== '').join('');
    return this.run(`ls ${letters === '' ? '' : `-${letters} `}${args.map((arg) => `"${arg}"`).join(' ')}`);
  }
  lls(args: readonly string[]): string { return args.join(' '); }
}

import { SftpClientSession, type SftpCommandHost } from '@/network/protocols/ssh/sftp/client/SftpClientCommand';

export async function openSftpClientSession(
  deps: SftpTestClientDeps, destination: string, password: string, extraArguments: readonly string[] = [],
): Promise<SftpClientSession> {
  const files = new VfsSftpFileSystem(deps.localVfs, { uid: deps.localUid, gid: deps.localGid, umask: 0o022 });
  const host: SftpCommandHost = {
    local: new SftpLocalPort(files, deps.localCwd, 0o022, false, deps.homeDirectory),
    usage: 'usage: sftp',
    sshPrograms: ['ssh'],
    interactive: true,
    stderrIsTerminal: true,
    timeZoneOffsetMinutes: () => 0,
    listCommand: (rest) => `ls ${rest}`,
    runShell: () => Promise.resolve({ output: '', exitCode: 0 }),
    attachServer: () => null,
    readBatch: (path) => {
      const body = deps.localVfs.readFile(deps.localVfs.normalizePath(path, deps.localCwd));
      return body === null ? { failure: 'No such file or directory' } : { content: body };
    },
    connect: async (request) => {
      const [user, hostName] = request.destination.includes('@') ? request.destination.split('@') : [deps.localUser, request.destination];
      const ssh = new SshSession({
        tcpConnector: deps.tcpConnector,
        vfs: deps.localVfs,
        localUser: deps.localUser,
        localUid: deps.localUid,
        localGid: deps.localGid,
        knownHostsPath: deps.knownHostsPath,
        interactionHandler: deps.interactionHandler,
      });
      const builder = SshConnectOptionsBuilder.create().host(hostName).user(user).port(22).strictHostKeyChecking('accept-new');
      builder.password(password);
      const outcome = await ssh.connect(builder.build());
      if (outcome.ok === false) return { kind: 'refused', lines: [`${user}@${hostName}: Permission denied (publickey,password).`], exitCode: 255 };
      const channel = ssh.openSftpChannel();
      if (!isOk(channel) || !(await channel.value.accepted())) {
        ssh.disconnect();
        return { kind: 'refused', lines: ['subsystem request failed on channel 0'], exitCode: 255 };
      }
      return { kind: 'connected', channel: channel.value, release: () => ssh.disconnect(), lines: [] };
    },
  };
  const opened = await SftpClientSession.open([...extraArguments, destination], host, password);
  if (opened.kind === 'ended') throw new Error(opened.outcome.output);
  return opened.session;
}
