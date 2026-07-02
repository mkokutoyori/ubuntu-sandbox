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
    'undo shutdown', 'quit',
  ]) await huawei.executeCommand(cmd);
  return { pc, huawei };
}

function listenerPorts(router: CiscoRouter | HuaweiRouter): number[] {
  return (router as unknown as { getTcpStack: () => { listListeners: () => Array<{ localPort: number }> } })
    .getTcpStack().listListeners().map(l => l.localPort);
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('the TCP/22 listener mirrors the Cisco VTY transport input', () => {
  it('transport input none unbinds the listener and ssh is refused on the wire', async () => {
    const { pc, cisco } = await buildCiscoLan();
    for (const cmd of [
      'enable', 'configure terminal', 'line vty 0 4', 'transport input none', 'end',
    ]) await cisco.executeCommand(cmd);

    expect(listenerPorts(cisco)).not.toContain(22);
    const attempt = await tryInterpretSshLaunch(`ssh admin@${CISCO_IP}`, launchOpts(pc));
    expect(attempt?.kind).toBe('error');
    expect(attempt?.result.output.join('\n')).toMatch(/Connection refused/);
  });

  it('transport input telnet also refuses inbound ssh', async () => {
    const { pc, cisco } = await buildCiscoLan();
    for (const cmd of [
      'enable', 'configure terminal', 'line vty 0 4', 'transport input telnet', 'end',
    ]) await cisco.executeCommand(cmd);

    expect(listenerPorts(cisco)).not.toContain(22);
    const attempt = await tryInterpretSshLaunch(`ssh admin@${CISCO_IP}`, launchOpts(pc));
    expect(attempt?.kind).toBe('error');
    expect(attempt?.result.output.join('\n')).toMatch(/Connection refused/);
  });

  it('restoring transport input ssh rebinds the listener and the prompt returns', async () => {
    const { pc, cisco } = await buildCiscoLan();
    for (const cmd of [
      'enable', 'configure terminal', 'line vty 0 4', 'transport input none', 'end',
    ]) await cisco.executeCommand(cmd);
    expect((await tryInterpretSshLaunch(`ssh admin@${CISCO_IP}`, launchOpts(pc)))?.kind).toBe('error');

    for (const cmd of [
      'configure terminal', 'line vty 0 4', 'transport input ssh', 'end',
    ]) await cisco.executeCommand(cmd);

    expect(listenerPorts(cisco)).toContain(22);
    const attempt = await tryInterpretSshLaunch(`ssh admin@${CISCO_IP}`, launchOpts(pc));
    expect(attempt?.kind).toBe('pending');
  });

  it('an established session survives transport input none (only new connections are blocked)', async () => {
    const { pc, cisco } = await buildCiscoLan();
    expect(pc.tcpConnectOutcome(new IPAddress(CISCO_IP), 22)).toBe('open');
    const socket = await (pc as unknown as {
      tcpConnect: (h: string, p: number) => Promise<{ state: string } | null>;
    }).tcpConnect(CISCO_IP, 22);
    expect(socket?.state).toBe('established');

    for (const cmd of [
      'enable', 'configure terminal', 'line vty 0 4', 'transport input none', 'end',
    ]) await cisco.executeCommand(cmd);

    expect(socket?.state).toBe('established');
    expect(pc.tcpConnectOutcome(new IPAddress(CISCO_IP), 22)).toBe('refused');
  });
});

describe('the TCP/22 listener mirrors the Huawei VTY configuration', () => {
  it('undo stelnet server enable unbinds the listener and ssh is refused', async () => {
    const { pc, huawei } = await buildHuaweiLan();
    await huawei.executeCommand('undo stelnet server enable');
    await huawei.executeCommand('quit');

    expect(listenerPorts(huawei)).not.toContain(22);
    const attempt = await tryInterpretSshLaunch(`ssh admin@${HUAWEI_IP}`, launchOpts(pc));
    expect(attempt?.kind).toBe('error');
    expect(attempt?.result.output.join('\n')).toMatch(/Connection refused/);
  });

  it('stelnet server enable rebinds the listener after an undo', async () => {
    const { pc, huawei } = await buildHuaweiLan();
    await huawei.executeCommand('undo stelnet server enable');
    expect(listenerPorts(huawei)).not.toContain(22);

    await huawei.executeCommand('stelnet server enable');
    await huawei.executeCommand('quit');

    expect(listenerPorts(huawei)).toContain(22);
    const attempt = await tryInterpretSshLaunch(`ssh admin@${HUAWEI_IP}`, launchOpts(pc));
    expect(attempt?.kind).toBe('pending');
  });

  it('protocol inbound telnet refuses ssh; protocol inbound all restores it', async () => {
    const { pc, huawei } = await buildHuaweiLan();
    for (const cmd of [
      'user-interface vty 0 4', 'protocol inbound telnet', 'quit', 'quit',
    ]) await huawei.executeCommand(cmd);

    expect(listenerPorts(huawei)).not.toContain(22);
    expect((await tryInterpretSshLaunch(`ssh admin@${HUAWEI_IP}`, launchOpts(pc)))?.kind).toBe('error');

    for (const cmd of [
      'system-view', 'user-interface vty 0 4', 'protocol inbound all', 'quit', 'quit',
    ]) await huawei.executeCommand(cmd);

    expect(listenerPorts(huawei)).toContain(22);
    expect((await tryInterpretSshLaunch(`ssh admin@${HUAWEI_IP}`, launchOpts(pc)))?.kind).toBe('pending');
  });
});
