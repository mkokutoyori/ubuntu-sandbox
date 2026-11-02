/**
 * A file crosses scp, sftp, ftp and tftp byte for byte, and a capture exported from a router reaches a TFTP server as a savefile tcpdump reads.
 *
 * The virtual file system keeps a file as text: UTF-8 where the bytes are UTF-8, one escape unit (U+DC80 + byte) for a byte that is not
 * (`bytesToFileText` / `fileTextToBytes`). The wire modules (scp, sftp, ftp, tftp) turn a string into bytes one char per byte. The adapter
 * between the two (`LinuxSftpFSAdapter`) handed the file text over as it was, so a byte above 0x7f left as two (a valid UTF-8 pair read as a
 * Latin-1 pair, an invalid byte as the two bytes of its escape), and arrived as the escape of those.
 *
 * Measured on a 600-byte payload holding a valid UTF-8 pair, an invalid byte pair, a NUL and a CRLF, in a lab of two Linux machines and one
 * Cisco router: `scp` upload stored 882 bytes where 600 were sent, and so did `tftp` put; a valid UTF-8 pair sent through `scp` arrived as one
 * Latin-1 byte. The `ftp` cases, the router's `copy flash: tftp:` of a binary file and the export of a capture to a TFTP server fall for the same
 * reason (the exported file was not a savefile once stored), and the `bytes copied` line counted UTF-16 units of the file text, not bytes.
 * Two adapters of the same contract existed (`LinuxSftpFSAdapter` for the servers, `VfsSftpFileSystem` for the local side of `scp` and
 * `sftp`); both now convert through `wireStringOfFileText` / `fileTextOfWireString` (`@/crypto/encoding`), and so do the router's TFTP copy, the
 * file boundaries of curl (`-o`, `-T`, `-F` parts) and the static files of nginx and apache, which turned the file text into bytes one char per
 * byte (a valid UTF-8 pair served as one Latin-1 byte).
 *
 * Discriminated against the previous state (`git stash` of the two adapters, `CiscoTftpCopy`, `CurlEngine`, `CurlTransfer` and the nginx and apache services, the probe kept): 12 of the 15 cases fall. The three that pass either
 * way are the WITNESS (an ASCII payload crossing scp, which proves the lab, the key, the account and the transfer all work) and the two curl-over-ftp
 * cases: before the change both ends read and wrote file text unconverted, so the file arrived intact while its bytes on the wire were wrong; they
 * are non-regression for the end-to-end result.
 *
 * Not covered, recorded in TODO.md: the FortiOS TFTP callers, the Windows file system behind the same contract, `wget -O`, curl `-d @file`, and
 * the size of a file holding bytes above 0x7f (the inode counts UTF-16 units of the text).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { bytesToBinaryString, bytesToFileText, fileTextToBytes, binaryStringToBytes } from '@/crypto/encoding';
import { TftpServer, TftpClientSession } from '@/network/tftp/TftpSession';
import { FtpServer } from '@/network/ftp/FtpServer';
import { FtpClientSession } from '@/network/ftp/FtpClientSession';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import { decodePcap } from '@/network/capture/pcap/PcapFile';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.clear();
});

const PAYLOAD = (() => {
  const bytes = Uint8Array.from({ length: 600 }, (_, index) => (index * 7 + 3) & 0xff);
  bytes.set([0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xff, 0xfe, 0x00, 0x0d, 0x0a, 0xc3, 0xa9], 20);
  return bytes;
})();

const ASCII_PAYLOAD = Uint8Array.from({ length: 600 }, (_, index) => 0x20 + (index % 90));

const vfsOf = (machine: unknown): VirtualFileSystem => (machine as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const bytesIn = (vfs: VirtualFileSystem, path: string): Uint8Array | null => {
  const text = vfs.readFile(path);
  return text === null ? null : fileTextToBytes(text);
};
const hex = (bytes: Uint8Array | null): string => bytes === null ? 'missing' : Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

async function sshLab() {
  const client = new LinuxPC('linux-pc', 'CLI');
  const server = new LinuxServer('linux-server', 'SRV');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(server.getPorts()[0], sw.getPorts()[1]);
  client.getPorts()[0].configureIP(new IPAddress('10.90.0.10'), new SubnetMask('255.255.255.0'));
  server.getPorts()[0].configureIP(new IPAddress('10.90.0.20'), new SubnetMask('255.255.255.0'));
  client.powerOn();
  server.powerOn();
  await server.executeCommand('useradd -m -s /bin/bash alice');
  await client.executeCommand('ssh-keygen -t rsa -N "" -f ~/.ssh/id_rsa');
  const publicKey = (await client.executeCommand('cat ~/.ssh/id_rsa.pub')).trim();
  for (const line of ['mkdir -p /home/alice/.ssh', `sh -c 'echo "${publicKey}" > /home/alice/.ssh/authorized_keys'`,
    'chmod 700 /home/alice/.ssh', 'chmod 600 /home/alice/.ssh/authorized_keys', 'chown -R alice:alice /home/alice/.ssh']) {
    await server.executeCommand(line);
  }
  const uid = Number((await server.executeCommand('id -u alice')).trim());
  const gid = Number((await server.executeCommand('id -g alice')).trim());
  return { client, server, uid, gid };
}

describe('scp and sftp move the bytes of a file', () => {
  it('WITNESS: an ASCII file crosses scp unchanged', async () => {
    const { client, server } = await sshLab();
    vfsOf(client).writeFile('/tmp/ascii.dat', bytesToFileText(ASCII_PAYLOAD), 1000, 1000, 0o022);
    await client.executeCommand('scp /tmp/ascii.dat alice@10.90.0.20:/home/alice/ascii.dat');
    expect(hex(bytesIn(vfsOf(server), '/home/alice/ascii.dat'))).toBe(hex(ASCII_PAYLOAD));
  });

  it('scp upload stores the bytes that were sent', async () => {
    const { client, server } = await sshLab();
    vfsOf(client).writeFile('/tmp/bin.dat', bytesToFileText(PAYLOAD), 1000, 1000, 0o022);
    await client.executeCommand('scp /tmp/bin.dat alice@10.90.0.20:/home/alice/up.dat');
    expect(hex(bytesIn(vfsOf(server), '/home/alice/up.dat'))).toBe(hex(PAYLOAD));
  });

  it('scp download stores the bytes that were served', async () => {
    const { client, server, uid, gid } = await sshLab();
    vfsOf(server).writeFile('/home/alice/down.src', bytesToFileText(PAYLOAD), uid, gid, 0o022);
    await client.executeCommand('scp alice@10.90.0.20:/home/alice/down.src /tmp/down.dat');
    expect(hex(bytesIn(vfsOf(client), '/tmp/down.dat'))).toBe(hex(PAYLOAD));
  });

  it('sftp put stores the bytes that were sent', async () => {
    const { client, server } = await sshLab();
    vfsOf(client).writeFile('/tmp/bin.dat', bytesToFileText(PAYLOAD), 1000, 1000, 0o022);
    await client.executeCommand("sftp alice@10.90.0.20 <<'EOF'\nput /tmp/bin.dat /home/alice/sf-up.dat\nbye\nEOF");
    expect(hex(bytesIn(vfsOf(server), '/home/alice/sf-up.dat'))).toBe(hex(PAYLOAD));
  });

  it('sftp get stores the bytes that were served', async () => {
    const { client, server, uid, gid } = await sshLab();
    vfsOf(server).writeFile('/home/alice/sf-down.src', bytesToFileText(PAYLOAD), uid, gid, 0o022);
    await client.executeCommand("sftp alice@10.90.0.20 <<'EOF'\nget /home/alice/sf-down.src /tmp/sf-down.dat\nbye\nEOF");
    expect(hex(bytesIn(vfsOf(client), '/tmp/sf-down.dat'))).toBe(hex(PAYLOAD));
  });
});

describe('ftp and tftp move the bytes of a file', () => {
  async function pair() {
    const client = new LinuxPC('linux-pc', 'CLI');
    const server = new LinuxServer('linux-server', 'SRV');
    client.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    server.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(client.getPort('eth0')!, server.getPort('eth0')!);
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/srv/files', 0o755, 1000, 1000);
    return { client, server, vfs, fs: new LinuxSftpFSAdapter(vfs, 1000, 1000) };
  }

  it('ftp STOR stores the bytes that were sent', async () => {
    const { client, server, vfs, fs } = await pair();
    new FtpServer(server.getTcpStack(), '10.0.1.10', { users: new Map([['alice', 'wonderland']]), fs, rootPath: '/srv/files' }).start();
    const session = new FtpClientSession(client.getTcpStack(), '10.0.1.10', '10.0.1.2');
    session.connect();
    session.sendCommand({ verb: 'USER', argument: 'alice' });
    session.sendCommand({ verb: 'PASS', argument: 'wonderland' });
    session.enterPassiveMode();
    session.storeFile('up.dat', bytesToBinaryString(PAYLOAD));
    expect(hex(bytesIn(vfs, '/srv/files/up.dat'))).toBe(hex(PAYLOAD));
  });

  it('ftp RETR serves the bytes that were stored', async () => {
    const { client, server, vfs, fs } = await pair();
    vfs.writeFile('/srv/files/down.dat', bytesToFileText(PAYLOAD), 1000, 1000, 0o022);
    new FtpServer(server.getTcpStack(), '10.0.1.10', { users: new Map([['alice', 'wonderland']]), fs, rootPath: '/srv/files' }).start();
    const session = new FtpClientSession(client.getTcpStack(), '10.0.1.10', '10.0.1.2');
    session.connect();
    session.sendCommand({ verb: 'USER', argument: 'alice' });
    session.sendCommand({ verb: 'PASS', argument: 'wonderland' });
    session.enterPassiveMode();
    const { content } = session.retrieveFile('down.dat');
    expect(hex(binaryStringToBytes(content ?? ''))).toBe(hex(PAYLOAD));
  });

  it('tftp put stores the bytes that were sent', async () => {
    const { client, server, vfs, fs } = await pair();
    new TftpServer(server, { fs, rootPath: '/srv/files' }).start();
    const put = await new TftpClientSession(client, new IPAddress('10.0.1.10')).put('up.dat', bytesToBinaryString(PAYLOAD));
    expect(put.ok).toBe(true);
    expect(hex(bytesIn(vfs, '/srv/files/up.dat'))).toBe(hex(PAYLOAD));
  });
});

describe('curl moves the bytes of a file', () => {
  async function pair() {
    const client = new LinuxPC('linux-pc', 'CLI');
    const server = new LinuxServer('linux-server', 'SRV');
    client.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    server.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(client.getPort('eth0')!, server.getPort('eth0')!);
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/srv/files', 0o755, 1000, 1000);
    new FtpServer(server.getTcpStack(), '10.0.1.10', {
      users: new Map([['alice', 'wonderland']]), fs: new LinuxSftpFSAdapter(vfs, 1000, 1000), rootPath: '/srv/files',
    }).start();
    return { client, server, vfs };
  }

  it('curl -o over http stores the bytes that were served', async () => {
    const { client, server } = await pair();
    await server.executeCommand('apt install -y nginx');
    await server.executeCommand('systemctl start nginx');
    vfsOf(server).writeFile('/var/www/html/bin.dat', bytesToFileText(PAYLOAD), 0, 0, 0o022);
    await client.executeCommand('curl -s -o /tmp/got.dat http://10.0.1.10/bin.dat');
    expect(hex(bytesIn(vfsOf(client), '/tmp/got.dat'))).toBe(hex(PAYLOAD));
  });

  it('curl -o over http stores the bytes that apache served', async () => {
    const { client, server } = await pair();
    await server.executeCommand('apt install -y apache2');
    await server.executeCommand('systemctl start apache2');
    vfsOf(server).writeFile('/var/www/html/bin.dat', bytesToFileText(PAYLOAD), 0, 0, 0o022);
    await client.executeCommand('curl -s -o /tmp/got.dat http://10.0.1.10/bin.dat');
    expect(hex(bytesIn(vfsOf(client), '/tmp/got.dat'))).toBe(hex(PAYLOAD));
  });

  it('curl -T over ftp stores the bytes that were read from the file', async () => {
    const { client, vfs } = await pair();
    vfsOf(client).writeFile('/tmp/up.dat', bytesToFileText(PAYLOAD), 0, 0, 0o022);
    await client.executeCommand('curl -s -T /tmp/up.dat ftp://alice:wonderland@10.0.1.10/up.dat');
    expect(hex(bytesIn(vfs, '/srv/files/up.dat'))).toBe(hex(PAYLOAD));
  });

  it('curl -o over ftp stores the bytes that were retrieved', async () => {
    const { client, vfs } = await pair();
    vfs.writeFile('/srv/files/down.dat', bytesToFileText(PAYLOAD), 1000, 1000, 0o022);
    await client.executeCommand('curl -s -o /tmp/down.dat ftp://alice:wonderland@10.0.1.10/down.dat');
    expect(hex(bytesIn(vfsOf(client), '/tmp/down.dat'))).toBe(hex(PAYLOAD));
  });
});

describe('a router sends its capture to a TFTP server as a savefile', () => {
  async function routerAndServer() {
    const router = new CiscoRouter('R1');
    const server = new LinuxServer('linux-server', 'SRV');
    new Cable('c1').connect(router.getPort('GigabitEthernet0/0')!, server.getPort('eth0')!);
    for (const line of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit', 'end']) {
      await router.executeCommand(line);
    }
    await server.executeCommand('ip addr add 10.0.1.10/24 dev eth0');
    await server.executeCommand('ip link set eth0 up');
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/srv/tftp', 0o755, 1000, 1000);
    new TftpServer(server, { fs: new LinuxSftpFSAdapter(vfs, 1000, 1000), rootPath: '/srv/tftp' }).start();
    return { router, server, vfs };
  }

  it('copy flash: tftp: stores the bytes of a binary flash file and counts bytes', async () => {
    const { router, vfs } = await routerAndServer();
    const flash = (router as unknown as { _getCiscoFileSystem(profile: string): { write(name: string, content: string): void } })
      ._getCiscoFileSystem('router-isr2911');
    flash.write('bin.dat', bytesToFileText(PAYLOAD));
    await router.executeCommand('enable');
    const reply = await router.executeCommand('copy flash:bin.dat tftp://10.0.1.10/bin.dat');
    expect(hex(bytesIn(vfs, '/srv/tftp/bin.dat'))).toBe(hex(PAYLOAD));
    expect(reply).toContain(`${PAYLOAD.length} bytes copied`);
  });

  it('monitor capture buffer export tftp: delivers a savefile with the captured packets', async () => {
    const { router, server, vfs } = await routerAndServer();
    for (const line of ['monitor capture buffer BUF size 512 max-size 128 circular', 'monitor capture point ip cef P1 GigabitEthernet0/0 both',
      'monitor capture point associate P1 BUF', 'monitor capture point start P1']) await router.executeCommand(line);
    await server.executeCommand('ping -c 2 10.0.1.1');
    await router.executeCommand('monitor capture point stop P1');
    const reply = await router.executeCommand('monitor capture buffer BUF export tftp://10.0.1.10/cap.pcap');
    expect(reply).not.toMatch(/Error|%/);
    const stored = bytesIn(vfs, '/srv/tftp/cap.pcap');
    expect(stored).not.toBeNull();
    const read = decodePcap(stored!);
    expect(read.kind === 'file' && read.failure).toBeNull();
    expect(read.kind === 'file' && read.records.length).toBeGreaterThanOrEqual(2);
  });

  it('the delivered savefile is read by tcpdump and classified by file', async () => {
    const { router, server, vfs } = await routerAndServer();
    for (const line of ['monitor capture buffer BUF size 512 max-size 128 circular', 'monitor capture point ip cef P1 GigabitEthernet0/0 both',
      'monitor capture point associate P1 BUF', 'monitor capture point start P1']) await router.executeCommand(line);
    await server.executeCommand('ping -c 2 10.0.1.1');
    await router.executeCommand('monitor capture point stop P1');
    await router.executeCommand('monitor capture buffer BUF export tftp://10.0.1.10/cap.pcap');
    vfsOf(server).writeFile('/tmp/cap.pcap', vfs.readFile('/srv/tftp/cap.pcap') ?? '', 0, 0, 0o022);
    expect(await server.executeCommand('file /tmp/cap.pcap')).toContain('pcap capture file');
    expect(await server.executeCommand('tcpdump -nn -r /tmp/cap.pcap')).toMatch(/ICMP echo (request|reply)/);
  });
});
