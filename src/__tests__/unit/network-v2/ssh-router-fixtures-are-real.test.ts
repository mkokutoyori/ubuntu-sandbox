import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { reinstallDefaultShells } from '@/shell/registerDefaults';
import { openWireSshShell } from '@/terminal/ssh/wireSshLogin';
import { QueuedTerminalIO } from '@/network/protocols/ssh/session/QueuedTerminalIO';
import {
  configureCiscoSshServer,
  configureHuaweiSshServer,
  ROUTER_SSH_USER,
  ROUTER_SSH_PASSWORD,
} from './_helpers/routerSshFixtures';

const MASK = '255.255.255.0';
const PC_IP = '10.0.0.1';
const CISCO_IP = '10.0.0.6';
const HUAWEI_IP = '10.0.0.8';

beforeEach(() => {
  reinstallDefaultShells();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const silentIo = () => new QueuedTerminalIO({
  writeLine: () => undefined,
  beginPrompt: () => undefined,
  endPrompt: () => undefined,
});

async function ciscoLan(): Promise<{ pc: LinuxPC; cisco: CiscoRouter }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const cisco = new CiscoRouter('cisco1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(cisco.getPorts()[0], sw.getPorts()[1]);
  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), new SubnetMask(MASK));
  await configureCiscoSshServer(cisco, CISCO_IP, MASK);
  return { pc, cisco };
}

async function huaweiLan(): Promise<{ pc: LinuxPC; huawei: HuaweiRouter }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const huawei = new HuaweiRouter('huawei1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(huawei.getPorts()[0], sw.getPorts()[1]);
  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), new SubnetMask(MASK));
  await configureHuaweiSshServer(huawei, HUAWEI_IP, MASK);
  return { pc, huawei };
}

/**
 * A fixture that only assigns an IP has no SSH server on it: a login
 * against it can only ever succeed by being decided locally. These
 * assertions go over the wire, so they fail on such a fixture and pass
 * only on one that genuinely answers on port 22.
 */
describe('a router fixture configured for SSH answers a real connection', () => {
  it('Cisco accepts a wire login and hands back a shell channel', async () => {
    const { pc } = await ciscoLan();
    const outcome = await openWireSshShell({
      device: pc,
      localUser: 'root',
      user: ROUTER_SSH_USER,
      host: CISCO_IP,
      port: 22,
      io: silentIo(),
      password: ROUTER_SSH_PASSWORD,
    });
    expect(outcome.kind, 'the fixture must run a real sshd, not rely on a local check').toBe('connected');
  }, 40000);

  it('Cisco refuses the wrong password over that same connection', async () => {
    const { pc } = await ciscoLan();
    const outcome = await openWireSshShell({
      device: pc,
      localUser: 'root',
      user: ROUTER_SSH_USER,
      host: CISCO_IP,
      port: 22,
      io: silentIo(),
      password: 'not-the-password',
    });
    expect(outcome.kind).not.toBe('connected');
  }, 40000);

  it('Huawei accepts a wire login and hands back a shell channel', async () => {
    const { pc } = await huaweiLan();
    const outcome = await openWireSshShell({
      device: pc,
      localUser: 'root',
      user: ROUTER_SSH_USER,
      host: HUAWEI_IP,
      port: 22,
      io: silentIo(),
      password: ROUTER_SSH_PASSWORD,
    });
    expect(outcome.kind, 'the fixture must run a real sshd, not rely on a local check').toBe('connected');
  }, 40000);

  it('Huawei refuses the wrong password over that same connection', async () => {
    const { pc } = await huaweiLan();
    const outcome = await openWireSshShell({
      device: pc,
      localUser: 'root',
      user: ROUTER_SSH_USER,
      host: HUAWEI_IP,
      port: 22,
      io: silentIo(),
      password: 'not-the-password',
    });
    expect(outcome.kind).not.toBe('connected');
  }, 40000);

  it('a Linux server fixture already answers — it ships an sshd', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    const server = new LinuxServer('linux-server', 'srv1', 0, 0);
    new Cable('c1').connect(pc.getPorts()[0], server.getPorts()[0]);
    pc.getPorts()[0].configureIP(new IPAddress(PC_IP), new SubnetMask(MASK));
    server.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask(MASK));

    const outcome = await openWireSshShell({
      device: pc,
      localUser: 'root',
      user: 'alice',
      host: '10.0.0.2',
      port: 22,
      io: silentIo(),
      password: 'alice',
    });
    expect(
      outcome.kind,
      'unlike a bare router, a Linux server needs no extra setup to answer',
    ).toBe('connected');
  }, 40000);

  it('an IP-only fixture is not one — nothing answers on port 22', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    const cisco = new CiscoRouter('cisco1', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(cisco.getPorts()[0], sw.getPorts()[1]);
    pc.getPorts()[0].configureIP(new IPAddress(PC_IP), new SubnetMask(MASK));
    for (const cmd of [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      `ip address ${CISCO_IP} ${MASK}`, 'no shutdown', 'end',
    ]) await cisco.executeCommand(cmd);

    const outcome = await openWireSshShell({
      device: pc,
      localUser: 'root',
      user: ROUTER_SSH_USER,
      host: CISCO_IP,
      port: 22,
      io: silentIo(),
      password: ROUTER_SSH_PASSWORD,
    });
    expect(
      outcome.kind,
      'this is the shape the VTY fixtures had: reachable, but with no sshd behind the address',
    ).not.toBe('connected');
  }, 40000);
});
