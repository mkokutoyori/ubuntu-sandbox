import type { Errno } from '@/network/core/Errno';
import { IPAddress, IPv6Address } from '@/network/core/types';
import { PORT_ANY } from '@/network/core/ports/PortNumber';
import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import { RRType } from '@/network/dns/wire/RRType';
import { formatBsdSyslog, type SyslogPacket } from '@/network/syslog/types';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type {
  ChildExit, Datagram, DatagramOptions, FileChange, FileHandle, FileStat, KeepAliveOptions, OpenReadResult, ListenOptions, ListenOutcome, Listener, LocalSocketBinding, LocalSocketMessage, LocalSocketOptions,
  LocalStreamBinding, LocalStreamOptions, OpenFileOptions, OpenFileResult, ProcessDetails, ResourceUsage, RsyslogProcess, Resolution, RsyslogHost, SrvRecord, StreamConnection, StreamOptions, TerminalSink,
} from '@/network/rsyslog/engine/Host';
import { acceptTlsServer, openTlsClient } from '@/network/rsyslog/host/TlsStreams';
import { latin1Text } from '@/network/rsyslog/engine/Latin1';
import type { VirtualFileSystem, AppendCreation, AppendDescriptor, AppendFailure, INode } from '../VirtualFileSystem';
import type { SyslogForwardSocket } from './SyslogForwardSocket';
import type { LocalDatagramSockets, UnixStreamEnd } from './LocalDatagramSockets';
import type { ClockTimers } from './ClockTimers';
import type { ProcessUsage } from '../process/ProcessUsage';

export const JOURNAL_SYSLOG_SOCKET = '/run/systemd/journal/syslog';
const KERNEL_LOG_PATH = '/proc/kmsg';
const WILDCARDS = { IPv4: '0.0.0.0', IPv6: '::' } as const;

export interface RsyslogUdpEndpoint {
  udpBind(
    port: number,
    listener: (delivery: { udp: { sourcePort: number; payload: unknown }; sourceIP: { toString(): string } }) => void,
    processName?: string,
    owner?: { pid?: number; uid?: number; service?: string; families?: readonly ('IPv4' | 'IPv6')[] },
  ): number | false;
  udpBindAddress(
    address: string, port: number,
    listener: (delivery: { udp: { sourcePort: number; payload: unknown }; sourceIP: { toString(): string } }) => void,
    processName?: string, boundDevice?: string,
  ): void;
  udpClose(port: number, family?: 'IPv4' | 'IPv6'): void;
  udpCloseAddress(address: string, port: number): void;
  sendUdpDatagram(destination: IPAddress, port: number, sourcePort: number, payload: unknown, payloadBytes?: number, options?: { sourceIp?: IPAddress }): boolean;
  sendUdpDatagram6(destination: IPv6Address, port: number, sourcePort: number, payload: unknown, payloadBytes?: number, options?: { sourceIp?: IPv6Address }): boolean;
}

export interface LinuxRsyslogPlatform {
  readonly vfs: VirtualFileSystem;
  readonly vfsReader: { read(path: string): string | null };
  readonly timers: ClockTimers;
  readonly journal: SyslogForwardSocket;
  readonly localSockets: LocalDatagramSockets;
  readonly udp: RsyslogUdpEndpoint;
  tcp(): TcpStack;
  holdFile(path: string, creation: AppendCreation): { readonly handle: AppendDescriptor; readonly release: () => void } | AppendFailure;
  descriptorLimitReached(): boolean;
  readonly usage: ProcessUsage;
  resourceUsage(): ResourceUsage;
  userNameOfUid(uid: number): string | null;
  supplementaryGidsOf(userName: string): number[];
  applyCredentials(uid: number, gid: number): void;
  restoreProcessLimits(): void;
  runProgram(argv: readonly string[], uid: number, gid: number, parentPid: number): ChildExit;
  setOpenFilesLimit(uid: number, limit: number): { readonly errno: Errno; readonly hardLimit: number } | null;
  wallMs(): number;
  monotonicMs(): number;
  bootTimeMs(): number;
  hostname(): string;
  domainName(): string | null;
  timezone(): string | undefined;
  environment(name: string): string | undefined;
  localAddresses(): string[];
  addressesOfDevice(device: string): string[] | null;
  uidOf(name: string): number | null;
  gidOf(name: string): number | null;
  userExists(name: string): boolean;
  terminals(): { user: string; tty: string }[];
  writeTerminal(tty: string, text: string): void;
  resolveAddresses(name: string): string[];
  reverseName(address: string): string | null;
  servicePort(name: string, protocol: 'tcp' | 'udp'): number | null;
  querySrv(name: string): DnsMessage | null;
  processDetails(pid: number): ProcessDetails | null;
  isAlive(pid: number): boolean;
  daemonPid(): number;
  ipv6Enabled(): boolean;
  submitLibcSyslog(priority: number, message: string): void;
  setConsoleLogLevel(level: number): Errno | null;
  restoreConsoleLogLevel(): void;
}

