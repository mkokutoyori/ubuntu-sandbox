/**
 * Sonde — les deux roles de `scp.c` (source et puits) sont UN code, partage par le
 * client et par le serveur. Ici ils se parlent par un tube en memoire, chacun sur son
 * propre `VirtualFileSystem`, ce qui est exactement ce que fait `scp a b` entre deux
 * chemins locaux. TEMOIN : `a push of one file arrives byte for byte`.
 *
 * Mesure : `ScpRoles.ts` est NOUVEAU (il remplace `ScpWireTransfer`, `ScpWireClient` et
 * la boucle puits de `ScpServerSession`) ; le fichier ne se charge pas sur la base, les
 * cas tombent tous. Aucun ne passe avant et apres.
 *
 * Autorite : `scp.c` d'OpenSSH 8.9p1 -- source() / rsource() / sink().
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import { memoryPipe, ScpPeer } from '@/network/protocols/ssh/scp/ScpPeer';
import { peerFaultReporter, runScpSink, runScpSource, type ScpNamedPath, type ScpReporter } from '@/network/protocols/ssh/scp/ScpRoles';
import { encodeScpTimes, decodeScpTimes } from '@/network/protocols/ssh/scp/ScpWireCodec';

beforeEach(() => resetCounters());

function machine(): { vfs: VirtualFileSystem; fs: LinuxSftpFSAdapter } {
  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/home/alice', 0o755, 1000, 1000);
  vfs.mkdirp('/dest', 0o755, 1000, 1000);
  return { vfs, fs: new LinuxSftpFSAdapter(vfs, 1000, 1000) };
}

interface Outcome {
  readonly sourceCode: number;
  readonly sinkCode: number;
  readonly sourceFaults: string[];
  readonly sourceRelayed: string[];
}

async function copy(
  source: LinuxSftpFSAdapter, names: ScpNamedPath[], sink: LinuxSftpFSAdapter, target: ScpNamedPath,
  flags: { recursive?: boolean; preserve?: boolean } = {},
): Promise<Outcome> {
  const [sinkEnd, sourceEnd] = memoryPipe();
  const sourceFaults: string[] = [];
  const sourceRelayed: string[] = [];
  const reporter = (faults: string[], relayed: string[]): ScpReporter => ({
    fault: (message) => { faults.push(message); },
    relay: (text) => { relayed.push(text.replace(/\n$/, '')); },
    progress: () => undefined,
    lostConnection: () => { faults.push('lost connection'); },
  });
  const common = { recursive: flags.recursive ?? false, preserve: flags.preserve ?? false, umask: 0o022 };
  const sinkPeer = new ScpPeer(sinkEnd);
  const sinkSide = runScpSink({ peer: sinkPeer, fs: sink, reporter: peerFaultReporter(sinkPeer), ...common }, target);
  const sourcePeer = new ScpPeer(sourceEnd);
  const sourceSide = runScpSource({ peer: sourcePeer, fs: source, reporter: reporter(sourceFaults, sourceRelayed), ...common }, names)
    .then((code) => { sourcePeer.close(); return code; });
  const [sinkCode, sourceCode] = await Promise.all([sinkSide, sourceSide]);
  return { sourceCode, sinkCode, sourceFaults, sourceRelayed };
}

const path = (shown: string): ScpNamedPath => ({ shown, path: shown });

describe('scp source and sink', () => {
  it('a push of one file arrives byte for byte (witness)', async () => {
    const from = machine();
    const to = machine();
    from.vfs.writeFile('/home/alice/a.bin', 'AB\x00\xffCD', 1000, 1000, 0o022);
    const result = await copy(from.fs, [path('/home/alice/a.bin')], to.fs, path('/dest'));
    expect(result.sourceCode).toBe(0);
    expect(result.sinkCode).toBe(0);
    expect(to.vfs.readFile('/dest/a.bin')).toBe('AB\x00\xffCD');
  });

  it('the sink names the file after the target when the target is not a directory', async () => {
    const from = machine();
    const to = machine();
    from.vfs.writeFile('/home/alice/a.txt', 'x', 1000, 1000, 0o022);
    await copy(from.fs, [path('/home/alice/a.txt')], to.fs, path('/dest/renamed.txt'));
    expect(to.vfs.readFile('/dest/renamed.txt')).toBe('x');
    expect(to.vfs.exists('/dest/a.txt')).toBe(false);
  });

  it('several sources travel in one run, each under its own name', async () => {
    const from = machine();
    const to = machine();
    from.vfs.writeFile('/home/alice/one', '1', 1000, 1000, 0o022);
    from.vfs.writeFile('/home/alice/two', '2', 1000, 1000, 0o022);
    await copy(from.fs, [path('/home/alice/one'), path('/home/alice/two')], to.fs, path('/dest'));
    expect(to.vfs.readFile('/dest/one')).toBe('1');
    expect(to.vfs.readFile('/dest/two')).toBe('2');
  });

  it('-r rebuilds a tree with its names and contents', async () => {
    const from = machine();
    const to = machine();
    from.vfs.mkdirp('/home/alice/tree/sub', 0o755, 1000, 1000);
    from.vfs.writeFile('/home/alice/tree/top.txt', 'top', 1000, 1000, 0o022);
    from.vfs.writeFile('/home/alice/tree/sub/leaf.txt', 'leaf', 1000, 1000, 0o022);
    const result = await copy(from.fs, [path('/home/alice/tree')], to.fs, path('/dest'), { recursive: true });
    expect(result.sourceCode).toBe(0);
    expect(to.vfs.readFile('/dest/tree/top.txt')).toBe('top');
    expect(to.vfs.readFile('/dest/tree/sub/leaf.txt')).toBe('leaf');
  });

  it('a directory without -r is refused by the source with scp wording', async () => {
    const from = machine();
    const to = machine();
    const result = await copy(from.fs, [path('/home/alice')], to.fs, path('/dest'));
    expect(result.sourceCode).toBe(1);
    expect(result.sourceFaults).toEqual(['/home/alice: not a regular file']);
  });

  it('a missing source is reported and the others still travel', async () => {
    const from = machine();
    const to = machine();
    from.vfs.writeFile('/home/alice/real', 'r', 1000, 1000, 0o022);
    const result = await copy(from.fs, [path('/home/alice/ghost'), path('/home/alice/real')], to.fs, path('/dest'));
    expect(result.sourceFaults).toEqual(['/home/alice/ghost: No such file or directory']);
    expect(result.sourceCode).toBe(1);
    expect(to.vfs.readFile('/dest/real')).toBe('r');
  });

  it('without -p a new file takes the mode of the source masked by the umask', async () => {
    const from = machine();
    const to = machine();
    from.vfs.writeFile('/home/alice/m', 'm', 1000, 1000, 0o022);
    from.fs.setPermissions('/home/alice/m', 0o666);
    await copy(from.fs, [path('/home/alice/m')], to.fs, path('/dest'));
    expect(to.vfs.lstat('/dest/m')!.permissions & 0o777).toBe(0o644);
  });

  it('without -p an existing file keeps its own mode', async () => {
    const from = machine();
    const to = machine();
    from.vfs.writeFile('/home/alice/k', 'new', 1000, 1000, 0o022);
    to.vfs.writeFile('/dest/k', 'old', 1000, 1000, 0o022);
    to.fs.setPermissions('/dest/k', 0o600);
    await copy(from.fs, [path('/home/alice/k')], to.fs, path('/dest'));
    expect(to.vfs.readFile('/dest/k')).toBe('new');
    expect(to.vfs.lstat('/dest/k')!.permissions & 0o777).toBe(0o600);
  });

  it('-p carries the mode unmasked and the modification time', async () => {
    const from = machine();
    const to = machine();
    from.vfs.writeFile('/home/alice/p', 'p', 1000, 1000, 0o022);
    from.fs.setPermissions('/home/alice/p', 0o666);
    from.fs.setTimes('/home/alice/p', { atime: 1577934245000, mtime: 1577934245000 });
    await copy(from.fs, [path('/home/alice/p')], to.fs, path('/dest'), { preserve: true });
    expect(to.vfs.lstat('/dest/p')!.permissions & 0o777).toBe(0o666);
    expect(to.vfs.lstat('/dest/p')!.mtime).toBe(1577934245000);
  });

  it('a write the sink cannot do is reported to the source as a warning and the run goes on', async () => {
    const from = machine();
    const to = machine();
    from.vfs.writeFile('/home/alice/blocked', 'b', 1000, 1000, 0o022);
    from.vfs.writeFile('/home/alice/fine', 'f', 1000, 1000, 0o022);
    to.vfs.mkdirp('/dest/blocked', 0o755, 1000, 1000);
    const result = await copy(from.fs, [path('/home/alice/blocked'), path('/home/alice/fine')], to.fs, path('/dest'));
    expect(result.sourceRelayed).toEqual(['scp: /dest/blocked: Is a directory']);
    expect(result.sourceCode).toBe(1);
    expect(to.vfs.readFile('/dest/fine')).toBe('f');
  });
});

describe('scp control lines', () => {
  it('a T record round-trips seconds', () => {
    expect(encodeScpTimes({ mtimeMs: 1577934245123, atimeMs: 1577934200000 })).toBe('T1577934245 0 1577934200 0\n');
    expect(decodeScpTimes('T1577934245 0 1577934200 0\n')).toEqual({ mtimeMs: 1577934245000, atimeMs: 1577934200000 });
    expect(decodeScpTimes('T12 0\n')).toBeNull();
  });
});
