import { bytesToBinaryString } from '@/crypto/encoding';
import type { ISftpFileSystem } from '../sftp/ISftpFileSystem';
import type { ScpPeer } from './ScpPeer';
import {
  decodeScpControlLine, decodeScpTimes, encodeScpControlLine, encodeScpTimes, scpModeString, SCP_ACK,
  type ScpTimes,
} from './ScpWireCodec';

export interface ScpReporter {
  fault(message: string): void;
  relay(text: string): void;
  progress(name: string, bytes: number): void;
  lostConnection(): void;
}

export interface ScpRoleEnvironment {
  readonly peer: ScpPeer;
  readonly fs: ISftpFileSystem;
  readonly recursive: boolean;
  readonly preserve: boolean;
  readonly umask: number;
  readonly reporter: ScpReporter;
}

export interface ScpNamedPath {
  readonly shown: string;
  readonly path: string;
}

export function peerFaultReporter(peer: ScpPeer): ScpReporter {
  return {
    fault: (message) => peer.write(`\x01scp: ${message}\n`),
    relay: () => undefined,
    progress: () => undefined,
    lostConnection: () => undefined,
  };
}

class ScpTermination extends Error {
  constructor(readonly exitCode: number) {
    super('scp terminated');
  }
}

const MAXIMUM_LINK_DEPTH = 8;

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

function joinPath(directory: string, name: string): string {
  return `${directory.replace(/\/+$/, '')}/${name}`;
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash <= 0 ? '/' : trimmed.slice(0, slash);
}

function resolveLinks(fs: ISftpFileSystem, path: string): string {
  let current = path;
  for (let depth = 0; depth < MAXIMUM_LINK_DEPTH; depth++) {
    if (fs.getEntryType(current) !== 'symlink' || fs.readSymlink === undefined) return current;
    const target = fs.readSymlink(current);
    if (!target.ok) return current;
    current = fs.normalizePath(target.value, parentOf(current));
  }
  return current;
}

function deniedByMessage(error: { readonly kind: string; readonly message?: string }): boolean {
  return error.kind === 'PERMISSION_DENIED' || /denied/i.test(error.message ?? '');
}

export function describeScpReadFailure(error: { readonly kind: string; readonly message?: string }): string {
  return deniedByMessage(error) ? 'Permission denied' : 'No such file or directory';
}

export function describeScpFailure(fs: ISftpFileSystem, path: string, error: { readonly kind: string; readonly message?: string }): string {
  if (deniedByMessage(error)) return 'Permission denied';
  const parent = parentOf(path);
  if (fs.getEntryType(parent) === null) return 'No such file or directory';
  if (fs.getEntryType(parent) !== 'directory') return 'Not a directory';
  return 'Permission denied';
}

async function acknowledgement(env: ScpRoleEnvironment, tally: { errors: number }): Promise<boolean> {
  const response = await env.peer.response();
  switch (response.kind) {
    case 'ok': return true;
    case 'warning':
      env.reporter.relay(response.text);
      tally.errors++;
      return false;
    case 'fatal':
    case 'foreign':
      env.reporter.relay(response.text);
      throw new ScpTermination(1);
    case 'eof':
      env.reporter.lostConnection();
      throw new ScpTermination(1);
  }
}

async function sendTimes(env: ScpRoleEnvironment, tally: { errors: number }, mtimeMs: number): Promise<boolean> {
  env.peer.write(encodeScpTimes({ mtimeMs, atimeMs: mtimeMs }));
  return acknowledgement(env, tally);
}