function bytesOfLatin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

function payloadBytes(payload: unknown): Uint8Array | null {
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === 'string') return new TextEncoder().encode(payload);
  if (typeof payload === 'object' && payload !== null && (payload as { type?: string }).type === 'syslog') {
    return new TextEncoder().encode(formatBsdSyslog(payload as SyslogPacket));
  }
  return null;
}

function parseAddress(address: string): IPAddress | IPv6Address | null {
  if (address.includes(':')) {
    try {
      return new IPv6Address(address);
    } catch {
      return null;
    }
  }
  return IPAddress.tryParse(address);
}

class SocketConnection implements StreamConnection {
  private data: ((bytes: Uint8Array) => void) | null = null;
  private close_: (() => void) | null = null;
  private readonly buffered: Uint8Array[] = [];
  private finished = false;
  closedByPeer = false;

  constructor(private readonly socket: TcpSocket, private readonly woken: () => void) {
    socket.onData((chunk) => {
      this.woken();
      const bytes = bytesOfLatin1(String(chunk));
      if (this.data === null) this.buffered.push(bytes);
      else this.data(bytes);
    });
    socket.onEnd(() => {
      this.closedByPeer = true;
      this.notifyClose();
    });
    socket.onClose(() => {
      this.finished = true;
      this.notifyClose();
    });
  }

  get remoteIp(): string {
    return this.socket.remoteIp;
  }

  get remotePort(): number {
    return this.socket.remotePort;
  }

  write(bytes: Uint8Array): Errno | null {
    if (this.finished || this.socket.closed) return 'EPIPE';
    return this.socket.write(latin1Text(bytes)) === 'ok' ? null : 'EPIPE';
  }

  close(): void {
    this.socket.close();
  }

  onData(handler: (bytes: Uint8Array) => void): void {
    this.data = handler;
    for (const chunk of this.buffered.splice(0)) handler(chunk);
  }

  onClose(handler: () => void): void {
    this.close_ = handler;
    if (this.finished || this.closedByPeer) handler();
  }

  private notifyClose(): void {
    this.close_?.();
  }
}

class UnixConnection implements StreamConnection {
  private data: ((bytes: Uint8Array) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private readonly buffered: Uint8Array[] = [];
  private finished = false;
  closedByPeer = false;
  readonly remoteIp = '';
  readonly remotePort = 0;

  constructor(private readonly end: UnixStreamEnd, private readonly woken: () => void) {
    end.setHandlers({
      onData: (text) => {
        this.woken();
        const bytes = bytesOfLatin1(text);
        if (this.data === null) this.buffered.push(bytes);
        else this.data(bytes);
      },
      onClose: () => {
        this.closedByPeer = true;
        this.finished = true;
        this.closeHandler?.();
      },
    });
  }

  write(bytes: Uint8Array): Errno | null {
    return this.end.write(latin1Text(bytes)) ? null : 'EPIPE';
  }

  close(): void {
    this.end.close();
  }

  onData(handler: (bytes: Uint8Array) => void): void {
    this.data = handler;
    for (const chunk of this.buffered.splice(0)) handler(chunk);
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
    if (this.finished) handler();
  }
}

const KERNEL_KEEPALIVE = { probes: 9, timeSeconds: 7200, intervalSeconds: 75 } as const;

function enableKeepAlive(socket: TcpSocket, options: KeepAliveOptions): void {
  const probes = options.probes > 0 ? options.probes : KERNEL_KEEPALIVE.probes;
  const time = options.timeSeconds > 0 ? options.timeSeconds : KERNEL_KEEPALIVE.timeSeconds;
  const interval = options.intervalSeconds > 0 ? options.intervalSeconds : KERNEL_KEEPALIVE.intervalSeconds;
  socket.enableKeepAlive(time * 1000, interval * 1000, probes);
}

class HeldHandle implements FileHandle {
  constructor(
    readonly path: string,
    private readonly descriptor: AppendDescriptor,
    private readonly release: () => void,
    private readonly account: (path: string, bytes: number, failed: boolean) => void,
  ) {}

