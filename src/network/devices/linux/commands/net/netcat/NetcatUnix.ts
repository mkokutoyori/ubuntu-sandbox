import type { LinuxCommandContext } from '../../LinuxCommandContext';
import { strerror } from '@/network/core/Errno';
import { OPENBSD_NETCAT_UNIX_LISTEN_BACKLOG } from '../../../ports/ListenBacklogs';
import type { UnixOwner, UnixStreamEnd, UnixStreamListener } from '../../../syslog/LocalDatagramSockets';
import { NetcatExit, parseNetcatArguments, type NetcatOptions } from './NetcatArguments';
import { NcOutput, announceListening, converse } from './NetcatSession';

const SUN_PATH_MAX = 108;
const TEMPORARY_NAME_LENGTH = 6;
const TEMPORARY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function ncUnixClientPath(args: readonly string[]): string | null {
  try {
    const opts = parseNetcatArguments(args);
    if (opts.family !== 'unix' || opts.listen || opts.zero) return null;
    return opts.host;
  } catch (error) {
    if (error instanceof NetcatExit) return null;
    throw error;
  }
}

class Inbox {
  private backlog: string[] = [];
  private readonly readers = new Set<(text: string) => void>();
  private readonly closers = new Set<() => void>();
  private ended = false;

  push(text: string): void {
    if (this.readers.size === 0) this.backlog.push(text);
    else for (const reader of [...this.readers]) reader(text);
  }

  end(): void {
    this.ended = true;
    for (const closer of [...this.closers]) closer();
  }

  onData(handler: (text: string) => void): () => void {
    this.readers.add(handler);
    const queued = this.backlog;
    this.backlog = [];
    for (const text of queued) handler(text);
    return () => { this.readers.delete(handler); };
  }

  onEnd(handler: () => void): () => void {
    this.closers.add(handler);
    if (this.ended) handler();
    return () => { this.closers.delete(handler); };
  }
}

function ownerOf(ctx: LinuxCommandContext): UnixOwner {
  return { pid: ctx.executor.currentPid(), uid: ctx.executor.userMgr.currentUid };
}

function absolute(ctx: LinuxCommandContext, path: string): string {
  return ctx.executor.vfs.normalizePath(path, ctx.executor.getCwd());
}

function socketMode(ctx: LinuxCommandContext): number {
  return 0o777 & ~ctx.executor.getUmask();
}

function temporaryDirectory(): string {
  let name = '';
  for (let index = 0; index < TEMPORARY_NAME_LENGTH; index++) {
    name += TEMPORARY_ALPHABET[Math.floor(Math.random() * TEMPORARY_ALPHABET.length)];
  }
  return `/tmp/nc-${name}`;
}

async function runStreamClient(ctx: LinuxCommandContext, opts: NetcatOptions, stdin: string | undefined, out: NcOutput): Promise<number> {
  const path = opts.host!;
  if (path.length >= SUN_PATH_MAX) {
    out.write('stderr', `nc: ${path}: ${strerror('ENAMETOOLONG')}`);
    return 1;
  }
  const inbox = new Inbox();
  const end: UnixStreamEnd | { readonly errno: Parameters<typeof strerror>[0] } = ctx.executor.connectUnixStream(
    path, { onData: (text) => inbox.push(text), onClose: () => inbox.end() }, ownerOf(ctx));
  if ('errno' in end) {
    out.write('stderr', `nc: ${path}: ${strerror(end.errno)}`);
    return 1;
  }
  if (opts.zero) {
    end.close();
    return 0;
  }
  const status = await converse(ctx, ctx.executor.currentPid(), {
    write: (text) => { end.write(text); },
    close: () => { end.close(); },
    shutdownWrite: () => { end.shutdownWrite(); },
    onData: (handler) => inbox.onData(handler),
    onEnd: (handler) => inbox.onEnd(handler),
  }, opts, stdin, out);
  return status ?? 0;
}

