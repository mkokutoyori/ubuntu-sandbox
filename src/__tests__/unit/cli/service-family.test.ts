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

let serial = 0;

async function inGlobalConfig(): Promise<Cli> {
  const router = new CiscoRouter(`R${serial++}`) as unknown as Cli;
  await router.executeCommand('enable');
  await router.executeCommand('configure terminal');
  return router;
}

function offeredKeywords(help: string): string[] {
  return help.split('\n')
    .map(line => /^\s\s(\S+)/.exec(line)?.[1])
    .filter((word): word is string => word !== undefined);
}

describe('`service` names the services IOS has, and no others', () => {
  it('a word that is not a service is refused where it was typed', async () => {
    const router = await inGlobalConfig();

    expect(await router.executeCommand('service zorglub')).toContain('Invalid input');
  });

  it('and never reaches the configuration a reload would replay', async () => {
    const router = await inGlobalConfig();
    await router.executeCommand('service zorglub');

    expect(await router.executeCommand('do show running-config')).not.toContain('zorglub');
  });

  it('a service name is ONE word, not everything that follows', async () => {
    const router = await inGlobalConfig();

    expect(await router.executeCommand('service nagle machin')).toContain('Invalid input');
    expect(await router.executeCommand('service nagle')).toBe('');
  });

  it('`service` alone is incomplete — it never announces `<cr>`', async () => {
    const router = await inGlobalConfig();

    expect(offeredKeywords(router.cliHelp('service '))).not.toContain('<cr>');
    expect(await router.executeCommand('service')).toContain('Incomplete');
  });

  it('`?` lists the real services, both engines merged into one list', async () => {
    const router = await inGlobalConfig();

    const offered = offeredKeywords(router.cliHelp('service '));

    for (const service of ['nagle', 'tcp-small-servers', 'compress-config', 'linenumber']) {
      expect(offered, service).toContain(service);
    }
    for (const backed of ['dhcp', 'password-encryption', 'sequence-numbers', 'timestamps']) {
      expect(offered, backed).toContain(backed);
    }
    expect(offered).toEqual([...offered].sort());
  });

  it('`no service ?` lists them too — the bridge goes both ways', async () => {
    const router = await inGlobalConfig();

    const offered = offeredKeywords(router.cliHelp('no service '));

    expect(offered).toContain('nagle');
    expect(offered).toContain('tcp-keepalives-in');
  });
});

describe('the four services this machine really honours still work', () => {
  it.each([
    'service password-encryption',
    'service sequence-numbers',
    'service timestamps log datetime',
    'service dhcp',
  ])('`%s` is accepted', async (command) => {
    const router = await inGlobalConfig();

    expect(await router.executeCommand(command)).not.toContain('Invalid');
  });

  it('and a stored flag round-trips through the configuration', async () => {
    const router = await inGlobalConfig();
    await router.executeCommand('service tcp-keepalives-in');
    await router.executeCommand('no service nagle');

    const config = await router.executeCommand('do show running-config');
    expect(config).toContain('service tcp-keepalives-in');
    expect(config).toContain('no service nagle');
  });
});

describe('the switch answers the same', () => {
  it('it refuses an invented service too', async () => {
    const device = createDevice('switch-cisco', 0, 0) as unknown as Cli;
    await device.executeCommand('enable');
    await device.executeCommand('configure terminal');

    expect(await device.executeCommand('service zorglub')).toContain('Invalid input');
    expect(await device.executeCommand('service nagle')).toBe('');
  });
});
