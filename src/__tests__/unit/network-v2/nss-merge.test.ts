import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { IPAddress, SubnetMask } from '@/network/core/types';

async function getent(pc: LinuxPC, args: string): Promise<{ output: string; exitCode: number }> {
  const out = await pc.executeCommand(`getent ${args}; echo "__rc=$?"`);
  const m = /__rc=(\d+)\s*$/.exec(out);
  const exitCode = m ? parseInt(m[1], 10) : 0;
  const output = out.replace(/__rc=\d+\s*$/, '').trim();
  return { output, exitCode };
}

describe('nss hosts [SUCCESS=merge]', () => {
  let pc: LinuxPC;
  let dns: LinuxServer;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    const bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);

    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.setHostname('pc1');
    pc.powerOn();
    (pc as any).executor.userMgr.currentUid = 0;
    (pc as any).executor.userMgr.currentUser = 'root';

    // The `dns` source answers from a real zone reached over UDP/53, not
    // from a scan of the simulation (docs/PRD-Frame-Only-Refactor.md P6).
    dns = new LinuxServer('linux-server', 'DNS1');
    dns.setEventBus(bus);
    dns.powerOn();
    pc.configureInterface(pc.getPorts()[0].getName(),
      new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    dns.configureInterface(dns.getPorts()[0].getName(),
      new IPAddress('10.0.0.53'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(pc.getPorts()[0], dns.getPorts()[0]);
    dns.dnsService.addRecord({ name: 'dual', type: 'A', value: '10.0.0.6', ttl: 3600 });
    dns.dnsService.start();
  });

  const useResolver = async () => {
    await pc.executeCommand(`sudo sh -c 'echo "nameserver 10.0.0.53" > /etc/resolv.conf'`);
  };

  it('aggregates files + dns addresses when [SUCCESS=merge] is set', async () => {
    await useResolver();
    await pc.executeCommand('echo "10.0.0.5 dual" >> /etc/hosts');
    await pc.executeCommand('echo "hosts: files [SUCCESS=merge] dns" > /etc/nsswitch.conf');

    const r = await getent(pc, 'hosts dual');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/10\.0\.0\.5/);
    expect(r.output).toMatch(/10\.0\.0\.6/);
    expect(r.output.indexOf('10.0.0.5')).toBeLessThan(r.output.indexOf('10.0.0.6'));
  });

  it('without merge, files wins and dns is not consulted', async () => {
    await useResolver();
    await pc.executeCommand('echo "10.0.0.5 dual" >> /etc/hosts');
    await pc.executeCommand('echo "hosts: files dns" > /etc/nsswitch.conf');

    const r = await getent(pc, 'hosts dual');
    expect(r.output).toMatch(/10\.0\.0\.5/);
    expect(r.output).not.toMatch(/10\.0\.0\.6/);
  });

  it('merge still returns the single source that answers', async () => {
    await useResolver();
    await pc.executeCommand('echo "hosts: files [SUCCESS=merge] dns" > /etc/nsswitch.conf');

    const r = await getent(pc, 'hosts dual');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/10\.0\.0\.6/);
  });
});
