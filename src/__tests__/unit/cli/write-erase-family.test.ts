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

async function privilegedRouter(): Promise<Cli> {
  const router = new CiscoRouter(`R${serial++}`) as unknown as Cli;
  await router.executeCommand('enable');
  return router;
}

function offeredKeywords(help: string): string[] {
  return help.split('\n')
    .map(line => /^\s\s(\S+)/.exec(line)?.[1])
    .filter((word): word is string => word !== undefined);
}

describe('`write` alone saves, as `wr` has always done', () => {
  it('the bare form writes the configuration', async () => {
    const router = await privilegedRouter();

    expect(await router.executeCommand('write')).toContain('[OK]');
  });

  it('and its abbreviation reaches the same place', async () => {
    const router = await privilegedRouter();

    expect(await router.executeCommand('wr')).toContain('[OK]');
  });

  it('`write ?` therefore announces `<cr>`, and keeps its promise', async () => {
    const router = await privilegedRouter();

    expect(offeredKeywords(router.cliHelp('write ')))
      .toEqual(['erase', 'memory', 'terminal', '<cr>']);
    expect(await router.executeCommand('write')).not.toContain('Incomplete');
  });

  it('`write memory` and `write mem` are the same command', async () => {
    const long = await privilegedRouter();
    const court = await privilegedRouter();

    expect(await long.executeCommand('write memory'))
      .toBe(await court.executeCommand('write mem'));
  });

  it('`write terminal` renders the running configuration itself', async () => {
    const router = await privilegedRouter();

    expect(await router.executeCommand('write terminal'))
      .toBe(await router.executeCommand('show running-config'));
  });
});

describe('a word that follows a complete command is shown, not resolved', () => {
  it('`write zorglub` gets the caret rather than a name lookup', async () => {
    const router = await privilegedRouter();

    const out = await router.executeCommand('write zorglub');

    expect(out).toContain('% Invalid input detected');
    expect(out).not.toContain('Translating');
  });

  it('and so does a word under a branch the socle owns', async () => {
    const router = await privilegedRouter();

    const out = await router.executeCommand('erase zorglub');

    expect(out).toContain('% Invalid input detected');
    expect(out).not.toContain('Translating');
  });

  it('`erase` alone is incomplete, since nothing says what to erase', async () => {
    const router = await privilegedRouter();

    expect(await router.executeCommand('erase')).toContain('Incomplete');
  });
});

describe('erasing keeps its confirmation dialog after migrating', () => {
  it.each(['erase startup-config', 'write erase', 'erase nvram:'])(
    '`%s` still has an interaction plan', async (command) => {
      const device = new CiscoRouter(`P${serial++}`);
      const shell = (device as unknown as {
        getShell(): { interactionPlanFor(line: string, ctx: object): unknown };
      }).getShell();

      expect(shell.interactionPlanFor(
        command, { mode: 'privileged', device, level: 15 })).not.toBeNull();
    });

  it('and answers with the confirm transcript', async () => {
    const router = await privilegedRouter();

    expect(await router.executeCommand('erase startup-config'))
      .toContain('Erase of nvram: complete');
  });
});

describe('the switch answers exactly as the router does', () => {
  async function privilegedSwitch(): Promise<Cli> {
    const device = createDevice('switch-cisco', 0, 0) as unknown as Cli;
    await device.executeCommand('enable');
    return device;
  }

  it('`write ?` offers the same three keywords and `<cr>`', async () => {
    const router = await privilegedRouter();
    const device = await privilegedSwitch();

    expect(offeredKeywords(device.cliHelp('write ')))
      .toEqual(offeredKeywords(router.cliHelp('write ')));
  });

  it('`write` saves there too', async () => {
    const device = await privilegedSwitch();

    expect(await device.executeCommand('write')).toContain('[OK]');
  });

  it('and `erase nvram:` erases there too', async () => {
    const device = await privilegedSwitch();

    expect(await device.executeCommand('erase nvram:'))
      .toContain('Erase of nvram: complete');
  });
});
