import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function mqcLan() {
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
  const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
  const pc2 = new LinuxPC('pc2', 'PC2', 0, 0);
  const pc3 = new LinuxPC('pc3', 'PC3', 0, 0);
  new Cable('c1').connect(pc1.getPorts()[0], sw.getPort('GigabitEthernet0/0/1')!);
  new Cable('c2').connect(pc2.getPorts()[0], sw.getPort('GigabitEthernet0/0/2')!);
  new Cable('c3').connect(pc3.getPorts()[0], sw.getPort('GigabitEthernet0/0/3')!);

  await sw.executeCommand('system-view');
  await sw.executeCommand('vlan 10');
  await sw.executeCommand('quit');
  for (const p of ['GigabitEthernet0/0/1', 'GigabitEthernet0/0/2', 'GigabitEthernet0/0/3']) {
    await sw.executeCommand(`interface ${p}`);
    await sw.executeCommand('port link-type access');
    await sw.executeCommand('port default vlan 10');
    await sw.executeCommand('quit');
    sw.setStpVlanState(p, 10, 'forwarding');
  }

  await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  await pc3.executeCommand('ifconfig eth0 10.0.0.3 netmask 255.255.255.0');
  return { sw, pc1, pc2, pc3 };
}

describe('Huawei MQC — traffic classifier / behavior / policy CLI', () => {
  it('builds the classifier→behavior→policy chain and binds it to a VLAN', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('quit');
    await sw.executeCommand('acl 3001');
    await sw.executeCommand('rule 5 permit ip source 10.0.0.1 0 destination any');
    await sw.executeCommand('quit');
    await sw.executeCommand('traffic classifier C1');
    expect(await sw.executeCommand('if-match acl 3001')).not.toMatch(/Error/);
    await sw.executeCommand('quit');
    await sw.executeCommand('traffic behavior B1');
    expect(await sw.executeCommand('deny')).not.toMatch(/Error/);
    await sw.executeCommand('quit');
    await sw.executeCommand('traffic policy P1');
    expect(await sw.executeCommand('classifier C1 behavior B1')).not.toMatch(/Error/);
    await sw.executeCommand('quit');
    await sw.executeCommand('vlan 10');
    expect(await sw.executeCommand('traffic-policy P1 inbound')).not.toMatch(/Error/);
    await sw.executeCommand('quit');

    expect(sw.getMqcClassifier('C1')).toEqual([{ kind: 'acl', ref: '3001' }]);
    expect(sw.getMqcBehavior('B1')).toBe('deny');
    expect(sw.getMqcPolicy('P1')).toEqual([{ classifier: 'C1', behavior: 'B1' }]);
    expect(sw.getVlanTrafficPolicy(10)).toBe('P1');
  });

  it('binding an unknown classifier or applying an unknown policy is rejected', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan 10');
    expect(await sw.executeCommand('traffic-policy GHOST inbound')).toMatch(/Error/);
    await sw.executeCommand('quit');
    await sw.executeCommand('traffic behavior B1');
    await sw.executeCommand('quit');
    await sw.executeCommand('traffic policy P1');
    expect(await sw.executeCommand('classifier NOPE behavior B1')).toMatch(/Error/);
  });
});

describe('Huawei MQC — real VLAN-scoped filtering in the data plane', () => {
  it('a deny behavior stops classified traffic once the policy is applied to the VLAN, others keep working', async () => {
    const { sw, pc1, pc2, pc3 } = await mqcLan();

    const before = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(before).toMatch(/1 packets transmitted, 1 received/);

    for (const cmd of [
      'acl 3001',
      'rule 5 permit ip source 10.0.0.1 0 destination any',
      'quit',
      'traffic classifier BLOCK-PC1',
      'if-match acl 3001',
      'quit',
      'traffic behavior DROP',
      'deny',
      'quit',
      'traffic policy FILTER',
      'classifier BLOCK-PC1 behavior DROP',
      'quit',
      'vlan 10',
      'traffic-policy FILTER inbound',
      'quit',
    ]) await sw.executeCommand(cmd);

    const blocked = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(blocked).toMatch(/0 received|100% packet loss/);

    const others = await pc2.executeCommand('ping -c 1 10.0.0.3');
    expect(others).toMatch(/1 packets transmitted, 1 received/);
  });

  it('undo traffic-policy restores the blocked traffic', async () => {
    const { sw, pc1 } = await mqcLan();
    for (const cmd of [
      'acl 3001',
      'rule 5 permit ip source 10.0.0.1 0 destination any',
      'quit',
      'traffic classifier C1', 'if-match acl 3001', 'quit',
      'traffic behavior B1', 'deny', 'quit',
      'traffic policy P1', 'classifier C1 behavior B1', 'quit',
      'vlan 10', 'traffic-policy P1 inbound', 'quit',
    ]) await sw.executeCommand(cmd);

    const blocked = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(blocked).toMatch(/0 received|100% packet loss/);

    await sw.executeCommand('vlan 10');
    await sw.executeCommand('undo traffic-policy inbound');
    await sw.executeCommand('quit');

    const restored = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(restored).toMatch(/1 packets transmitted, 1 received/);
  });

  it('a permit behavior leaves classified traffic flowing', async () => {
    const { sw, pc1 } = await mqcLan();
    for (const cmd of [
      'acl 3001',
      'rule 5 permit ip source 10.0.0.1 0 destination any',
      'quit',
      'traffic classifier C1', 'if-match acl 3001', 'quit',
      'traffic behavior B1', 'permit', 'quit',
      'traffic policy P1', 'classifier C1 behavior B1', 'quit',
      'vlan 10', 'traffic-policy P1 inbound', 'quit',
    ]) await sw.executeCommand(cmd);

    const out = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(out).toMatch(/1 packets transmitted, 1 received/);
  });
});
