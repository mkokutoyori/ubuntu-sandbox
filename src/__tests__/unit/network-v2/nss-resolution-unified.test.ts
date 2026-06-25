import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

function makeLan() {
  EquipmentRegistry.resetInstance();
  const bus = new EventBus();
  __setDefaultEventBus(bus);
  EquipmentRegistry.getInstance().setEventBus(bus);

  const pc1 = new LinuxPC('pc1');
  pc1.setEventBus(bus);
  pc1.setHostname('pc1');
  pc1.powerOn();
  pc1.configureInterface(pc1.getPorts()[0].getName(), new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));

  const pc2 = new LinuxPC('pc2');
  pc2.setEventBus(bus);
  pc2.setHostname('pc2');
  pc2.powerOn();
  pc2.configureInterface(pc2.getPorts()[0].getName(), new IPAddress('10.0.0.42'), new SubnetMask('255.255.255.0'));

  new Cable(pc1.getPorts()[0], pc2.getPorts()[0]);
  return { bus, pc1, pc2 };
}

describe('Unified NSS name resolution (R1)', () => {
  let pc1: LinuxPC;

  beforeEach(() => {
    ({ pc1 } = makeLan());
  });

  it('ping resolves a topology-only host through the same NSS path as getent', async () => {
    const g = await pc1.executeCommand('getent hosts pc2');
    expect(g).toMatch(/10\.0\.0\.42/);

    const p = await pc1.executeCommand('ping -c 1 -W 1 pc2');
    expect(p).not.toMatch(/Name or service not known/);
    expect(p).toMatch(/10\.0\.0\.42/);
  });

  it('ping honours an /etc/hosts entry exactly like getent', async () => {
    pc1.executor.userMgr.currentUid = 0;
    pc1.executor.userMgr.currentUser = 'root';
    await pc1.executeCommand('echo "10.0.0.99 myhost.lan myhost" >> /etc/hosts');

    const g = await pc1.executeCommand('getent hosts myhost');
    expect(g).toMatch(/10\.0\.0\.99/);

    const p = await pc1.executeCommand('ping -c 1 -W 1 myhost');
    expect(p).toMatch(/10\.0\.0\.99/);
    expect(p).not.toMatch(/Name or service not known/);
  });

  it('traceroute resolves a topology-only host through NSS', async () => {
    const t = await pc1.executeCommand('traceroute pc2');
    expect(t).not.toMatch(/unknown host|Name or service not known/);
    expect(t).toMatch(/10\.0\.0\.42/);
  });

  it('nsswitch.conf "hosts: files" disables the dns topology scan for ping', async () => {
    pc1.executor.userMgr.currentUid = 0;
    pc1.executor.userMgr.currentUser = 'root';
    await pc1.executeCommand('echo "hosts: files" > /etc/nsswitch.conf');
    const p = await pc1.executeCommand('ping -c 1 -W 1 pc2');
    expect(p).toMatch(/Name or service not known/);
  });

  it('ssh resolves names through NSS and agrees with getent on /etc/hosts', async () => {
    pc1.executor.userMgr.currentUid = 0;
    pc1.executor.userMgr.currentUser = 'root';
    await pc1.executeCommand('echo "10.0.0.200 wonder" >> /etc/hosts');

    const g = await pc1.executeCommand('getent hosts wonder');
    expect(g).toMatch(/10\.0\.0\.200/);

    const s = await pc1.executeCommand('ssh wonder');
    expect(s).toMatch(/No route to host/);
    expect(s).not.toMatch(/Could not resolve hostname/);
  });

  it('ssh still resolves a topology host through NSS (no regression)', async () => {
    const s = await pc1.executeCommand('ssh pc2');
    expect(s).not.toMatch(/Could not resolve hostname/);
  });

  it('ssh tells a valid unowned IP (No route) apart from an invalid one (cannot resolve)', async () => {
    const noRoute = await pc1.executeCommand('ssh 10.0.0.250');
    expect(noRoute).toMatch(/No route to host/);

    const badIp = await pc1.executeCommand('ssh 10.0.0.999');
    expect(badIp).toMatch(/Could not resolve hostname/);
  });
});
