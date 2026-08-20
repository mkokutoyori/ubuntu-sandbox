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

function offeredKeywords(help: string): string[] {
  return help.split('\n')
    .map(line => /^\s\s(\S+)/.exec(line)?.[1])
    .filter((word): word is string => word !== undefined);
}

const VUES: readonly string[] = [
  'show logging',
  'show logging count',
  'show logging history',
  'show logging persistent',
];

describe('the logging views answer from ONE declaration', () => {
  it.each(VUES)('`%s` answers on the router', async (command) => {
    expect(await (await router()).executeCommand(command)).not.toContain('Invalid input');
  });

  it('and the switch renders exactly the same text', async () => {
    const r = await router();
    const s = await switchDevice();

    for (const command of VUES) {
      expect(await s.executeCommand(command), command).toBe(await r.executeCommand(command));
    }
  });

  it('`show logging ?` offers the four continuations and `<cr>`', async () => {
    const device = await router();

    expect(offeredKeywords(device.cliHelp('show logging ')))
      .toEqual(['count', 'history', 'last', 'persistent', '<cr>']);
  });

  it('and the `<cr>` keeps its promise', async () => {
    const device = await router();

    expect(await device.executeCommand('show logging')).toContain('Syslog logging');
  });

  it('`show logging` and `show logging history` are two different tables', async () => {
    const device = await router();

    expect(await device.executeCommand('show logging history'))
      .not.toBe(await device.executeCommand('show logging'));
  });
});

describe('`show logging last <n>` bounds its count', () => {
  it('a real count is accepted', async () => {
    const device = await router();

    expect(await device.executeCommand('show logging last 3')).toContain('Syslog logging');
  });

  it('with no count it is incomplete', async () => {
    const device = await router();

    expect(await device.executeCommand('show logging last')).toContain('Incomplete');
  });

  it('zero is refused where it was typed — a count of none is not a count', async () => {
    const device = await router();

    expect(await device.executeCommand('show logging last 0')).toContain('Invalid input');
  });

  it('and a word that is not a number is refused the same way', async () => {
    const device = await router();

    expect(await device.executeCommand('show logging last abc')).toContain('Invalid input');
  });

  it('`?` announces the type the machine applies', async () => {
    const device = await router();

    expect(offeredKeywords(device.cliHelp('show logging last '))).toEqual(['<1-2147483647>']);
  });
});

describe('an unknown continuation is shown, not swallowed', () => {
  it('`show logging zorglub` gets the caret', async () => {
    const device = await router();

    const out = await device.executeCommand('show logging zorglub');

    expect(out).toContain('% Invalid input detected');
    expect(out).not.toContain('Syslog logging');
  });
});
