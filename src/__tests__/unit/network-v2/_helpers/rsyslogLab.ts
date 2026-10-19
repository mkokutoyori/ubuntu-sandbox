import type { Errno } from '@/network/core/Errno';
import type {
  Datagram, DatagramOptions, FileHandle, ListenOptions, ListenOutcome, LocalSocketBinding, LocalSocketMessage, LocalSocketOptions, ProcessDetails, OpenFileOptions, OpenFileResult, Resolution, RsyslogHost, SrvRecord, StreamConnection, StreamOptions,
  TerminalSink,
} from '@/network/rsyslog/engine/Host';
import { ConfigLoader, type ModuleCatalog } from '@/network/rsyslog/engine/Loader';
import { RsyslogEngine } from '@/network/rsyslog/engine/Engine';
import type { LoadedConfig } from '@/network/rsyslog/engine/Config';
import type { ActionModuleInstance, EngineModule, InputSubmission, InputSubmitter, OutputModule } from '@/network/rsyslog/engine/Modules';
import { BuiltinModuleCatalog } from '@/network/rsyslog/modules/Catalog';

const EPOCH_2026_10_19_NOON = Date.UTC(2026, 9, 19, 12, 0, 0);

interface ScheduledTimer {
  readonly id: number;
  at: number;
  readonly callback: () => void;
  readonly period: number | null;
  cancelled: boolean;
}

