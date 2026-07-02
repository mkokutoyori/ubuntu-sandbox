import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
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

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    const bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);

    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.setHostname('pc1');
    pc.powerOn();
    pc.executor.userMgr.currentUid = 0;
    pc.executor.userMgr.currentUser = 'root';

    const peer = new LinuxPC('peer');
    peer.setEventBus(bus);
    peer.setHostname('dual');
    peer.powerOn();
    peer.configureInterface(peer.getPorts()[0].getName(),
      new IPAddress('10.0.0.6'), new SubnetMask('255.255.255.0'));
  });

  it('aggregates files + dns addresses when [SUCCESS=merge] is set', async () => {
    await pc.executeCommand('echo "10.0.0.5 dual" >> /etc/hosts');
    await pc.executeCommand('echo "hosts: files [SUCCESS=merge] dns" > /etc/nsswitch.conf');

    const r = await getent(pc, 'hosts dual');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/10\.0\.0\.5/);
    expect(r.output).toMatch(/10\.0\.0\.6/);
    expect(r.output.indexOf('10.0.0.5')).toBeLessThan(r.output.indexOf('10.0.0.6'));
  });

  it('without merge, files wins and dns is not consulted', async () => {
    await pc.executeCommand('echo "10.0.0.5 dual" >> /etc/hosts');
    await pc.executeCommand('echo "hosts: files dns" > /etc/nsswitch.conf');

    const r = await getent(pc, 'hosts dual');
    expect(r.output).toMatch(/10\.0\.0\.5/);
    expect(r.output).not.toMatch(/10\.0\.0\.6/);
  });

  it('merge still returns the single source that answers', async () => {
    await pc.executeCommand('echo "hosts: files [SUCCESS=merge] dns" > /etc/nsswitch.conf');

    const r = await getent(pc, 'hosts dual');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/10\.0\.0\.6/);
  });
});