async function sourceDirectory(
  env: ScpRoleEnvironment, tally: { errors: number }, entry: ScpNamedPath, mode: number, mtime: number,
): Promise<void> {
  const listed = env.fs.listDirectory(entry.path);
  if (listed.ok === false) {
    env.reporter.fault(`${entry.shown}: ${describeScpReadFailure(listed.error)}`);
    tally.errors++;
    return;
  }
  if (env.preserve && !await sendTimes(env, tally, mtime)) return;
  env.peer.write(encodeScpControlLine({ kind: 'D', mode: scpModeString(mode), name: baseName(entry.path) }));
  if (!await acknowledgement(env, tally)) return;
  for (const child of listed.value) {
    if (child.name === '.' || child.name === '..') continue;
    await sourceEntry(env, tally, { shown: joinPath(entry.shown, child.name), path: joinPath(entry.path, child.name) });
  }
  env.peer.write(encodeScpControlLine({ kind: 'E', mode: '', name: '' }));
  await acknowledgement(env, tally);
}

async function sourceEntry(env: ScpRoleEnvironment, tally: { errors: number }, entry: ScpNamedPath): Promise<void> {
  const resolved = resolveLinks(env.fs, entry.path);
  const stat = env.fs.stat(resolved);
  if (stat.ok === false) {
    env.reporter.fault(`${entry.shown}: ${describeScpReadFailure(stat.error)}`);
    tally.errors++;
    return;
  }
  const kind = env.fs.getEntryType(resolved);
  if (kind === 'directory' && env.recursive) {
    await sourceDirectory(env, tally, { shown: entry.shown, path: resolved }, stat.value.mode, stat.value.mtime);
    return;
  }
  if (kind !== 'file') {
    env.reporter.fault(`${entry.shown}: not a regular file`);
    tally.errors++;
    return;
  }
  const content = env.fs.readFile(resolved);
  if (content.ok === false) {
    env.reporter.fault(`${entry.shown}: ${describeScpReadFailure(content.error)}`);
    tally.errors++;
    return;
  }
  if (env.preserve && !await sendTimes(env, tally, stat.value.mtime)) return;
  const name = baseName(entry.path);
  env.peer.write(encodeScpControlLine({ kind: 'C', mode: scpModeString(stat.value.mode), size: content.value.length, name }));
  if (!await acknowledgement(env, tally)) return;
  env.peer.write(`${content.value}\x00`);
  if (!await acknowledgement(env, tally)) return;
  env.reporter.progress(name, content.value.length);
}

export async function runScpSource(env: ScpRoleEnvironment, names: readonly ScpNamedPath[]): Promise<number> {
  const tally = { errors: 0 };
  try {
    const initial = await env.peer.response();
    if (initial.kind === 'eof') {
      env.reporter.lostConnection();
      return 1;
    }
    if (initial.kind !== 'ok') {
      env.reporter.relay(initial.text);
      return 1;
    }
    for (const name of names) await sourceEntry(env, tally, name);
    return tally.errors === 0 ? 0 : 1;
  } catch (failure) {
    if (failure instanceof ScpTermination) return failure.exitCode;
    throw failure;
  }
}

interface SinkState {
  readonly tally: { errors: number };
  pendingTimes: ScpTimes | null;
}

function sinkMode(env: ScpRoleEnvironment, requested: number, existed: boolean): number | null {
  if (env.preserve) return requested;
  return existed ? null : requested & ~env.umask;
}

async function sinkDirectoryBody(env: ScpRoleEnvironment, state: SinkState, directory: string): Promise<void> {
  await sinkLoop(env, state, directory, true, false);
}