async function runDatagramClient(ctx: LinuxCommandContext, opts: NetcatOptions, stdin: string | undefined, out: NcOutput): Promise<number> {
  const path = opts.host!;
  if (path.length >= SUN_PATH_MAX) {
    out.write('stderr', `nc: ${path}: ${strerror('ENAMETOOLONG')}`);
    return 1;
  }
  const { vfs, userMgr } = ctx.executor;
  const owner = ownerOf(ctx);
  const endpoint = ctx.executor.localDatagramSockets.openDatagram(owner);
  const inbox = new Inbox();
  const temporary = opts.sourceAddress === null ? temporaryDirectory() : null;
  const sourcePath = temporary === null ? opts.sourceAddress! : `${temporary}/recv.sock`;
  const cleanup = (): void => {
    endpoint.close();
    if (temporary === null) return;
    vfs.deleteFile(`${temporary}/recv.sock`);
    vfs.rmdir(temporary);
  };
  if (temporary !== null) vfs.mkdirp(temporary, 0o700, userMgr.currentUid, userMgr.currentGid);
  const bound = endpoint.bind(absolute(ctx, sourcePath), {
    unlink: false, createPath: false, keepFile: true, mode: socketMode(ctx), uid: owner.uid, gid: userMgr.currentGid, owner,
  }, (datagram) => inbox.push(datagram.text));
  if (bound !== null) {
    cleanup();
    out.write('stderr', `nc: ${strerror(bound)}`);
    return 1;
  }
  if (opts.verbose) announceListening(ctx, out, `Bound on ${sourcePath}`);
  const refusal = endpoint.connect(absolute(ctx, path), ctx.executor.unixAccess());
  if (refusal !== null) {
    cleanup();
    out.write('stderr', `nc: ${path}: ${strerror(refusal)}`);
    return 1;
  }
  if (opts.zero) {
    cleanup();
    return 0;
  }
  const status = await converse(ctx, owner.pid, {
    write: (text) => { endpoint.send(text, ctx.executor.wallClockMs()); },
    close: cleanup,
    refused: () => endpoint.refused,
    onData: (handler) => inbox.onData(handler),
  }, opts, stdin, out);
  return status ?? 0;
}

function listenStream(ctx: LinuxCommandContext, opts: NetcatOptions, out: NcOutput, stdin: string | undefined): number {
  const path = opts.host!;
  if (path.length >= SUN_PATH_MAX) throw new NetcatExit([`nc: ${strerror('ENAMETOOLONG')}`]);
  const { userMgr } = ctx.executor;
  const owner = ownerOf(ctx);
  const greeting = stdin ?? '';
  let listener: UnixStreamListener | null = null;
  const outcome = ctx.executor.localDatagramSockets.listenStream(absolute(ctx, path), {
    mode: socketMode(ctx), uid: owner.uid, gid: userMgr.currentGid, unlink: true,
    backlog: OPENBSD_NETCAT_UNIX_LISTEN_BACKLOG, serialAccept: true, owner,
  }, (server) => {
    if (opts.verbose) ctx.executor.emitLateStderr(owner.pid, `Connection received on ${path}\n`);
    let idle: (() => void) | null = null;
    const leave = (): void => {
      idle?.();
      server.close();
      if (opts.keep) listener?.acceptNext();
      else ctx.executor.processMgr.exit(owner.pid, 0);
    };
    const armIdle = (): void => {
      if (opts.timeoutMs <= 0) return;
      idle?.();
      idle = ctx.executor.scheduleAfter(opts.timeoutMs, leave);
    };
    server.setHandlers({
      onData: (text) => {
        ctx.executor.emitLateStdout(owner.pid, text);
        armIdle();
      },
      onClose: leave,
    });
    armIdle();
    if (greeting !== '') server.write(greeting);
  });
  if ('errno' in outcome) throw new NetcatExit([`nc: ${strerror(outcome.errno)}`]);
  listener = outcome;
  if (opts.verbose) {
    announceListening(ctx, out, `Bound on ${path}`);
    announceListening(ctx, out, `Listening on ${path}`);
  }
  return 0;
}

function listenDatagram(ctx: LinuxCommandContext, opts: NetcatOptions, out: NcOutput): number {
  const path = opts.host!;
  if (path.length >= SUN_PATH_MAX) throw new NetcatExit([`nc: ${strerror('ENAMETOOLONG')}`]);
  const owner = ownerOf(ctx);
  let announced = false;
  const outcome = ctx.executor.localDatagramSockets.bind(absolute(ctx, path), {
    unlink: true, createPath: false, keepFile: true, mode: socketMode(ctx), uid: owner.uid, gid: ctx.executor.userMgr.currentGid, owner,
  }, (datagram) => {
    if (opts.verbose && !announced) ctx.executor.emitLateStderr(owner.pid, `Connection received on ${path}\n`);
    announced = !opts.keep;
    ctx.executor.emitLateStdout(owner.pid, datagram.text);
  });
  if ('errno' in outcome) throw new NetcatExit([`nc: ${strerror(outcome.errno)}`]);
  if (opts.verbose) announceListening(ctx, out, `Bound on ${path}`);
  return 0;
}

export function runUnixListen(ctx: LinuxCommandContext, opts: NetcatOptions, out: NcOutput, stdin: string | undefined): number {
  return opts.udp ? listenDatagram(ctx, opts, out) : listenStream(ctx, opts, out, stdin);
}

export function runUnixClient(ctx: LinuxCommandContext, opts: NetcatOptions, stdin: string | undefined, out: NcOutput): Promise<number> {
  return opts.udp ? runDatagramClient(ctx, opts, stdin, out) : runStreamClient(ctx, opts, stdin, out);
}
