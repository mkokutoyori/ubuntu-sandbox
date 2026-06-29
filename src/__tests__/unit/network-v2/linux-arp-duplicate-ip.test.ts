import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Duplicate-IPv4 detection via gratuitous ARP', () => {
  let pc: LinuxPC;
  let srv: LinuxServer;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    srv = new LinuxServer('linux-server', 'srv1', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'sw', 8, 0, 0);
    [pc, srv, sw].forEach((d) => d.powerOn());
    new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await pc.executeCommand('ifconfig eth0 10.0.0.1');
  });

  it('the defender host logs the conflict to /var/log/syslog', async () => {
    await srv.executeCommand('ifconfig eth0 10.0.0.1');
    const log = await pc.executeCommand('cat /var/log/syslog');
    expect(log).toMatch(/IPv4: 10\.0\.0\.1 .* arp .* from \S+ on eth0/);
  });

  it('the conflict line names the foreign MAC', async () => {
    await srv.executeCommand('ifconfig eth0 10.0.0.1');
    const srvMac = (await srv.executeCommand('cat /sys/class/net/eth0/address')).trim().toLowerCase();
    const log = await pc.executeCommand('cat /var/log/syslog');
    expect(log.toLowerCase()).toContain(srvMac);
  });

  it('the attacker side also notices the conflict on its first gratuit ARP reply', async () => {
    await srv.executeCommand('ifconfig eth0 10.0.0.1');
    const log = await srv.executeCommand('cat /var/log/syslog');
    expect(log).toMatch(/IPv4: 10\.0\.0\.1/);
  });

  it('two hosts on different IPs do NOT trigger conflict', async () => {
    await srv.executeCommand('ifconfig eth0 10.0.0.2');
    const log = await pc.executeCommand('cat /var/log/syslog');
    expect(log).not.toMatch(/IPv4: 10\.0\.0\..*conflict|IPv4: 10\.0\.0\..*inactive/i);
  });
});
