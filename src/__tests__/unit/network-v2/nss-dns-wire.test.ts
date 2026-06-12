// NSS `dns` source resolves through real UDP/53 frames (journal entrée 23).

import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function buildLab(options: { cabled?: boolean } = {}) {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('DNS1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  const cable = new Cable('c1');
  if (options.cabled !== false) {
    cable.connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  }
  srv.dnsService.addRecord({ name: 'webserver', type: 'A', value: '10.0.1.88', ttl: 3600 });
  srv.dnsService.addRecord({ name: '88.1.0.10.in-addr.arpa', type: 'PTR', value: 'webserver', ttl: 3600 });
  srv.dnsService.start();
  return { pc, srv, cable };
}

async function setResolver(pc: LinuxPC, ip = '10.0.1.10'): Promise<void> {
  await pc.executeCommand(`sudo sh -c 'echo "nameserver ${ip}" > /etc/resolv.conf'`);
}

describe('NSS dns source over UDP/53', () => {
  it('getent hosts resolves from the server zone through the wire', async () => {
    const { pc } = buildLab();
    await setResolver(pc);

    const out = await pc.executeCommand('getent hosts webserver');

    expect(out).toContain('10.0.1.88');
    expect(out).toContain('webserver');
  });

  it('NXDOMAIN is authoritative — a registry device unknown to the zone does not resolve', async () => {
    const { pc } = buildLab();
    const ghost = new LinuxPC('linux-pc', 'GHOST');
    ghost.configureInterface('eth0', new IPAddress('10.0.1.66'), new SubnetMask('255.255.255.0'));
    ghost.setHostname('ghost');
    await setResolver(pc);

    const out = await pc.executeCommand('getent hosts ghost');

    expect(out).not.toContain('10.0.1.66');
  });

  it('a cut cable really interrupts resolution', async () => {
    const { pc, cable } = buildLab();
    await setResolver(pc);
    cable.disconnect();

    const out = await pc.executeCommand('getent hosts webserver');

    expect(out).not.toContain('10.0.1.88');
  });

  it('reverse lookup (PTR) travels the wire', async () => {
    const { pc } = buildLab();
    await setResolver(pc);

    const out = await pc.executeCommand('getent hosts 10.0.1.88');

    expect(out).toContain('webserver');
  });

  it('without a configured nameserver the legacy topology fallback still works', async () => {
    const { pc, srv } = buildLab();
    srv.setHostname('zonebox');

    const out = await pc.executeCommand('getent hosts zonebox');

    expect(out).toContain('10.0.1.10');
  });
});