  write(text: string): string | null {
    const failure = this.descriptor.append(text);
    this.account(this.path, text.length, failure !== null);
    return failure;
  }

  flush(): void {}

  close(): void {
    this.release();
  }
}

export class LinuxRsyslogHost implements RsyslogHost {
  private readonly platform: LinuxRsyslogPlatform;
  private readonly sourcePorts = new Map<'IPv4' | 'IPv6', number>();
  private readonly tcpListeners = new Set<() => void>();
  private readonly openSockets = new Map<Listener, 'udp' | 'tcp'>();

  constructor(platform: LinuxRsyslogPlatform) {
    this.platform = platform;
  }

  readonly clock = {
    wallMs: (): number => this.platform.timers.now(),
    monotonicMs: (): number => this.platform.monotonicMs() + (this.platform.timers.now() - this.platform.wallMs()),
  };

  private credentials = { uid: 0, gid: 0, groups: [0] as number[], umask: 0o022 };

  readonly process: RsyslogProcess = {
    setSupplementaryGroups: (gids) => {
      if (this.credentials.uid !== 0) return 'EPERM';
      this.credentials.groups = [...gids];
      return null;
    },
    initSupplementaryGroups: (userName, gid) => {
      if (this.credentials.uid !== 0) return 'EPERM';
      this.credentials.groups = [...new Set([gid, ...this.platform.supplementaryGidsOf(userName)])];
      return null;
    },
    setGid: (gid) => {
      if (this.credentials.uid !== 0 && gid !== this.credentials.gid) return 'EPERM';
      this.credentials.gid = gid;
      this.platform.applyCredentials(this.credentials.uid, gid);
      return null;
    },
    setUid: (uid) => {
      if (this.credentials.uid !== 0 && uid !== this.credentials.uid) return 'EPERM';
      this.credentials.uid = uid;
      this.platform.applyCredentials(uid, this.credentials.gid);
      return null;
    },
    userNameOf: (uid) => this.platform.userNameOfUid(uid),
    currentGid: () => this.credentials.gid,
    setUmask: (mask) => { this.credentials.umask = mask & 0o777; },
    setOpenFilesLimit: (limit) => this.platform.setOpenFilesLimit(this.credentials.uid, limit),
    run: (argv) => this.platform.runProgram(argv, this.credentials.uid, this.credentials.gid, this.platform.daemonPid()),
  };

  private awakened(callback: () => void): void {
    this.platform.usage.wake();
    callback();
  }

  private accountRead(inode: INode, offset: number, length: number, size: number): void {
    if (inode.generator || inode.type !== 'file') return;
    this.platform.usage.fileRead(inode.id, offset, length, size);
  }

  private accountAppend(path: string, bytes: number, failed: boolean): void {
    if (failed) return;
    const inode = this.platform.vfs.resolveInode(path);
    if (inode === null || inode.generator || inode.type !== 'file') return;
    this.platform.usage.fileWrite(inode.id, inode.size - bytes, bytes, Math.max(0, inode.size - bytes));
  }

