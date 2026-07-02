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
import { ShellFactory } from '@/shell/ShellFactory';
import { reinstallDefaultShells } from '@/shell/registerDefaults';

const MASK = '255.255.255.0';
const PC_IP = '10.0.0.1';
const CISCO_IP = '10.0.0.6';
const HUAWEI_IP = '10.0.0.8';

async function configureCisco(router: CiscoRouter, ip: string): Promise<void> {
  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    `ip address ${ip} ${MASK}`,
    'no shutdown', 'end',
  ]) await router.executeCommand(cmd);
}

async function configureHuawei(router: HuaweiRouter, ip: string): Promise<void> {
  for (const cmd of [
    'system-view',
    'interface GigabitEthernet0/0/0',
    `ip address ${ip} ${MASK}`,
    'undo shutdown', 'quit', 'quit',
  ]) await router.executeCommand(cmd);
}

function buildPc(): LinuxPC {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), new SubnetMask(MASK));
  return pc;
}

function wireProbeOf(pc: LinuxPC): NonNullable<SshLaunchOptions['wireProbe']> {
  return (host, port) => pc.tcpConnectOutcome(new IPAddress(host), port);
}

function launchOpts(pc: LinuxPC): SshLaunchOptions {
  return { defaultUser: 'root', sourceIp: PC_IP, wireProbe: wireProbeOf(pc) };
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
  reinstallDefaultShells();
});

describe('interactive ssh launch reads its verdict from the wire (no VTY short-circuit)', () => {
  it('reaches the password prompt when the router is truly cabled, without any prior ping', async () => {
    const pc = buildPc();
    const cisco = new CiscoRouter('cisco1', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(cisco.getPorts()[0], sw.getPorts()[1]);
    await configureCisco(cisco, CISCO_IP);

    const attempt = await tryInterpretSshLaunch(`ssh admin@${CISCO_IP}`, launchOpts(pc));

    expect(attempt?.kind).toBe('pending');
  });

  it('reaches the password prompt on a cabled Huawei router as well', async () => {
    const pc = buildPc();
    const huawei = new HuaweiRouter('huawei1', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(huawei.getPorts()[0], sw.getPorts()[1]);
    await configureHuawei(huawei, HUAWEI_IP);

    const attempt = await tryInterpretSshLaunch(`ssh admin@${HUAWEI_IP}`, launchOpts(pc));

    expect(attempt?.kind).toBe('pending');
  });

  it('times out when no cable connects the router to the network', async () => {
    const pc = buildPc();
    const cisco = new CiscoRouter('cisco1', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
    await configureCisco(cisco, CISCO_IP);

    const attempt = await tryInterpretSshLaunch(`ssh admin@${CISCO_IP}`, launchOpts(pc));

    expect(attempt?.kind).toBe('error');
    const output = attempt?.result.output.join('\n') ?? '';
    expect(output).toMatch(/Connection timed out/);
  });

  it('times out when the router interface is administratively shut down', async () => {
    const pc = buildPc();
    const cisco = new CiscoRouter('cisco1', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(cisco.getPorts()[0], sw.getPorts()[1]);
    await configureCisco(cisco, CISCO_IP);
    for (const cmd of [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'shutdown', 'end',
    ]) await cisco.executeCommand(cmd);

    const attempt = await tryInterpretSshLaunch(`ssh admin@${CISCO_IP}`, launchOpts(pc));

    expect(attempt?.kind).toBe('error');
    expect(attempt?.result.output.join('\n')).toMatch(/Connection timed out/);
  });

  it('keeps the registry behaviour for legacy callers that inject no wire probe', async () => {
    const pc = buildPc();
    const cisco = new CiscoRouter('cisco1', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
    await configureCisco(cisco, CISCO_IP);

    const attempt = await tryInterpretSshLaunch(`ssh admin@${CISCO_IP}`, {
      defaultUser: 'root',
      sourceIp: PC_IP,
    });

    expect(attempt?.kind).toBe('pending');
  });
});

describe('the bash terminal adapter injects the wire probe', () => {
  it('surfaces the password prompt for a cabled router', async () => {
    const pc = buildPc();
    const cisco = new CiscoRouter('cisco1', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(cisco.getPorts()[0], sw.getPorts()[1]);
    await configureCisco(cisco, CISCO_IP);

    const shell = ShellFactory.create('bash', { device: pc, user: 'root' });
    const result = await shell.processLine(`ssh admin@${CISCO_IP}`);

    expect(result.pendingInput?.kind).toBe('password');
  });

  it('prints the timeout error when the router is not cabled', async () => {
    const pc = buildPc();
    const cisco = new CiscoRouter('cisco1', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
    await configureCisco(cisco, CISCO_IP);

    const shell = ShellFactory.create('bash', { device: pc, user: 'root' });
    const result = await shell.processLine(`ssh admin@${CISCO_IP}`);

    expect(result.pendingInput).toBeUndefined();
    expect(result.output.join('\n')).toMatch(/Connection timed out/);
  });
});
