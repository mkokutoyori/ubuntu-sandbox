import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

type Cli = { cliHelp(input: string): string; executeCommand(line: string): Promise<string> };

const VUES: ReadonlyArray<readonly [string, string]> = [
  ['show aaa servers', 'No AAA servers configured'],
  ['show aaa sessions', 'Total sessions since last reload'],
  ['show aaa local user lockout', 'Local-user'],
  ['show accounting', 'Overall Accounting Traffic'],
  ['show radius statistics', 'No RADIUS servers configured'],
  ['show tacacs', 'No TACACS+ servers configured'],
  ['show login', 'Router NOT enabled to watch for login Attacks'],
  ['show login failures', 'No failures recorded'],
];

let serial = 0;

async function router(): Promise<Cli> {
  const device = new CiscoRouter(`R${serial++}`) as unknown as Cli;
  await device.executeCommand('enable');
  return device;
}

async function switchDevice(): Promise<Cli> {
  const device = createDevice('switch-cisco', 0, 0) as unknown as Cli;
  await device.executeCommand('enable');
  return device;
}

describe('the identity views answer from ONE declaration', () => {
  it.each(VUES)('`%s` answers on the router', async (command, expected) => {
    expect(await (await router()).executeCommand(command)).toContain(expected);
  });

  it.each(VUES)('`%s` answers the same on the switch', async (command, expected) => {
    expect(await (await switchDevice()).executeCommand(command)).toContain(expected);
  });

  it('router and switch render the SAME text for the same empty state', async () => {
    const r = await router();
    const s = await switchDevice();

    for (const [command] of VUES) {
      expect(await s.executeCommand(command), command)
        .toBe(await r.executeCommand(command));
    }
  });
});

describe('`show aaa local user lockout` has one implementation, and it lists', () => {
  it('the empty table carries IOS\'s own three columns', async () => {
    const device = await router();

    const out = await device.executeCommand('show aaa local user lockout');

    expect(out).toContain('Local-user');
    expect(out).toContain('Lock time');
    expect(out).toContain('Unlock time');
  });

  it('and a locked account APPEARS in it — a table nobody enters is a fiction', async () => {
    const device = new CiscoRouter(`R${serial++}`) as unknown as Cli & {
      getCredentialStore(): { list(): ReadonlyArray<{ name: string }>; lock?(n: string): void };
      loginAs(user: string, secret: string): Promise<boolean>;
    };
    await device.executeCommand('enable');
    await device.executeCommand('configure terminal');
    await device.executeCommand('aaa new-model');
    await device.executeCommand('aaa local authentication attempts max-fail 2');
    await device.executeCommand('username jean secret Bon@2026');
    await device.executeCommand('end');

    for (let essai = 0; essai < 3; essai++) await device.loginAs('jean', 'faux');

    expect(await device.executeCommand('show aaa local user lockout')).toContain('jean');
  });

  it('`show aaa local` alone stays incomplete — the witness', async () => {
    const device = await router();

    expect(await device.executeCommand('show aaa local')).toContain('Incomplete');
  });
});

describe('`clear aaa local user lockout` follows its view', () => {
  it('it names the user it unlocks', async () => {
    const device = await router();

    expect(await device.executeCommand('clear aaa local user lockout username bob')).toBe('');
  });

  it('and without a name it is incomplete', async () => {
    const device = await router();

    expect(await device.executeCommand('clear aaa local user lockout username'))
      .toContain('Incomplete');
  });
});
