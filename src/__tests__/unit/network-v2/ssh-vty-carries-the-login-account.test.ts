import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { reinstallDefaultShells } from '@/shell/registerDefaults';
import { openWireSshShell } from '@/terminal/ssh/wireSshLogin';
import { QueuedTerminalIO } from '@/network/protocols/ssh/session/QueuedTerminalIO';
import { SshInteractiveSubShell } from '@/terminal/subshells/SshInteractiveSubShell';
import {
  configureCiscoSshServer, ROUTER_SSH_USER, ROUTER_SSH_PASSWORD,
} from './_helpers/routerSshFixtures';

const MASK = '255.255.255.0';
const PC_IP = '10.0.50.1';
const CISCO_IP = '10.0.50.6';
const WIN_IP = '10.0.50.7';

beforeEach(() => {
  reinstallDefaultShells();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const silentIo = () => new QueuedTerminalIO({
  writeLine: () => undefined, beginPrompt: () => undefined, endPrompt: () => undefined,
});

/** Log in over the wire and report the prompt the client would render. */
async function promptAfterLogin(
  pc: LinuxPC, host: string, user: string, password: string,
): Promise<string> {
  const outcome = await openWireSshShell({
    device: pc, localUser: 'root', user, host, port: 22, io: silentIo(), password,
  });
  expect(outcome.kind, `login as ${user}@${host} must succeed for this to mean anything`).toBe('connected');
  if (outcome.kind !== 'connected') throw new Error('unreachable');
  const shell = new SshInteractiveSubShell(
    outcome.session, outcome.channel, user, host, `/home/${user}`,
    () => outcome.session.disconnect(), host,
  );
  return shell.getPrompt();
}

describe('the VTY a login lands on belongs to that account', () => {
  it('a Cisco account at privilege 15 lands in privileged EXEC', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    const cisco = new CiscoRouter('cisco1', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(cisco.getPorts()[0], sw.getPorts()[1]);
    pc.getPorts()[0].configureIP(new IPAddress(PC_IP), new SubnetMask(MASK));
    await configureCiscoSshServer(cisco, CISCO_IP, MASK, { hostname: 'R9' });

    const prompt = await promptAfterLogin(pc, CISCO_IP, ROUTER_SSH_USER, ROUTER_SSH_PASSWORD);
    expect(
      prompt,
      'real IOS drops a privilege-15 account straight into #; landing in > means the account level never reached the VTY',
    ).toMatch(/R9#/);
  }, 40000);

  it('a Cisco account at privilege 1 still lands in user EXEC', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    const cisco = new CiscoRouter('cisco1', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(cisco.getPorts()[0], sw.getPorts()[1]);
    pc.getPorts()[0].configureIP(new IPAddress(PC_IP), new SubnetMask(MASK));
    await configureCiscoSshServer(cisco, CISCO_IP, MASK, { hostname: 'R9' });
    for (const cmd of [
      'enable', 'configure terminal',
      'username lowly privilege 1 secret Lowly@123', 'end',
    ]) await cisco.executeCommand(cmd);

    const prompt = await promptAfterLogin(pc, CISCO_IP, 'lowly', 'Lowly@123');
    expect(prompt, 'a level-1 account must not be handed privileged EXEC').toMatch(/R9>/);
  }, 40000);

  it('a Windows login lands in its own profile, not the console user\'s', async () => {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    const win = new WindowsPC('windows-pc', 'WINPEER', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(win.getPorts()[0], sw.getPorts()[1]);
    pc.getPorts()[0].configureIP(new IPAddress(PC_IP), new SubnetMask(MASK));
    win.getPorts()[0].configureIP(new IPAddress(WIN_IP), new SubnetMask(MASK));
    const um = (win as unknown as { userMgr: { currentUser: string } }).userMgr;
    expect(
      um.currentUser,
      'the console is signed in as someone else — that is what makes this discriminating',
    ).not.toBe('Administrator');

    const prompt = await promptAfterLogin(pc, WIN_IP, 'Administrator', 'admin');
    expect(
      prompt,
      'the prompt belongs to the account that logged in over the channel, not to whoever is at the console',
    ).toMatch(/C:\\Users\\Administrator>/);
  }, 40000);
});