  private statOf(inode: INode | null): FileStat | null {
    if (inode === null) return null;
    const kind = inode.type === 'file' || inode.type === 'directory' || inode.type === 'symlink' ? inode.type : 'other';
    return { inode: inode.id, size: inode.generator ? this.contentOf(inode).length : inode.size, mtimeMs: inode.mtime, ctimeMs: inode.ctime, kind };
  }

  private contentOf(inode: INode): string {
    return inode.generator ? inode.generator() : inode.content;
  }

  readonly files = {
    open: (path: string, options: OpenFileOptions): OpenFileResult => {
      if (this.platform.descriptorLimitReached()) return { error: 'Too many open files' };
      const held = this.platform.holdFile(path, {
        mode: options.mode,
        uid: options.uid,
        gid: options.gid,
        directoryMode: options.directoryMode,
        directoryUid: options.directoryUid,
        directoryGid: options.directoryGid,
        createDirectories: options.createDirectories,
        failOnChownFailure: options.failOnChownFailure,
        followSymlinks: options.followSymlinks,
        actor: { ...this.credentials, gids: this.credentials.groups },
      });
      if ('error' in held) return held;
      return { handle: new HeldHandle(path, held.handle, held.release, (target, bytes, failed) => this.accountAppend(target, bytes, failed)), notices: held.handle.notices };
    },
    lstat: (path: string): FileStat | null => this.statOf(this.platform.vfs.resolveInode(path, false)),
    stat: (path: string): FileStat | null => this.statOf(this.platform.vfs.resolveInode(path)),
    openRead: (path: string): OpenReadResult => {
      const inode = this.platform.vfs.resolveInode(path);
      if (inode === null) return { error: 'No such file or directory', missing: true };
      const actor = this.credentials;
      if (!this.platform.vfs.checkAccess(inode, 'r', actor.uid, actor.gid, actor.groups)) return { error: 'Permission denied', missing: false };
      const content = (): string => (inode.type === 'directory' ? '' : this.contentOf(inode));
      return {
        file: {
          inode: inode.id,
          read: (offset, length) => {
            const text = content();
            this.accountRead(inode, offset, length, text.length);
            return text.slice(offset, offset + length);
          },
          close: () => undefined,
        },
      };
    },
    realpath: (path: string): string | null => this.platform.vfs.realpath(path),
    remove: (path: string): boolean => this.platform.vfs.deleteFile(path),
    observe: (listener: (change: FileChange) => void): (() => void) => this.platform.vfs.onChange(listener),
    read: (path: string): string | null => {
      const text = this.platform.vfs.readFile(path);
      const inode = text === null ? null : this.platform.vfs.resolveInode(path);
      if (text !== null && inode !== null) this.accountRead(inode, 0, text.length, text.length);
      return text;
    },
    exists: (path: string): boolean => this.platform.vfs.exists(path),
    isDirectory: (path: string): boolean => this.platform.vfs.getType(path) === 'directory',
    isSymbolicLink: (path: string): boolean => this.platform.vfs.resolveInode(path, false)?.type === 'symlink',
    list: (directory: string): string[] =>
      (this.platform.vfs.listDirectory(directory) ?? []).map((entry) => entry.name).filter((name) => name !== '.' && name !== '..').sort(),
    glob: (pattern: string): string[] => this.platform.vfs.globExpand(pattern, '/'),
    statSize: (path: string): number | null => {
      const inode = this.platform.vfs.resolveInode(path);
      return inode === null || inode.type !== 'file' ? null : inode.size;
    },
    readFrom: (path: string, offset: number): { text: string; size: number; inode: string } | null => {
      const inode = this.platform.vfs.resolveInode(path);
      if (inode === null || inode.type !== 'file') return null;
      const content = this.platform.vfs.readFile(path) ?? '';
      this.accountRead(inode, offset, content.length - offset, content.length);
      return { text: content.slice(offset), size: content.length, inode: String(inode.id) };
    },
    write: (path: string, text: string): boolean => {
      const before = this.platform.vfs.resolveInode(path);
      const sizeBefore = before === null ? 0 : before.size;
      const written = this.platform.vfs.writeFile(path, text, 0, 0, 0o022);
      const after = written ? this.platform.vfs.resolveInode(path) : null;
      if (after !== null) this.platform.usage.fileWrite(after.id, 0, text.length, sizeBefore);
      return written;
    },
    mkdir: (path: string, mode: number): boolean => this.platform.vfs.mkdir(path, mode, this.credentials.uid, this.credentials.gid),
    rmdir: (path: string): boolean => this.platform.vfs.rmdir(path),
    rename: (from: string, to: string): boolean => this.platform.vfs.rename(from, to),
    watch: (path: string, onEvent: () => void): (() => void) | null => {
      const slash = path.lastIndexOf('/');
      const directory = slash < 0 ? '/' : slash === 0 ? '/' : path.slice(0, slash);
      const name = path.slice(slash + 1);
      return this.platform.vfs.onDirectoryEvent(directory, (changed) => {
        if (changed === name) onEvent();
      });
    },
  };

