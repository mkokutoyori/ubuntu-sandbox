import type { Errno } from '@/network/core/Errno';
import type { StreamTlsOptions } from './StreamDriver';

export interface RsyslogClock {
  wallMs(): number;
  monotonicMs(): number;
}

export interface OpenFileOptions {
  readonly mode: number;
  readonly directoryMode: number;
  readonly uid: number | null;
  readonly gid: number | null;
  readonly directoryUid: number | null;
  readonly directoryGid: number | null;
  readonly createDirectories: boolean;
  readonly failOnChownFailure: boolean;
  readonly followSymlinks?: boolean;
}

export interface FileHandle {
  readonly path: string;
  write(text: string): string | null;
  flush(): void;
  close(): void;
}

export interface OpenNotice {
  readonly kind: 'directory-chown' | 'file-chown';
  readonly path: string;
  readonly reason: string;
}

export type OpenFileResult =
  | { readonly handle: FileHandle; readonly notices?: readonly OpenNotice[] }
  | { readonly error: string; readonly notices?: readonly OpenNotice[]; readonly step?: 'parents' | 'chown' };

export interface RsyslogFiles {
  open(path: string, options: OpenFileOptions): OpenFileResult;
  read(path: string): string | null;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  isSymbolicLink(path: string): boolean;
  list(directory: string): string[];
  glob(pattern: string): string[];
  statSize(path: string): number | null;
  readFrom(path: string, offset: number): { text: string; size: number; inode: string } | null;
  write(path: string, text: string): boolean;
}

export interface TerminalSink {
  write(text: string): void;
}

export interface RsyslogUsers {
  uidOf(name: string): number | null;
  gidOf(name: string): number | null;
  userExists(name: string): boolean;
  loggedInTerminals(user: string): TerminalSink[];
  allLoggedInTerminals(): { user: string; sink: TerminalSink }[];
}

export interface Datagram {
  readonly sourceIp: string;
  readonly sourcePort: number;
  readonly payload: Uint8Array;
}

export interface StreamConnection {
  readonly remoteIp: string;
  readonly remotePort: number;
  readonly closedByPeer: boolean;
  write(bytes: Uint8Array): Errno | null;
  close(): void;
  onData(handler: (bytes: Uint8Array) => void): void;
  onClose(handler: () => void): void;
}

export type Resolution = { readonly addresses: string[] } | { readonly error: string };

export interface SrvRecord {
  readonly host: string;
  readonly port: number;
  readonly priority: number;
  readonly weight: number;
}

export interface DatagramOptions {
  readonly sourceAddress?: string;
  readonly device?: string;
  readonly sendBufferBytes?: number;
  readonly freeBind?: boolean;
}

export interface StreamOptions {
  readonly tls?: StreamTlsOptions;
  readonly device?: string;
  readonly networkNamespace?: string;
  readonly userTimeoutMs?: number;
  readonly keepAlive?: { readonly probes: number; readonly timeSeconds: number; readonly intervalSeconds: number };
}

export type AddressFamilyPolicy = 'unspecified' | 'ipv4-only' | 'ipv6-only';

export interface ListenOptions {
  readonly tls?: StreamTlsOptions;
  readonly family: AddressFamilyPolicy;
  readonly receiveBufferBytes?: number;
  readonly device?: string;
  readonly freeBind: 0 | 1 | 2;
}

export interface Listener {
  readonly family: 'IPv4' | 'IPv6';
  readonly address: string;
  readonly port: number;
  close(): void;
}

export interface ListenOutcome {
  readonly listeners: Listener[];
  readonly failures: { readonly family: 'IPv4' | 'IPv6'; readonly errno: Errno }[];
  readonly resolveError?: string;
}

export interface RsyslogNetwork {
  resolve(name: string): Resolution;
  reverse(address: string): string | null;
  service(name: string, protocol: 'tcp' | 'udp'): number | null;
  resolveSrv(name: string): SrvRecord[] | { readonly error: string };
  sendDatagram(address: string, port: number, payload: Uint8Array, options?: DatagramOptions): Errno | null;
  connectStream(address: string, port: number, options?: StreamOptions): StreamConnection | { readonly errno: Errno };
  listenDatagram(port: number, address: string | null, options: ListenOptions, onDatagram: (datagram: Datagram) => void): ListenOutcome;
  listenStream(port: number, address: string | null, options: ListenOptions, onAccept: (connection: StreamConnection) => void): ListenOutcome;
}

export interface LocalSocketOptions {
  readonly unlink: boolean;
  readonly createPath: boolean;
  readonly credentials: boolean;
}

export interface LocalSocketMessage {
  readonly text: string;
  readonly pid: number | null;
  readonly uid: number | null;
  readonly gid: number | null;
  readonly receivedAtMs: number | null;
}

export interface ProcessDetails {
  readonly comm: string;
  readonly exe: string;
  readonly cmdline: string;
}

export type LocalSocketBinding = { readonly close: () => void; readonly acquiredFromSupervisor: boolean } | { readonly errno: Errno };

export interface RsyslogLocalSockets {
  listen(path: string, options: LocalSocketOptions, onMessage: (message: LocalSocketMessage) => void): LocalSocketBinding;
  isSocket(path: string): boolean;
  systemdBooted(): boolean;
  processDetails(pid: number): ProcessDetails | null;
  isAlive(pid: number): boolean;
  ownPid(): number;
}

export interface RsyslogKernelLog {
  open(path: string, onData: (chunk: string) => void): { readonly close: () => void } | { readonly errno: Errno };
  setConsoleLogLevel(level: number): Errno | null;
  restoreConsoleLogLevel(): void;
}

export interface RsyslogProcess {
  setSupplementaryGroups(gids: readonly number[]): Errno | null;
  initSupplementaryGroups(userName: string, gid: number): Errno | null;
  setGid(gid: number): Errno | null;
  setUid(uid: number): Errno | null;
  userNameOf(uid: number): string | null;
  currentGid(): number;
  setUmask(mask: number): void;
  run?(argv: readonly string[]): number;
  setOpenFilesLimit(limit: number): { readonly errno: Errno; readonly hardLimit: number } | null;
}

export interface RsyslogHost {
  readonly process?: RsyslogProcess;
  readonly clock: RsyslogClock;
  readonly files: RsyslogFiles;
  readonly users: RsyslogUsers;
  readonly network: RsyslogNetwork;
  readonly sockets: RsyslogLocalSockets;
  readonly kernelLog?: RsyslogKernelLog;
  hostname(): string;
  domainName(): string | null;
  timezone(): string | undefined;
  environment(name: string): string | undefined;
  random(): number;
  localAddresses(): string[];
  bootTimeMs(): number;
  schedule(callback: () => void, delayMs: number): () => void;
  scheduleEvery(callback: () => void, periodMs: number): () => void;
  syslog?(priority: number, message: string): void;
}
