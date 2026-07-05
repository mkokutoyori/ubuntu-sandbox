/**
 * Real FTP server on a router (PRD-FTP-SFTP.md §2.1.20/P19). `ftp
 * server enable` on Huawei VRP used to just flip a write-only toggle
 * nobody ever read (`_setGlobalToggle('ftp', true)`); it now mounts a
 * real `FtpServer` on the router's own `TcpStack`, authenticated
 * through the same AAA-backed credential store as SSH, serving a
 * minimal real flash: file surface (`RouterSftpFileSystem`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { FtpClientSession } from '@/network/ftp/FtpClientSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
  EquipmentRegistry.resetInstance();
});

const PC_IP = '10.0.0.1';
const ROUTER_IP = '10.0.0.2';

async function buildTopology() {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const router = new HuaweiRouter('huawei1', 0, 0);
  new Cable('c1').connect(pc.getPorts()[0], router.getPorts()[0]);

  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), new SubnetMask('255.255.255.0'));
  for (const c of [
    'system-view',
    'sysname huawei1',
    'interface GigabitEthernet0/0/0',
    `ip address ${ROUTER_IP} 255.255.255.0`,
    'undo shutdown',
    'quit',
    'quit',
  ]) await router.executeCommand(c);

  // Prime ARP so the first TCP handshake isn't dropped.
  await pc.executeCommand(`ping -c 1 ${ROUTER_IP}`);

  return { pc, router };
}

describe('Real FTP server on a Huawei router (§2.1.20/P19)', () => {
  it('"ftp server enable" is a dead flag by default: no listener on port 21', async () => {
    const { router } = await buildTopology();
    expect(router.isFtpServerEnabled()).toBe(false);
    expect(router.getTcpStack().listListeners().some((l) => l.localPort === 21)).toBe(false);
  });

  it('"ftp server enable" mounts a real, listening FtpServer on port 21', async () => {
    const { router } = await buildTopology();
    await router.executeCommand('system-view');
    await router.executeCommand('ftp server enable');
    await router.executeCommand('quit');

    expect(router.isFtpServerEnabled()).toBe(true);
    expect(router.getTcpStack().listListeners().some((l) => l.localPort === 21)).toBe(true);
  });

  it('a real FTP client logs in with the router\'s real AAA credentials, uploads, and downloads', async () => {
    const { pc, router } = await buildTopology();
    await router.executeCommand('system-view');
    await router.executeCommand('ftp server enable');
    await router.executeCommand('quit');

    const client = new FtpClientSession(pc.getTcpStack(), ROUTER_IP, PC_IP);
    const banner = client.connect();
    expect(banner?.code).toBe(220);

    const userReply = client.sendCommand({ verb: 'USER', argument: 'alice' });
    expect(userReply?.code).toBe(331);
    const passReply = client.sendCommand({ verb: 'PASS', argument: 'alice' }); // default cast: password === username
    expect(passReply?.code).toBe(230);

    client.enterPassiveMode();
    const storeReply = client.storeFile('router-test.txt', 'hello from a real router FTP session');
    expect(storeReply?.code).toBe(226);
    expect(router._readFlashFile('router-test.txt')).toBe('hello from a real router FTP session');

    client.enterPassiveMode();
    const { reply, content } = client.retrieveFile('router-test.txt');
    expect(reply?.code).toBe(226);
    expect(content).toBe('hello from a real router FTP session');
  });

  it('a wrong password is rejected by the router\'s real credential store', async () => {
    const { pc, router } = await buildTopology();
    await router.executeCommand('system-view');
    await router.executeCommand('ftp server enable');
    await router.executeCommand('quit');

    const client = new FtpClientSession(pc.getTcpStack(), ROUTER_IP, PC_IP);
    client.connect();
    client.sendCommand({ verb: 'USER', argument: 'alice' });
    const passReply = client.sendCommand({ verb: 'PASS', argument: 'wrong-password' });
    expect(passReply?.code).toBe(530);
  });

  it('"undo ftp server enable" stops the listener', async () => {
    const { router } = await buildTopology();
    await router.executeCommand('system-view');
    await router.executeCommand('ftp server enable');
    await router.executeCommand('undo ftp server enable');
    await router.executeCommand('quit');

    expect(router.isFtpServerEnabled()).toBe(false);
    expect(router.getTcpStack().listListeners().some((l) => l.localPort === 21)).toBe(false);
  });
});