  readonly users = {
    uidOf: (name: string): number | null => this.platform.uidOf(name),
    gidOf: (name: string): number | null => this.platform.gidOf(name),
    userExists: (name: string): boolean => this.platform.userExists(name),
    loggedInTerminals: (user: string): TerminalSink[] =>
      this.platform.terminals().filter((terminal) => terminal.user === user).map((terminal) => this.terminalSink(terminal.tty)),
    allLoggedInTerminals: (): { user: string; sink: TerminalSink }[] =>
      this.platform.terminals().map((terminal) => ({ user: terminal.user, sink: this.terminalSink(terminal.tty) })),
  };

  private terminalSink(tty: string): TerminalSink {
    return { write: (text: string) => this.platform.writeTerminal(tty, text) };
  }

  readonly network = {
    resolve: (name: string): Resolution => {
      const literal = parseAddress(name);
      if (literal !== null) return { addresses: [literal.toString()] };
      const addresses = this.platform.resolveAddresses(name);
      return addresses.length === 0 ? { error: 'Name or service not known' } : { addresses };
    },
    reverse: (address: string): string | null => this.platform.reverseName(address),
    service: (name: string, protocol: 'tcp' | 'udp'): number | null => this.platform.servicePort(name, protocol),
    resolveSrv: (name: string): SrvRecord[] | { readonly error: string } => {
      const reply = this.platform.querySrv(name);
      if (reply === null) return { error: 'SRV lookup failed' };
      const records: SrvRecord[] = [];
      for (const answer of reply.answers) {
        const data = answer.data;
        if (data.type === RRType.SRV) records.push({ host: data.target, port: data.port, priority: data.priority, weight: data.weight });
      }
      return records.length === 0 ? { error: 'no SRV records' } : records;
    },
    sendDatagram: (address: string, port: number, payload: Uint8Array, options?: DatagramOptions): Errno | null =>
      this.sendDatagram(address, port, payload, options),
    connectStream: (address: string, port: number, options?: StreamOptions): StreamConnection | { readonly errno: Errno } =>
      this.connectStream(address, port, options),
    listenDatagram: (port: number, address: string | null, options: ListenOptions, onDatagram: (datagram: Datagram) => void): ListenOutcome =>
      this.listenDatagram(port, address, options, onDatagram),
    listenStream: (port: number, address: string | null, options: ListenOptions, onAccept: (connection: StreamConnection) => void): ListenOutcome =>
      this.listenStream(port, address, options, onAccept),
    streamListenerOwner: (port: number): { readonly pid: number; readonly comm: string | null } | null => {
      const owners = this.platform.tcp().listListeners()
        .filter((listener) => listener.localPort === port && listener.identity.pid !== undefined)
        .map((listener) => listener.identity.pid as number)
        .sort((first, second) => first - second);
      if (owners.length === 0) return null;
      return { pid: owners[0], comm: this.platform.processDetails(owners[0])?.comm ?? null };
    },
  };

