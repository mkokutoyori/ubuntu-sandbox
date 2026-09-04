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
  ['show calendar', 'UTC'],
  ['show aliases', 'Exec mode aliases'],
  ['show buffers', 'Buffer elements'],
  ['show sockets', 'Proto'],
  ['show stacks', 'Minimum process stacks'],
  ['show reload', 'No reload is scheduled'],
  ['show sntp', 'No SNTP servers configured'],
  ['show terminal', 'Monitor parameter'],
  ['show file systems', 'File Systems'],
  ['show tcp brief', 'TCB'],
];

let serial = 0;

function freshRouter(): Cli {
  return new CiscoRouter(`R${serial++}`) as unknown as Cli;
}

async function privileged(): Promise<Cli> {
  const device = freshRouter();
  await device.executeCommand('enable');
  return device;
}

describe('the system views answer, and answer at level 1', () => {
  it.each(VUES)('`%s` answers in privileged EXEC', async (command, expected) => {
    expect(await (await privileged()).executeCommand(command)).toContain(expected);
  });

  it.each(VUES)('`%s` answers WITHOUT enable — the level is unchanged', async (command, expected) => {
    expect(await freshRouter().executeCommand(command)).toContain(expected);
  });

  it('the switch renders the same text as the router', async () => {
    const device = createDevice('switch-cisco', 0, 0) as unknown as Cli;
    await device.executeCommand('enable');
    const router = await privileged();

    for (const [command] of [['show sockets'], ['show reload']] as const) {
      expect(await device.executeCommand(command), command)
        .toBe(await router.executeCommand(command));
    }
  });

  /*
   * `show calendar` reads the WALL CLOCK, so the two machines are asked
   * a fraction of a second apart and a straddled second makes them
   * disagree — this case failed with `12:59:54` against `12:59:55`,
   * which says nothing about either platform. What can be compared is
   * the SHAPE, which is what "the switch renders the same text" was
   * really asking of a view whose content is a moving target.
   */
  it('and its clock view has the same SHAPE on both', async () => {
    const device = createDevice('switch-cisco', 0, 0) as unknown as Cli;
    await device.executeCommand('enable');
    const router = await privileged();
    const forme = /^\d{2}:\d{2}:\d{2} \w+ \w{3} \w{3} {1,2}\d{1,2} \d{4}$/;

    expect(String(await device.executeCommand('show calendar')).trim())
      .toMatch(forme);
    expect(String(await router.executeCommand('show calendar')).trim())
      .toMatch(forme);
  });
});

describe('a view with a continuation keeps both forms', () => {
  it('`show file` and `show file systems` answer the same thing', async () => {
    const device = await privileged();

    expect(await device.executeCommand('show file'))
      .toBe(await device.executeCommand('show file systems'));
  });

  it('`show tcp` and `show tcp brief` likewise', async () => {
    const device = await privileged();

    expect(await device.executeCommand('show tcp'))
      .toBe(await device.executeCommand('show tcp brief'));
  });

  it('and `?` names the continuation', async () => {
    const device = await privileged();

    const offert = (input: string): string[] => device.cliHelp(input).split('\n')
      .map(line => /^\s\s(\S+)/.exec(line)?.[1])
      .filter((word): word is string => word !== undefined);

    expect(offert('show file ')).toContain('systems');
    expect(offert('show tcp ')).toContain('brief');
  });
});

describe('an unknown continuation is refused', () => {
  it.each(['show calendar zorglub', 'show reload zorglub', 'show sockets zorglub'])(
    '`%s` gets the caret rather than the view', async (command) => {
      const device = await privileged();

      expect(await device.executeCommand(command)).toContain('Invalid input');
    });
});
