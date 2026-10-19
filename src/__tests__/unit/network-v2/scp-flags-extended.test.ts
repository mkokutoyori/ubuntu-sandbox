/**
 * Sonde -- la ligne de commande de `scp` (getopt "12346ABCOTdfpqrtvBCc:F:J:P:S:i:l:o:")
 * et les copies entre deux chemins locaux, qui n'ouvrent aucune connexion.
 *
 * Mesure : `parseScpCommandLine` et `runScpClient` sont NOUVEAUX et remplacent
 * `parseScpArgs`/`ScpSession` ; le fichier ne se charge pas sur la base. TEMOIN : le cas
 * `copies a file between two local paths` prouve que le laboratoire est sain.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { parseScpCommandLine } from '@/network/protocols/ssh/scp/ScpCommandLine';
import { runScpClient, type ScpClientHost } from '@/network/protocols/ssh/scp/ScpClientCommand';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { VfsSftpFileSystem } from '@/network/protocols/ssh/sftp/VfsSftpFileSystem';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
});

function parsed(args: string[]) {
  const outcome = parseScpCommandLine(args);
  if (outcome.kind !== 'parsed') throw new Error('rejected');
  return outcome.line;
}

describe('parseScpCommandLine', () => {
  it('parses bundled switches and counts -v', () => {
    const line = parsed(['-qvvrp', '/a', 'u@h:/b']);
    expect(line.quiet).toBe(true);
    expect(line.recursive).toBe(true);
    expect(line.preserve).toBe(true);
    expect(line.verbosity).toBe(2);
  });

  it('turns -P into the ssh -p and forwards -i, -F, -J, -o and -c to ssh', () => {
    const line = parsed(['-P', '2222', '-i', 'k', '-F', 'cfg', '-J', 'j@b', '-oUserKnownHostsFile=/dev/null', '-c', 'aes128-ctr', '/a', 'u@h:/b']);
    expect(line.sshArguments).toEqual(['-p', '2222', '-i', 'k', '-F', 'cfg', '-J', 'j@b', '-o', 'UserKnownHostsFile=/dev/null', '-c', 'aes128-ctr']);
  });

  it('reads -l as a bandwidth in kbit/s and refuses a value that is not a number', () => {
    expect(parsed(['-l', '500', '/a', 'u@h:/b']).limitKbit).toBe(500);
    expect(parseScpCommandLine(['-l', 'abc', '/a', 'u@h:/b'])).toEqual({ kind: 'rejected', diagnostic: 'scp: bad bandwidth limit: abc' });
  });

  it('-B becomes BatchMode and -3 asks for the relay through the client', () => {
    const line = parsed(['-B', '-3', 'a@h:/x', 'b@k:/y']);
    expect(line.sshArguments).toEqual(['-o', 'BatchMode=yes']);
    expect(line.viaClient).toBe(true);
  });

  it('keeps every operand but the options, and needs at least two', () => {
    expect(parsed(['a.txt', 'b.txt', 'c.txt', 'u@h:/dst']).operands).toEqual(['a.txt', 'b.txt', 'c.txt', 'u@h:/dst']);
    expect(parseScpCommandLine(['only'])).toEqual({ kind: 'rejected', diagnostic: null });
  });

  it('refuses an unknown option and a missing argument with the getopt wording', () => {
    expect(parseScpCommandLine(['-x', 'a', 'b'])).toEqual({ kind: 'rejected', diagnostic: "scp: invalid option -- 'x'" });
    expect(parseScpCommandLine(['-P'])).toEqual({ kind: 'rejected', diagnostic: "scp: option requires an argument -- 'P'" });
  });
});

function hostOver(vfs: VirtualFileSystem): ScpClientHost {
  return {
    local: new VfsSftpFileSystem(vfs, { uid: 0, gid: 0, umask: 0o022 }),
    cwd: '/',
    usage: 'usage: scp',
    umask: 0o022,
    sshPrograms: ['ssh'],
    connect: () => Promise.reject(new Error('a local copy must not connect')),
  };
}

describe('runScpClient between two local paths', () => {
  it('copies a file between two local paths (witness)', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/tmp/payload.txt', 'hello-scp-world', 0, 0, 0o022);
    const result = await runScpClient(['/tmp/payload.txt', '/tmp/copy.txt'], hostOver(vfs), undefined);
    expect(result.exitCode).toBe(0);
    expect(vfs.readFile('/tmp/copy.txt')).toBe('hello-scp-world');
  });

  it('prints the meter unless -q, scaled to the size', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/tmp/payload.txt', 'hello-scp-world', 0, 0, 0o022);
    const loud = await runScpClient(['/tmp/payload.txt', '/tmp/out.txt'], hostOver(vfs), undefined);
    expect(loud.output).toMatch(/^payload\.txt\s+100%\s+15\s+15B\/s\s+00:00$/);
    const quiet = await runScpClient(['-q', '/tmp/payload.txt', '/tmp/out2.txt'], hostOver(vfs), undefined);
    expect(quiet.output).toBe('');
  });

  it('copies two files into a directory and refuses a target that is not one', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/src/a.txt', 'AAA', 0, 0, 0o022);
    vfs.writeFile('/src/b.txt', 'BBB', 0, 0, 0o022);
    vfs.mkdirp('/tmp', 0o755, 0, 0);
    const ok = await runScpClient(['/src/a.txt', '/src/b.txt', '/tmp'], hostOver(vfs), undefined);
    expect(ok.exitCode).toBe(0);
    expect(vfs.readFile('/tmp/b.txt')).toBe('BBB');
    const refused = await runScpClient(['/src/a.txt', '/src/b.txt', '/tmp/a.txt'], hostOver(vfs), undefined);
    expect(refused).toEqual({ output: 'scp: /tmp/a.txt: Not a directory', exitCode: 1 });
  });

  it('reports a missing source and exits 1', async () => {
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/tmp', 0o755, 0, 0);
    const result = await runScpClient(['/tmp/ghost', '/tmp/out'], hostOver(vfs), undefined);
    expect(result).toEqual({ output: 'scp: /tmp/ghost: No such file or directory', exitCode: 1 });
  });

  it('prints the usage after the diagnostic when the command line is wrong', async () => {
    const vfs = new VirtualFileSystem();
    const result = await runScpClient(['-x', 'a', 'b'], hostOver(vfs), undefined);
    expect(result.output).toBe("scp: invalid option -- 'x'\nusage: scp");
    expect(result.exitCode).toBe(1);
  });
});