  readonly sockets = {
    listen: (path: string, options: LocalSocketOptions, onMessage: (message: LocalSocketMessage) => void): LocalSocketBinding => {
      if (path === JOURNAL_SYSLOG_SOCKET) {
        const detach = this.platform.journal.attach((message) => onMessage({
          text: message.text, pid: message.pid, uid: message.uid, gid: message.gid, receivedAtMs: message.receivedAtMs,
        }));
        return { close: detach, acquiredFromSupervisor: true };
      }
      const outcome = this.platform.localSockets.bind(path, { unlink: options.unlink, createPath: options.createPath }, (datagram) => onMessage({
        text: datagram.text, pid: datagram.pid, uid: datagram.uid, gid: datagram.gid, receivedAtMs: datagram.receivedAtMs,
      }));
      if ('errno' in outcome) return { errno: outcome.errno };
      return { close: outcome.close, acquiredFromSupervisor: false };
    },
    listenStream: (path: string, options: LocalStreamOptions, onAccept: (connection: StreamConnection) => void): LocalStreamBinding => {
      const owner = options.uid ?? this.credentials.uid;
      const group = options.gid ?? this.credentials.gid;
      if (this.credentials.uid !== 0 && (owner !== this.credentials.uid || group !== this.credentials.gid)) return { errno: 'EPERM', stage: 'chown' };
      const outcome = this.platform.localSockets.listenStream(
        path, { mode: options.mode, uid: owner, gid: group, unlink: options.unlink }, (end) => {
          this.platform.usage.wake();
          onAccept(new UnixConnection(end, () => this.platform.usage.wake()));
        },
      );
      return 'errno' in outcome ? { errno: outcome.errno, stage: 'bind' } : { close: outcome.close };
    },
    isSocket: (path: string): boolean => path === JOURNAL_SYSLOG_SOCKET || this.platform.localSockets.isBound(path),
    systemdBooted: (): boolean => true,
    processDetails: (pid: number): ProcessDetails | null => this.platform.processDetails(pid),
    isAlive: (pid: number): boolean => this.platform.isAlive(pid),
    ownPid: (): number => this.platform.daemonPid(),
  };

  readonly kernelLog = {
    open: (path: string, _onData: (chunk: string) => void): { readonly close: () => void } | { readonly errno: Errno } =>
      path === KERNEL_LOG_PATH ? { close: () => undefined } : { errno: 'ENOENT' },
    setConsoleLogLevel: (level: number): Errno | null => this.platform.setConsoleLogLevel(level),
    restoreConsoleLogLevel: (): void => this.platform.restoreConsoleLogLevel(),
  };

  hostname(): string {
    return this.platform.hostname();
  }

  domainName(): string | null {
    return this.platform.domainName();
  }

  timezone(): string | undefined {
    return this.platform.timezone();
  }

  environment(name: string): string | undefined {
    return this.platform.environment(name);
  }

  random(): number {
    return Math.random();
  }

  localAddresses(): string[] {
    return this.platform.localAddresses();
  }

  bootTimeMs(): number {
    return this.platform.bootTimeMs();
  }

  resourceUsage(): ResourceUsage {
    return this.platform.resourceUsage();
  }

  schedule(callback: () => void, delayMs: number): () => void {
    return this.platform.timers.schedule(() => this.awakened(callback), delayMs);
  }

  scheduleEvery(callback: () => void, periodMs: number): () => void {
    return this.platform.timers.scheduleEvery(() => this.awakened(callback), periodMs);
  }

  syslog(priority: number, message: string): void {
    this.platform.submitLibcSyslog(priority, message);
  }

  dispose(): void {
    for (const [family, port] of this.sourcePorts) this.platform.udp.udpClose(port, family);
    this.sourcePorts.clear();
    for (const close of [...this.tcpListeners]) close();
    this.tcpListeners.clear();
    this.openSockets.clear();
    this.credentials = { uid: 0, gid: 0, groups: [0], umask: 0o022 };
    this.platform.restoreProcessLimits();
  }

  boundSockets(): Array<{ port: number; protocol: 'udp' | 'tcp' }> {
    const seen = new Map<string, { port: number; protocol: 'udp' | 'tcp' }>();
    for (const [listener, protocol] of this.openSockets) seen.set(`${protocol}:${listener.port}`, { port: listener.port, protocol });
    return [...seen.values()].sort((left, right) => left.port - right.port || left.protocol.localeCompare(right.protocol));
  }