class LabConnection implements StreamConnection {
  peer: LabConnection | null = null;
  closedByPeer = false;
  private closed = false;
  private dataHandler: ((bytes: Uint8Array) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  readonly received: Uint8Array[] = [];

  constructor(readonly remoteIp: string, readonly remotePort: number) {}

  write(bytes: Uint8Array): Errno | null {
    if (this.closed || this.peer === null || this.peer.closed) return 'EPIPE';
    this.peer.deliver(bytes);
    return null;
  }

  deliver(bytes: Uint8Array): void {
    this.received.push(bytes);
    this.dataHandler?.(bytes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.peer !== null) {
      this.peer.closedByPeer = true;
      this.peer.closeHandler?.();
    }
  }

  onData(handler: (bytes: Uint8Array) => void): void {
    this.dataHandler = handler;
    for (const chunk of this.received) handler(chunk);
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  receivedText(): string {
    return new TextDecoder().decode(Buffer.concat(this.received));
  }
}

export class LabNetwork {
  readonly hosts = new Map<string, LabHost>();
  readonly names = new Map<string, string[]>();
  readonly services = new Map<string, number>([['syslog', 514]]);
  readonly srv = new Map<string, SrvRecord[]>();
  readonly reverse = new Map<string, string>();

  register(address: string, host: LabHost): void {
    this.hosts.set(address, host);
  }
}

export class LabHost implements RsyslogHost {
  private nowMs: number;
  private readonly startMs: number;
  private timers: ScheduledTimer[] = [];
  private nextTimerId = 1;
  private readonly streamListeners = new Map<number, (connection: StreamConnection) => void>();
  private readonly datagramListeners = new Map<number, (datagram: Datagram) => void>();
  readonly fileSystem = new Map<string, string>();
  readonly directories = new Set<string>(['/', '/var', '/var/log', '/etc', '/etc/rsyslog.d', '/run', '/dev', '/run/systemd', '/run/systemd/journal', '/usr', '/usr/lib', '/usr/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu/rsyslog']);
  readonly terminals = new Map<string, TerminalSink[]>();
  readonly sentDatagrams: { address: string; port: number; payload: Uint8Array }[] = [];
  readonly datagramFailures = new Map<string, Errno>();
  readonly libcSyslog: { priority: number; message: string }[] = [];
  readonly users = {
    uidOf: (name: string): number | null => ({ root: 0, syslog: 104, adm: 4, alice: 1000 } as Record<string, number>)[name] ?? null,
    gidOf: (name: string): number | null => ({ root: 0, syslog: 110, adm: 4, alice: 1000 } as Record<string, number>)[name] ?? null,
    userExists: (name: string): boolean => name in { root: 0, syslog: 0, adm: 0, alice: 0 },
    loggedInTerminals: (user: string): TerminalSink[] => this.terminals.get(user) ?? [],
    allLoggedInTerminals: (): { user: string; sink: TerminalSink }[] =>
      [...this.terminals].flatMap(([user, sinks]) => sinks.map((sink) => ({ user, sink }))),
  };
  readonly clock = {
    wallMs: (): number => this.nowMs,
    monotonicMs: (): number => this.nowMs - this.startMs,
  };
  readonly files = {
    open: (path: string, options: OpenFileOptions): OpenFileResult => this.openFile(path, options),
    read: (path: string): string | null => this.fileSystem.get(path) ?? null,
    exists: (path: string): boolean => this.fileSystem.has(path) || this.directories.has(path),
    isDirectory: (path: string): boolean => this.directories.has(path),
    list: (directory: string): string[] => {
      const prefix = directory.replace(/\/$/, '') + '/';
      return [...this.fileSystem.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).map((path) => path.slice(prefix.length)).sort();
    },
    glob: (pattern: string): string[] => {
      const regex = new RegExp(`^${pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
      return [...this.fileSystem.keys()].filter((path) => regex.test(path)).sort();
    },
    statSize: (path: string): number | null => this.fileSystem.get(path)?.length ?? null,
    readFrom: (path: string, offset: number): { text: string; size: number; inode: string } | null => {
      const content = this.fileSystem.get(path);
      return content === undefined ? null : { text: content.slice(offset), size: content.length, inode: path };
    },
    write: (path: string, text: string): boolean => {
      this.fileSystem.set(path, text);
      return true;
    },
  };
  readonly network = {
    resolve: (name: string): Resolution => this.resolveName(name),
    reverse: (address: string): string | null => this.net.reverse.get(address) ?? null,
    service: (name: string, _protocol: 'tcp' | 'udp'): number | null => this.net.services.get(name) ?? null,
    resolveSrv: (name: string): SrvRecord[] | { readonly error: string } => this.net.srv.get(name) ?? { error: 'host not found' },
    sendDatagram: (address: string, port: number, payload: Uint8Array, _options?: DatagramOptions): Errno | null => this.sendDatagram(address, port, payload),
    connectStream: (address: string, port: number, _options?: StreamOptions): StreamConnection | { readonly errno: Errno } => this.connect(address, port),
    listenDatagram: (port: number, address: string | null, options: ListenOptions, onDatagram: (datagram: Datagram) => void): ListenOutcome =>
      this.listen(this.datagramListeners, port, address, options, onDatagram),
    listenStream: (port: number, address: string | null, options: ListenOptions, onAccept: (connection: StreamConnection) => void): ListenOutcome =>
      this.listen(this.streamListeners, port, address, options, onAccept),
  };
  kernelLogHandler: ((chunk: string) => void) | null = null;
  kernelLogErrno: Errno | null = null;
  consoleLogLevel: number | null = null;
  readonly kernelLog = {
    open: (_path: string, onData: (chunk: string) => void): { readonly close: () => void } | { readonly errno: Errno } => {
      if (this.kernelLogErrno !== null) return { errno: this.kernelLogErrno };
      this.kernelLogHandler = onData;
      return { close: () => { this.kernelLogHandler = null; } };
    },
    setConsoleLogLevel: (level: number): Errno | null => {
      this.consoleLogLevel = level;
      return null;
    },
    restoreConsoleLogLevel: (): void => { this.consoleLogLevel = null; },
  };
  readonly localSockets = new Map<string, (message: LocalSocketMessage) => void>();
  readonly supervisedSockets = new Set<string>(['/run/systemd/journal/syslog']);
  readonly socketFiles = new Set<string>();
  readonly processes = new Map<number, ProcessDetails>();
  readonly livePids = new Set<number>();
  systemd = true;
  ownPidNumber = 700;
  readonly sockets = {
    listen: (path: string, options: LocalSocketOptions, onMessage: (message: LocalSocketMessage) => void): LocalSocketBinding => {
      if (this.localSockets.has(path)) return { errno: 'EADDRINUSE' };
      const acquired = this.supervisedSockets.has(path);
      if (!acquired && !options.createPath && !this.directories.has(path.slice(0, Math.max(path.lastIndexOf('/'), 1)))) return { errno: 'ENOENT' };
      this.localSockets.set(path, onMessage);
      this.socketFiles.add(path);
      return { close: () => { this.localSockets.delete(path); }, acquiredFromSupervisor: acquired };
    },
    isSocket: (path: string): boolean => this.socketFiles.has(path) || this.supervisedSockets.has(path),
    systemdBooted: (): boolean => this.systemd,
    processDetails: (pid: number): ProcessDetails | null => this.processes.get(pid) ?? null,
    isAlive: (pid: number): boolean => this.livePids.has(pid),
    ownPid: (): number => this.ownPidNumber,
  };

  logLocal(path: string, text: string, credentials: { pid?: number; uid?: number; gid?: number; receivedAtMs?: number } = {}): void {
    this.localSockets.get(path)?.({
      text, pid: credentials.pid ?? null, uid: credentials.uid ?? null, gid: credentials.gid ?? null, receivedAtMs: credentials.receivedAtMs ?? null,
    });
  }

  readonly environmentVariables = new Map<string, string>();
  randomValue = 0.25;
  hostName = 'ubuntu';
  domain: string | null = null;
  zone: string | undefined = 'UTC';
  readonly tcpAccepted: LabConnection[] = [];

  constructor(readonly address: string, readonly net: LabNetwork, startMs = EPOCH_2026_10_19_NOON) {
    this.nowMs = startMs;
    this.startMs = startMs - 3_600_000;
    net.register(address, this);
  }

  syslog(priority: number, message: string): void { this.libcSyslog.push({ priority, message }); }
  hostname(): string { return this.hostName; }
  domainName(): string | null { return this.domain; }
  timezone(): string | undefined { return this.zone; }
  environment(name: string): string | undefined { return this.environmentVariables.get(name); }
  random(): number { return this.randomValue; }
  localAddresses(): string[] { return [this.address, '127.0.0.1']; }
  bootTimeMs(): number { return this.startMs; }

  schedule(callback: () => void, delayMs: number): () => void {
    const timer: ScheduledTimer = { id: this.nextTimerId++, at: this.nowMs + Math.max(0, delayMs), callback, period: null, cancelled: false };
    this.timers.push(timer);
    return () => { timer.cancelled = true; };
  }

  scheduleEvery(callback: () => void, periodMs: number): () => void {
    const timer: ScheduledTimer = { id: this.nextTimerId++, at: this.nowMs + periodMs, callback, period: periodMs, cancelled: false };
    this.timers.push(timer);
    return () => { timer.cancelled = true; };
  }

  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      this.timers = this.timers.filter((timer) => !timer.cancelled);
      const due = this.timers.filter((timer) => timer.at <= target).sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (due === undefined) break;
      this.nowMs = Math.max(this.nowMs, due.at);
      if (due.period === null) due.cancelled = true;
      else due.at += due.period;
      due.callback();
    }
    this.nowMs = target;
  }

  private resolveName(name: string): Resolution {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(name) || name.includes(':')) return { addresses: [name] };
    const known = this.net.names.get(name);
    return known === undefined ? { error: 'Name or service not known' } : { addresses: [...known] };
  }

  private openFile(path: string, options: OpenFileOptions): OpenFileResult {
    const slash = path.lastIndexOf('/');
    const directory = slash <= 0 ? '/' : path.slice(0, slash);
    if (!this.directories.has(directory)) {
      if (!options.createDirectories) return { error: 'No such file or directory' };
      const parts = directory.split('/').filter((piece) => piece !== '');
      let walked = '';
      for (const piece of parts) {
        walked += `/${piece}`;
        this.directories.add(walked);
      }
    }
    if (!this.fileSystem.has(path)) this.fileSystem.set(path, '');
    const files = this.fileSystem;
    const handle: FileHandle = {
      path,
      write: (text: string) => {
        files.set(path, (files.get(path) ?? '') + text);
        return null;
      },
      flush: () => undefined,
      close: () => undefined,
    };
    return { handle };
  }

  readonly busyPorts = new Set<number>();
  ipv6Enabled = true;

  private listen<T>(registry: Map<number, T>, port: number, address: string | null, options: ListenOptions, handler: T): ListenOutcome {
    const families: ('IPv4' | 'IPv6')[] = [];
    if (address === null) {
      if (options.family !== 'ipv6-only') families.push('IPv4');
      if (options.family !== 'ipv4-only' && this.ipv6Enabled) families.push('IPv6');
    } else {
      families.push(address.includes(':') ? 'IPv6' : 'IPv4');
    }
    const failures: ListenOutcome['failures'] = [];
    const listeners: ListenOutcome['listeners'] = [];
    if (registry.has(port) || this.busyPorts.has(port)) {
      for (const family of families) failures.push({ family, errno: 'EADDRINUSE' });
      return { listeners, failures };
    }
    if (families.length > 0) registry.set(port, handler);
    for (const family of families) listeners.push({ family, address: address ?? '*', port, close: () => { registry.delete(port); } });
    return { listeners, failures };
  }

  private sendDatagram(address: string, port: number, payload: Uint8Array): Errno | null {
    const failure = this.datagramFailures.get(address);
    if (failure !== undefined) return failure;
    this.sentDatagrams.push({ address, port, payload: payload.slice() });
    const destination = this.net.hosts.get(address);
    destination?.datagramListeners.get(port)?.({ sourceIp: this.address, sourcePort: 40000, payload: payload.slice() });
    return null;
  }

  private connect(address: string, port: number): LabConnection | { readonly errno: Errno } {
    const destination = this.net.hosts.get(address);
    const accept = destination?.streamListeners.get(port);
    if (destination === undefined) return { errno: 'EHOSTUNREACH' };
    if (accept === undefined) return { errno: 'ECONNREFUSED' };
    const client = new LabConnection(address, port);
    const server = new LabConnection(this.address, 40001);
    client.peer = server;
    server.peer = client;
    destination.tcpAccepted.push(server);
    accept(server);
    return client;
  }
}

export interface LabEngine {
  readonly host: LabHost;
  readonly loader: ConfigLoader;
  readonly config: LoadedConfig;
  readonly engine: RsyslogEngine;
  readonly internalMessages: { severity: number; code: number; text: string }[];
}

export function lines(text: string | null): string[] {
  if (text === null || text === '') return [];
  return text.replace(/\n$/, '').split('\n');
}

export function startRsyslog(host: LabHost, configText: string, options: { files?: Record<string, string>; catalog?: ModuleCatalog } = {}): LabEngine {
  host.fileSystem.set('/etc/rsyslog.conf', configText);
  for (const [path, content] of Object.entries(options.files ?? {})) host.fileSystem.set(path, content);
  const catalog = options.catalog ?? new BuiltinModuleCatalog('/usr/lib/x86_64-linux-gnu/rsyslog', (path) => path.endsWith('.so'));
  const holder: { engine: RsyslogEngine | null } = { engine: null };
  const submitter: InputSubmitter = { submit: (info: InputSubmission) => holder.engine?.submit(info) };
  const loader = new ConfigLoader({ host, catalog, submitter });
  const config = loader.loadFile('/etc/rsyslog.conf');
  const internalMessages: LabEngine['internalMessages'] = [];
  const engine = new RsyslogEngine(config, host, { onInternalMessage: (severity, code, text) => internalMessages.push({ severity, code, text }) });
  holder.engine = engine;
  engine.start();
  return { host, loader, config, engine, internalMessages };
}

export function submitLocal(lab: LabEngine, raw: string, extra: Partial<InputSubmission> = {}): void {
  lab.engine.submit({
    raw, inputName: 'imuxsock', fromHost: lab.host.hostName, fromHostIp: '127.0.0.1', fromHostPort: null, ruleset: null, ...extra,
  });
}

export class FlakyOutput {
  up = false;
  resumeProbes = 0;
  readonly delivered: string[] = [];
}

export function flakyModule(state: FlakyOutput): OutputModule {
  return {
    kind: 'output',
    name: 'omflaky',
    builtin: false,
    newActionInstance: (params): ActionModuleInstance => {
      for (const entry of params.entries) entry.used = true;
      return {
        moduleName: 'omflaky',
        templates: [{ name: 'RSYSLOG_TraditionalFileFormat' }],
        description: 'flaky',
        createWorker: () => ({
          doAction: (args) => {
            if (!state.up) return 'suspended';
            state.delivered.push(args.strings[0].replace(/\n$/, ''));
            return 'ok';
          },
          tryResume: () => {
            state.resumeProbes++;
            return state.up ? 'ok' : 'suspended';
          },
          close: () => undefined,
        }),
      };
    },
  };
}

export function catalogWith(...modules: EngineModule[]): BuiltinModuleCatalog {
  return new BuiltinModuleCatalog('/usr/lib/x86_64-linux-gnu/rsyslog', (path) => path.endsWith('.so'), modules);
}