async function sinkLoop(
  env: ScpRoleEnvironment, state: SinkState, target: string, targetIsDirectory: boolean, topLevel: boolean,
): Promise<void> {
  for (let first = true; ; first = false) {
    const raw = await env.peer.line();
    if (raw === null) return;
    if (raw === '\n') {
      env.reporter.fault('protocol error: unexpected <newline>');
      throw new ScpTermination(1);
    }
    const marker = raw.charCodeAt(0);
    if (marker === SCP_ACK.WARNING || marker === SCP_ACK.FATAL) {
      env.reporter.relay(raw.slice(1));
      if (marker === SCP_ACK.FATAL) throw new ScpTermination(1);
      state.tally.errors++;
      continue;
    }
    if (raw.startsWith('E')) {
      env.peer.acknowledge();
      return;
    }
    if (raw.startsWith('T')) {
      const times = decodeScpTimes(raw);
      if (times === null) {
        env.reporter.fault('protocol error: atime.sec not delimited');
        throw new ScpTermination(1);
      }
      state.pendingTimes = times;
      env.peer.acknowledge();
      continue;
    }
    const control = decodeScpControlLine(raw);
    if (control === null || control.kind === 'E') {
      if (first && topLevel) {
        env.reporter.fault(raw.replace(/\n$/, ''));
      } else {
        env.reporter.fault('protocol error: expected control record');
      }
      throw new ScpTermination(1);
    }
    if (control.name.includes('/') || control.name === '..') {
      env.reporter.fault(`error: unexpected filename: ${control.name}`);
      throw new ScpTermination(1);
    }
    const destination = targetIsDirectory ? joinPath(target, control.name) : target;
    const existed = env.fs.getEntryType(destination) !== null;
    const requested = parseInt(control.mode, 8);
    const times = state.pendingTimes;
    state.pendingTimes = null;
    if (control.kind === 'D') {
      if (!env.recursive) {
        env.reporter.fault('protocol error: received directory without -r');
        throw new ScpTermination(1);
      }
      if (existed && env.fs.getEntryType(destination) !== 'directory') {
        env.reporter.fault(`${destination}: Not a directory`);
        state.tally.errors++;
        continue;
      }
      if (!existed) {
        const made = env.fs.mkdir(destination);
        if (made.ok === false) {
          env.reporter.fault(`${destination}: ${describeScpFailure(env.fs, destination, made.error)}`);
          state.tally.errors++;
          continue;
        }
      }
      env.peer.acknowledge();
      await sinkDirectoryBody(env, state, destination);
      if (times !== null) env.fs.setTimes?.(destination, { atime: times.atimeMs, mtime: times.mtimeMs });
      if (env.preserve || !existed) env.fs.setPermissions(destination, requested);
      continue;
    }
    if (existed && env.fs.getEntryType(destination) === 'directory') {
      env.reporter.fault(`${destination}: Is a directory`);
      state.tally.errors++;
      continue;
    }
    const probe = env.fs.writeFile(destination, '');
    if (probe.ok === false) {
      env.reporter.fault(`${destination}: ${describeScpFailure(env.fs, destination, probe.error)}`);
      state.tally.errors++;
      continue;
    }
    env.peer.acknowledge();
    const data = await env.peer.take(control.size ?? 0);
    const trailer = data === null ? null : await env.peer.take(1);
    if (data === null || trailer === null) {
      env.reporter.lostConnection();
      throw new ScpTermination(1);
    }
    const written = env.fs.writeFile(destination, bytesToBinaryString(data));
    if (written.ok === false) {
      env.reporter.fault(`${destination}: ${describeScpFailure(env.fs, destination, written.error)}`);
      state.tally.errors++;
    } else {
      const mode = sinkMode(env, requested, existed);
      if (mode !== null) env.fs.setPermissions(destination, mode);
      if (times !== null) env.fs.setTimes?.(destination, { atime: times.atimeMs, mtime: times.mtimeMs });
      env.reporter.progress(control.name, data.length);
    }
    if (trailer[0] !== SCP_ACK.OK) state.tally.errors++;
    env.peer.acknowledge();
  }
}

export async function runScpSink(env: ScpRoleEnvironment, target: ScpNamedPath): Promise<number> {
  const state: SinkState = { tally: { errors: 0 }, pendingTimes: null };
  try {
    env.peer.acknowledge();
    await sinkLoop(env, state, target.path, env.fs.getEntryType(target.path) === 'directory', true);
    return state.tally.errors === 0 ? 0 : 1;
  } catch (failure) {
    if (failure instanceof ScpTermination) return failure.exitCode;
    throw failure;
  }
}
