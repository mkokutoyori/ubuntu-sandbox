/**
 * Sonde — le serveur SSH sait etre l'AUTRE bout d'un `scp` : un vrai client
 * OpenSSH 8.9 (`scp` historique) lance `scp -t -- <cible>` (puits) ou
 * `scp -f -- <source>` (source) dans un canal `exec`, puis parle le protocole
 * a octets de `scp.c` sur ce canal. Le serveur ne l'executait pas : il
 * passait la ligne a bash, dont le `scp` imprimait `usage: scp [-options]
 * source ... target`, et le client rendait la main avec `lost connection`.
 *
 * Mesure : `ScpServerSession` et `parseScpServerCommand` sont NOUVEAUX, donc
 * le fichier ne se charge pas sur la base (les 12 cas tombent) ; la
 * discrimination reelle est celle du client reel, eprouve HORS DEPOT : avant,
 * `usage: scp ...` et `lost connection` (code 1, aucun fichier) ; apres,
 * `scp up.txt alice@host:/home/alice/scp-up.txt` rend 0 et le fichier est
 * present, octet pour octet. TEMOIN : le puits annonce son pret (`\0`) sur
 * un canal vide -- il prouve que le laboratoire (deux transports reels relies
 * en memoire, un vrai VirtualFileSystem) est sain.
 *
 * Autorite : le protocole source/sink de `scp.c` (OpenSSH 8.9p1) -- une
 * reponse `\0` apres chaque ligne de controle et apres chaque corps suivi de
 * son `\0` final ; `\1`/`\2` suivis d'un message pour un avertissement/une
 * erreur fatale. Les octets attendus sont ecrits en dur.
 */
import { describe, it, expect } from 'vitest';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import { ScpServerSession, parseScpServerCommand } from '@/network/protocols/ssh/scp/ScpServerSession';
import type { ConnectionChannel } from '@/network/protocols/ssh/connection/SshConnection';
import { lab } from './sshConnectionLab';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function fileSystem(): { vfs: VirtualFileSystem; fs: LinuxSftpFSAdapter } {
  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/home/alice', 0o755, 1000, 1000);
  return { vfs, fs: new LinuxSftpFSAdapter(vfs, 1000, 1000) };
}

async function serve(command: string, fs: LinuxSftpFSAdapter): Promise<{ channel: ConnectionChannel; received: () => string; exit: Promise<number> }> {
  const { client, server } = await lab();
  const parsed = parseScpServerCommand(command)!;
  let resolveExit: (code: number) => void = () => undefined;
  const exit = new Promise<number>((resolve) => { resolveExit = resolve; });
  server.onChannelOpen('session', (incoming) => {
    const channel = incoming.accept();
    new ScpServerSession(channel, fs, '/home/alice', parsed, (code) => { channel.eof(); channel.close(); resolveExit(code); }).start();
  });
  const channel = await client.openChannel('session');
  let text = '';
  channel.onData((bytes) => { for (const byte of bytes) text += String.fromCharCode(byte); });
  return { channel, received: () => text, exit };
}

const bytes = (text: string): Uint8Array => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

describe('parseScpServerCommand', () => {
  it('reconnait le puits, la source et leurs options', () => {
    expect(parseScpServerCommand('scp -t -- /home/alice/up.txt')).toEqual({
      role: 'sink', recursive: false, preserveTimes: false, targetMustBeDirectory: false, path: '/home/alice/up.txt',
    });
    expect(parseScpServerCommand('scp -r -p -d -t -- /home/alice')).toEqual({
      role: 'sink', recursive: true, preserveTimes: true, targetMustBeDirectory: true, path: '/home/alice',
    });
    expect(parseScpServerCommand("scp -f -- '/home/alice/a b.txt'")).toMatchObject({ role: 'source', path: '/home/alice/a b.txt' });
  });

  it('refuse ce qui n\'est pas un mode serveur de scp', () => {
    expect(parseScpServerCommand('scp a b')).toBeNull();
    expect(parseScpServerCommand('scp -t -f /x')).toBeNull();
    expect(parseScpServerCommand('echo scp -t /x')).toBeNull();
    expect(parseScpServerCommand('scp -t -z /x')).toBeNull();
  });
});

