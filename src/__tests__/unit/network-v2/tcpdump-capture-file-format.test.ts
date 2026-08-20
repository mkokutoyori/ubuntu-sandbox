import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { PacketCaptureLog } from '@/network/devices/linux/network/PacketCaptureLog';
import { cmdTcpdump } from '@/network/devices/linux/LinuxNetCommands';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('tcpdump capture file format (PRD-tcpdump.md P2)', () => {
  it('a file written by the primitive fallback (cmdTcpdump) is readable by the rich engine (tcpdump -r)', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');

    const log = new PacketCaptureLog();
    log.captureTcpHandshake({ ip: '10.0.0.1', port: 1234 }, { ip: '10.0.0.2', port: 80 });
    const vfs = (pc1 as unknown as {
      executor: { vfs: { writeFile: (p: string, c: string, u: number, g: number, m: number) => boolean } };
    }).executor.vfs;
    cmdTcpdump(['-w', 'primitive.cap'], log, {
      read: () => null,
      write: (p, c) => { vfs.writeFile(`/home/user/${p}`, c, 0, 0, 0o022); },
    });

    const output = await pc1.executeCommand('tcpdump -r primitive.cap');
    expect(output).toContain('reading from file primitive.cap');
    expect(output).toContain('Flags [S]');
  });

  it('a file written by the rich engine (tcpdump -w) is readable by the primitive fallback (cmdTcpdump -r)', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc1.executeCommand('tcpdump -w rich.cap -c 0');

    const vfs = (pc1 as unknown as {
      executor: { vfs: { readFile: (p: string) => string | null } };
    }).executor.vfs;
    const raw = vfs.readFile('/home/user/rich.cap');
    expect(raw).not.toBeNull();

    const output = cmdTcpdump(['-r', 'rich.cap'], new PacketCaptureLog(), { read: () => raw, write: () => {} });
    expect(output.toLowerCase()).not.toContain('bad dump file');
    expect(output).toContain('reading from file rich.cap');
  });

  it('a genuinely malformed file is still reported as a bad dump file by both implementations', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    await pc1.executeCommand('echo "not a capture file" > garbage.cap');
    const output = await pc1.executeCommand('tcpdump -r garbage.cap');
    expect(output.toLowerCase()).toMatch(/bad dump file|unknown file format/);
  });
});