  private sourcePort(family: 'IPv4' | 'IPv6'): number | null {
    const known = this.sourcePorts.get(family);
    if (known !== undefined) return known;
    const bound = this.platform.udp.udpBind(PORT_ANY, () => undefined, 'rsyslogd', {
      pid: this.platform.daemonPid(), uid: 0, families: [family],
    });
    if (bound === false) return null;
    this.sourcePorts.set(family, bound);
    return bound;
  }

  private sendDatagram(address: string, port: number, payload: Uint8Array, options?: DatagramOptions): Errno | null {
    const destination = parseAddress(address);
    if (destination === null) return 'EINVAL';
    const family = destination instanceof IPv6Address ? 'IPv6' : 'IPv4';
    const sourcePort = this.sourcePort(family);
    if (sourcePort === null) return 'EADDRINUSE';
    let sourceAddress = options?.sourceAddress;
    if (sourceAddress === undefined && options?.device !== undefined) {
      const bound = (this.platform.addressesOfDevice(options.device) ?? []).find((candidate) => candidate.includes(':') === (family === 'IPv6'));
      if (bound === undefined) return 'ENODEV';
      sourceAddress = bound;
    }
    const source = sourceAddress === undefined ? undefined : parseAddress(sourceAddress);
    if (sourceAddress !== undefined && (source === null || (source instanceof IPv6Address) !== (destination instanceof IPv6Address))) return 'EAFNOSUPPORT';
    const sent = destination instanceof IPv6Address
      ? this.platform.udp.sendUdpDatagram6(destination, port, sourcePort, payload, payload.length, source instanceof IPv6Address ? { sourceIp: source } : {})
      : this.platform.udp.sendUdpDatagram(destination, port, sourcePort, payload, payload.length, source instanceof IPAddress ? { sourceIp: source } : {});
    return sent ? null : 'ENETUNREACH';
  }

  private connectStream(address: string, port: number, options?: StreamOptions): StreamConnection | { readonly errno: Errno } {
    const destination = parseAddress(address);
    if (destination === null) return { errno: 'EINVAL' };
    const stack = this.platform.tcp();
    let localIp: string | undefined;
    if (options?.device !== undefined) {
      const bound = (this.platform.addressesOfDevice(options.device) ?? []).find((candidate) => candidate.includes(':') === address.includes(':'));
      if (bound === undefined) return { errno: 'ENODEV' };
      localIp = bound;
    }
    const socket = stack.connect(destination.toString(), port, localIp === undefined ? {} : { localIp });
    if (socket === null) return { errno: stack.hasEgressTo(destination.toString()) ? 'ETIMEDOUT' : 'ENETUNREACH' };
    if (socket.state !== 'established') {
      const refused = socket.connectRefused === true;
      if (!socket.closed) socket.close();
      return { errno: refused ? 'ECONNREFUSED' : 'ETIMEDOUT' };
    }
    if (options?.userTimeoutMs !== undefined && options.userTimeoutMs > 0) socket.setUserTimeout(options.userTimeoutMs);
    if (options?.keepAlive !== undefined) enableKeepAlive(socket, options.keepAlive);
    if (options?.tls !== undefined) return openTlsClient(socket, options.tls, this.platform.vfsReader, { nowMs: () => this.clock.wallMs() });
    return new SocketConnection(socket, () => this.platform.usage.wake());
  }

  private familiesFor(address: string | null, options: ListenOptions): ('IPv4' | 'IPv6')[] {
    if (address !== null) return [address.includes(':') ? 'IPv6' : 'IPv4'];
    const families: ('IPv4' | 'IPv6')[] = [];
    if (options.family !== 'ipv6-only') families.push('IPv4');
    if (options.family !== 'ipv4-only' && this.platform.ipv6Enabled()) families.push('IPv6');
    return families;
  }

  private errnoOf(error: unknown): Errno {
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes('EADDRINUSE')) return 'EADDRINUSE';
    if (text.includes('EACCES')) return 'EACCES';
    if (text.includes('EADDRNOTAVAIL')) return 'EADDRNOTAVAIL';
    return 'EINVAL';
  }

