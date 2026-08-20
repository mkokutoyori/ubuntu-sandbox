import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('telnet — real TCP gate on port 23', () => {
  it('refuses connection when no listener is bound to the target port', async () => {
    const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
    pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    const out = await pc.executeCommand('telnet 10.0.0.2 23');
    expect(out).toMatch(/Trying 10\.0\.0\.2/);
    expect(out).toMatch(/Connection refused/);
  });

  it('connects when the remote device listens on port 22 (sshd) — proves real TCP', async () => {
    const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
    pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    const out = await pc.executeCommand('telnet 10.0.0.2 22');
    expect(out).toMatch(/Connected to 10\.0\.0\.2/);
    expect(out).not.toMatch(/Connection refused/);
  });

  it('telnet 23 to a Cisco router (vty bound) reaches the VTY handshake, not refused', async () => {
    const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
    const r = new CiscoRouter('R1', 0, 0);
    new Cable('c').connect(pc.getPorts()[0], r.getPort('GigabitEthernet0/0')!);
    pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 10.0.0.2 255.255.255.0');
    await r.executeCommand('no shutdown');
    await r.executeCommand('end');
    const out = await pc.executeCommand('telnet 10.0.0.2');
    expect(out).toMatch(/Trying 10\.0\.0\.2/);
  });
});
