import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const FACTORY = ['alice', 'bob', 'carl', 'dave'];

interface WithAccounts {
  executeCommand(cmd: string): Promise<string> | string;
  _listLocalUsers(): ReadonlyArray<{ name: string; secret: string; privilege: number }>;
}

async function run(dev: WithAccounts, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = String((await dev.executeCommand(c)) ?? '');
  return last;
}

describe('the account store is the only source, and every reader sees it', () => {
  it('a Cisco router lists all four factory accounts in its configuration', async () => {
    const r = new CiscoRouter('R1');
    const cfg = await run(r as unknown as WithAccounts, ['enable', 'show running-config']);
    for (const u of FACTORY) expect(cfg).toContain(`username ${u} secret 5 $1$`);
  });

  it('a Cisco switch shows exactly the accounts its own store holds', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8) as unknown as WithAccounts;
    await run(sw, ['enable', 'configure terminal',
      'username opsteam privilege 15 secret secret', 'end']);

    const cfg = String(await sw.executeCommand('show running-config'));
    const shown = cfg.split('\n')
      .filter(l => l.startsWith('username '))
      .map(l => l.split(/\s+/)[1])
      .sort();
    expect(shown).toEqual(sw._listLocalUsers().map(u => u.name).sort());
    expect(shown).toContain('opsteam');
  });

  it('a Huawei router lists them as local-user', async () => {
    const r = new HuaweiRouter('R2');
    const cfg = await run(r as unknown as WithAccounts, ['system-view', 'display current-configuration']);
    for (const u of FACTORY) expect(cfg).toContain(`local-user ${u}`);
  });

  it('what the configuration shows is what the store holds', async () => {
    const r = new CiscoRouter('R1') as unknown as WithAccounts;
    const cfg = await run(r, ['enable', 'show running-config']);
    const shown = cfg.split('\n')
      .filter(l => l.startsWith('username '))
      .map(l => l.split(/\s+/)[1])
      .sort();
    const held = r._listLocalUsers().map(u => u.name).sort();
    expect(shown).toEqual(held);
  });

  it('an operator can delete a factory account, and the configuration follows', async () => {
    const r = new CiscoRouter('R1') as unknown as WithAccounts;
    await run(r, ['enable', 'configure terminal', 'no username alice', 'end']);

    const cfg = String(await r.executeCommand('show running-config'));
    expect(cfg).not.toContain('username alice');
    expect(r._listLocalUsers().map(u => u.name)).not.toContain('alice');
  });

  it('an operator can change one, and both views move together', async () => {
    const r = new CiscoRouter('R1') as unknown as WithAccounts;
    await run(r, ['enable', 'configure terminal',
      'username alice privilege 5 secret nouveau', 'end']);

    const cfg = String(await r.executeCommand('show running-config'));
    expect(cfg).toContain('username alice privilege 5');
    expect(r._listLocalUsers().find(u => u.name === 'alice')?.privilege).toBe(5);
  });
});

describe('two entries sharing a password never share a salt', () => {
  it('enable secret and username admin are salted apart', async () => {
    const r = new CiscoRouter('R1');
    await run(r as unknown as WithAccounts, ['enable', 'configure terminal',
      'enable secret cisco123', 'username admin privilege 15 secret cisco123', 'end']);

    const cfg = String(await r.executeCommand('show running-config'));
    const salt = (line: string): string => line.split('$')[2] ?? '';
    const enable = cfg.split('\n').find(l => l.startsWith('enable secret ')) ?? '';
    const admin = cfg.split('\n').find(l => l.startsWith('username admin ')) ?? '';

    expect(salt(enable)).not.toBe('');
    expect(salt(admin)).not.toBe('');
    expect(salt(enable)).not.toBe(salt(admin));
  });

  it('every rendered secret carries its own salt', async () => {
    const r = new CiscoRouter('R1');
    await run(r as unknown as WithAccounts, ['enable', 'configure terminal',
      'enable secret motdepasse', 'username admin privilege 15 secret motdepasse',
      'username backup privilege 15 secret motdepasse', 'end']);

    const cfg = String(await r.executeCommand('show running-config'));
    const salts = cfg.split('\n')
      .filter(l => l.includes('$1$'))
      .map(l => l.split('$')[2]);

    expect(salts.length).toBeGreaterThanOrEqual(6);
    expect(new Set(salts).size).toBe(salts.length);
  });

  it('a factory secret is hashed, never echoed in the clear', async () => {
    const r = new CiscoRouter('R1');
    const cfg = await run(r as unknown as WithAccounts, ['enable', 'show running-config']);
    for (const u of FACTORY) {
      expect(cfg).toContain(`username ${u} secret 5 $1$`);
      expect(cfg).not.toContain(`username ${u} secret 0 ${u}`);
    }
  });
});

describe('IOS emits no log when a local account is created', () => {
  it('creating one writes nothing to the buffer', async () => {
    const r = new CiscoRouter('R1');
    await run(r as unknown as WithAccounts, ['enable', 'configure terminal',
      'username claude privilege 15 secret secret', 'end']);

    const log = String(await r.executeCommand('show logging'));
    expect(log).not.toContain('User account');
  });

  it('and the four factory accounts leave no trace at boot either', async () => {
    const r = new CiscoRouter('R1');
    const log = await run(r as unknown as WithAccounts, ['enable', 'show logging']);
    for (const u of FACTORY) expect(log).not.toContain(`'${u}'`);
  });
});
