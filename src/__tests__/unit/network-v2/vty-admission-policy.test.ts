import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { tryInterpretSshLaunch, type SshLaunchOptions } from '@/shell/sshLauncher';

const MASK = '255.255.255.0';
const PC_IP = '10.0.0.1';
const CISCO_IP = '10.0.0.6';
const HUAWEI_IP = '10.0.0.8';

function launchOpts(pc: LinuxPC): SshLaunchOptions {
  return {
    defaultUser: 'root',
    sourceIp: PC_IP,
    wireProbe: (host, port) => pc.tcpConnectOutcome(new IPAddress(host), port),
  };
}

async function buildCiscoLan(): Promise<{ pc: LinuxPC; cisco: CiscoRouter }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const cisco = new CiscoRouter('cisco1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(cisco.getPorts()[0], sw.getPorts()[1]);
  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), new SubnetMask(MASK));
  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    `ip address ${CISCO_IP} ${MASK}`,
    'no shutdown', 'end',
  ]) await cisco.executeCommand(cmd);
  return { pc, cisco };
}

async function buildHuaweiLan(): Promise<{ pc: LinuxPC; huawei: HuaweiRouter }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const huawei = new HuaweiRouter('huawei1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(huawei.getPorts()[0], sw.getPorts()[1]);
  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), new SubnetMask(MASK));
  for (const cmd of [
    'system-view',
    'interface GigabitEthernet0/0/0',
    `ip address ${HUAWEI_IP} ${MASK}`,
    'undo shutdown', 'quit', 'quit',
  ]) await huawei.executeCommand(cmd);
  return { pc, huawei };
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('the interactive ssh launch honours the VTY access-class', () => {
  it('refuses the session when the access-class denies the source', async () => {
    const { pc, cisco } = await buildCiscoLan();
    for (const cmd of [
      'enable', 'configure terminal',
      'access-list 20 permit 10.0.0.99',
      'line vty 0 4', 'access-class 20 in', 'end',
    ]) await cisco.executeCommand(cmd);

    const attempt = await tryInterpretSshLaunch(`ssh admin@${CISCO_IP}`, launchOpts(pc));

    expect(attempt?.kind).toBe('error');
    expect(attempt?.result.output.join('\n')).toMatch(/Connection refused/);
  });

  it('still prompts for a password when the access-class permits the source', async () => {
    const { pc, cisco } = await buildCiscoLan();
    for (const cmd of [
      'enable', 'configure terminal',
      `access-list 21 permit ${PC_IP}`,
      'line vty 0 4', 'access-class 21 in', 'end',
    ]) await cisco.executeCommand(cmd);

    const attempt = await tryInterpretSshLaunch(`ssh admin@${CISCO_IP}`, launchOpts(pc));

    expect(attempt?.kind).toBe('pending');
  });

  it('refuses when the Huawei acl inbound denies the source', async () => {
    const { pc, huawei } = await buildHuaweiLan();
    for (const cmd of [
      'system-view',
      'acl 2000', 'rule 5 permit source 10.0.0.99 0', 'quit',
      'user-interface vty 0 4', 'acl 2000 inbound', 'quit', 'quit',
    ]) await huawei.executeCommand(cmd);

    const attempt = await tryInterpretSshLaunch(`ssh admin@${HUAWEI_IP}`, launchOpts(pc));

    expect(attempt?.kind).toBe('error');
    expect(attempt?.result.output.join('\n')).toMatch(/Connection refused/);
  });

  it('admits the session when the Huawei acl inbound permits the source', async () => {
    const { pc, huawei } = await buildHuaweiLan();
    for (const cmd of [
      'system-view',
      'acl 2000', `rule 5 permit source ${PC_IP} 0`, 'quit',
      'user-interface vty 0 4', 'acl 2000 inbound', 'quit', 'quit',
    ]) await huawei.executeCommand(cmd);

    const attempt = await tryInterpretSshLaunch(`ssh admin@${HUAWEI_IP}`, launchOpts(pc));

    expect(attempt?.kind).toBe('pending');
  });
});

describe('the exec bridge keeps enforcing the access-class after deduplication', () => {
  it('ssh exec toward a denied source is refused', async () => {
    const { pc, cisco } = await buildCiscoLan();
    for (const cmd of [
      'enable', 'configure terminal',
      'username admin privilege 15 secret Admin@123',
      'ip domain-name lab.local',
      'crypto key generate rsa modulus 2048',
      'ip ssh version 2',
      'line vty 0 4', 'login local', 'transport input ssh',
      'access-list 20 permit 10.0.0.99', 'access-class 20 in', 'end',
    ]) await cisco.executeCommand(cmd);

    const out = await pc.executeCommand(`ssh -o ConnectTimeout=2 admin@${CISCO_IP} "show version"`);

    expect(out).toMatch(/Connection refused/);
  });
});