describe('scp -t : le serveur est le puits', () => {
  it('TEMOIN -- le puits annonce son pret par un octet nul', async () => {
    const { fs } = fileSystem();
    const { received } = await serve('scp -t -- /home/alice/up.txt', fs);
    await tick();
    expect(received()).toBe('\x00');
  });

  it('un fichier : ligne C, accuse, corps + \\0, accuse -- et le fichier est la, octet pour octet', async () => {
    const { vfs, fs } = fileSystem();
    const { channel, received, exit } = await serve('scp -t -- /home/alice/up.txt', fs);
    await tick();
    channel.write(bytes('C0640 11 whatever.txt\n'));
    await tick();
    expect(received()).toBe('\x00\x00');
    channel.write(bytes('hello world\x00'));
    await tick();
    expect(received()).toBe('\x00\x00\x00');
    channel.eof();
    expect(await exit).toBe(0);
    expect(vfs.readFile('/home/alice/up.txt')).toBe('hello world');
    expect(vfs.lstat('/home/alice/up.txt')!.permissions & 0o777).toBe(0o640);
  });

  it('vers un repertoire existant, le fichier prend le nom de la ligne C', async () => {
    const { vfs, fs } = fileSystem();
    const { channel, exit } = await serve('scp -d -t -- /home/alice', fs);
    await tick();
    channel.write(bytes('C0644 3 note.txt\n'));
    await tick();
    channel.write(bytes('abc\x00'));
    await tick();
    channel.eof();
    await exit;
    expect(vfs.readFile('/home/alice/note.txt')).toBe('abc');
  });

  it('-d vers une cible qui n\'est pas un repertoire : erreur fatale \\2 et code 1', async () => {
    const { fs } = fileSystem();
    const { received, exit } = await serve('scp -d -t -- /home/alice/nope', fs);
    expect(await exit).toBe(1);
    expect(received()).toBe('\x02scp: /home/alice/nope: Not a directory\n');
  });

  it('-r : D, C, E recreent l\'arbre', async () => {
    const { vfs, fs } = fileSystem();
    const { channel, received, exit } = await serve('scp -r -d -t -- /home/alice', fs);
    await tick();
    channel.write(bytes('D0755 0 tree\n'));
    await tick();
    channel.write(bytes('C0644 2 leaf.txt\n'));
    await tick();
    channel.write(bytes('hi\x00'));
    await tick();
    channel.write(bytes('E\n'));
    await tick();
    expect(received()).toBe('\x00\x00\x00\x00\x00');
    channel.eof();
    await exit;
    expect(vfs.readFile('/home/alice/tree/leaf.txt')).toBe('hi');
  });

  it('une ligne de controle inconnue : erreur fatale et code 1', async () => {
    const { fs } = fileSystem();
    const { channel, received, exit } = await serve('scp -t -- /home/alice/x', fs);
    await tick();
    channel.write(bytes('Zzz\n'));
    expect(await exit).toBe(1);
    expect(received()).toBe('\x00\x02scp: protocol error: bad control record\n');
  });
});

describe('scp -f : le serveur est la source', () => {
  it('apres le \\0 du client : ligne C, corps + \\0', async () => {
    const { vfs, fs } = fileSystem();
    vfs.writeFile('/home/alice/down.txt', 'payload', 1000, 1000, 0o022);
    const { channel, received, exit } = await serve('scp -f -- /home/alice/down.txt', fs);
    await tick();
    expect(received()).toBe('');
    channel.write(bytes('\x00'));
    await tick();
    expect(received()).toBe('C0644 7 down.txt\n');
    channel.write(bytes('\x00'));
    await tick();
    expect(received()).toBe('C0644 7 down.txt\npayload\x00');
    channel.write(bytes('\x00'));
    expect(await exit).toBe(0);
  });

  it('-r : D, C, E dans l\'ordre', async () => {
    const { vfs, fs } = fileSystem();
    vfs.mkdirp('/home/alice/tree', 0o755, 1000, 1000);
    vfs.writeFile('/home/alice/tree/leaf.txt', 'hi', 1000, 1000, 0o022);
    const { channel, received, exit } = await serve('scp -r -f -- /home/alice/tree', fs);
    await tick();
    for (let i = 0; i < 5; i++) {
      channel.write(bytes('\x00'));
      await tick();
    }
    expect(received()).toBe('D0755 0 tree\nC0644 2 leaf.txt\nhi\x00E\n');
    expect(await exit).toBe(0);
  });

  it('un fichier absent : avertissement \\1 et code 1', async () => {
    const { fs } = fileSystem();
    const { channel, received, exit } = await serve('scp -f -- /home/alice/ghost', fs);
    await tick();
    channel.write(bytes('\x00'));
    expect(await exit).toBe(1);
    expect(received()).toBe('\x01scp: /home/alice/ghost: No such file or directory\n');
  });

  it('un repertoire sans -r : avertissement `not a regular file`', async () => {
    const { fs } = fileSystem();
    const { channel, received, exit } = await serve('scp -f -- /home/alice', fs);
    await tick();
    channel.write(bytes('\x00'));
    expect(await exit).toBe(1);
    expect(received()).toBe('\x01scp: /home/alice: not a regular file\n');
  });
});