  private listenDatagram(port: number, address: string | null, options: ListenOptions, onDatagram: (datagram: Datagram) => void): ListenOutcome {
    const listeners: Listener[] = [];
    const failures: ListenOutcome['failures'] = [];
    const receive = (delivery: { udp: { sourcePort: number; payload: unknown }; sourceIP: { toString(): string } }): void => {
      const bytes = payloadBytes(delivery.udp.payload);
      if (bytes === null) return;
      this.platform.usage.wake();
      onDatagram({ sourceIp: delivery.sourceIP.toString(), sourcePort: delivery.udp.sourcePort, payload: bytes });
    };
    const udp = this.platform.udp;
    const pid = this.platform.daemonPid();
    for (const family of this.familiesFor(address, options)) {
      try {
        if (address !== null) {
          udp.udpBindAddress(address, port, receive, 'rsyslogd', options.device);
          listeners.push({ family, address, port, close: () => udp.udpCloseAddress(address, port) });
        } else if (options.device !== undefined) {
          const bound = (this.platform.addressesOfDevice(options.device) ?? []).filter((candidate) => candidate.includes(':') === (family === 'IPv6'));
          if (bound.length === 0) {
            failures.push({ family, errno: 'ENODEV' });
            continue;
          }
          for (const each of bound) {
            udp.udpBindAddress(each, port, receive, 'rsyslogd', options.device);
            listeners.push({ family, address: each, port, close: () => udp.udpCloseAddress(each, port) });
          }
        } else {
          const result = udp.udpBind(port, receive, 'rsyslogd', { pid, uid: 0, families: [family] });
          if (result === false) {
            failures.push({ family, errno: 'EADDRINUSE' });
            continue;
          }
          listeners.push({ family, address: WILDCARDS[family], port, close: () => udp.udpClose(port, family) });
        }
      } catch (error) {
        failures.push({ family, errno: this.errnoOf(error) });
      }
    }
    this.track(listeners, 'udp');
    return { listeners, failures };
  }

  private track(listeners: Listener[], protocol: 'udp' | 'tcp'): void {
    for (const listener of listeners) {
      this.openSockets.set(listener, protocol);
      const close = listener.close.bind(listener);
      (listener as { close: () => void }).close = () => {
        this.openSockets.delete(listener);
        close();
      };
    }
  }

  private listenStream(port: number, address: string | null, options: ListenOptions, onAccept: (connection: StreamConnection) => void): ListenOutcome {
    const listeners: Listener[] = [];
    const failures: ListenOutcome['failures'] = [];
    const stack = this.platform.tcp();
    const pid = this.platform.daemonPid();
    for (const family of this.familiesFor(address, options)) {
      const bindAddress = address ?? WILDCARDS[family];
      try {
        stack.listen(port, {
          identity: { pid, processName: 'rsyslogd' },
          ...(options.device === undefined ? {} : { boundDevice: options.device }),
          ...(options.receiveBufferBytes === undefined ? {} : { receiveWindow: Math.min(options.receiveBufferBytes, 65535) }),
          ...(options.backlog === undefined ? {} : { backlog: options.backlog }),
          onAccept: (socket) => {
            if (options.keepAlive !== undefined) enableKeepAlive(socket, options.keepAlive);
            this.platform.usage.wake();
            if (options.tls === undefined) onAccept(new SocketConnection(socket, () => this.platform.usage.wake()));
            else acceptTlsServer(socket, options.tls, this.platform.vfsReader, { nowMs: () => this.clock.wallMs() }, onAccept);
          },
        }, bindAddress);
        const close = (): void => {
          stack.closeListener(port, bindAddress);
          this.tcpListeners.delete(close);
        };
        this.tcpListeners.add(close);
        listeners.push({ family, address: bindAddress, port, close });
      } catch (error) {
        failures.push({ family, errno: this.errnoOf(error) });
      }
    }
    this.track(listeners, 'tcp');
    return { listeners, failures };
  }
}
