import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function enabled(device: CiscoRouter | CiscoSwitch) {
  await device.executeCommand('enable');
  return device;
}

function numbersIn(line: string): number[] {
  return [...line.matchAll(/\d+/g)].map((m) => Number(m[0]));
}

function lineWith(output: string, prefix: string): string {
  return output.split('\n').find((l) => l.includes(prefix)) ?? '';
}

describe('show file systems reads the real filesystem', () => {
  it('flash: reports a size and free space, not a dash', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    const line = lineWith(await r.executeCommand('show file systems'), 'flash:');

    expect(line).not.toMatch(/-\s+-/);
    const [size, free] = numbersIn(line);
    expect(size).toBeGreaterThan(0);
    expect(free).toBeGreaterThan(0);
    expect(free).toBeLessThan(size);
  });

  it('free space matches what show flash: reports', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    const flash = await r.executeCommand('show flash:');
    const [total, free] = numbersIn(
      flash.split('\n').find((l) => l.includes('bytes total')) ?? '');

    const line = lineWith(await r.executeCommand('show file systems'), 'flash:');
    expect(numbersIn(line)).toEqual([total, free]);
  });

  it('writing to flash: lowers free space in BOTH views at once', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    const before = numbersIn(lineWith(await r.executeCommand('show file systems'), 'flash:'))[1];

    await r.executeCommand('configure terminal');
    await r.executeCommand('archive');
    await r.executeCommand('path flash:cfg');
    await r.executeCommand('end');
    await r.executeCommand('archive config');

    const after = numbersIn(lineWith(await r.executeCommand('show file systems'), 'flash:'))[1];
    expect(after).toBeLessThan(before);

    const flash = await r.executeCommand('show flash:');
    const flashFree = numbersIn(
      flash.split('\n').find((l) => l.includes('bytes total')) ?? '')[1];
    expect(flashFree).toBe(after);
  });

  it('it lists only filesystems the device can actually open', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    const listed = (await r.executeCommand('show file systems')).split('\n')
      .map((l) => /\srw\s+(\w+:)\s*$/.exec(l)?.[1])
      .filter((p): p is string => p !== undefined);

    expect(listed).not.toEqual([]);
    for (const prefix of listed) {
      expect(await r.executeCommand(`dir ${prefix}`)).not.toContain('%Error opening');
    }
  });

  it('the asterisk marks the filesystem `dir` with no argument really uses', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    const starred = (await r.executeCommand('show file systems')).split('\n')
      .find((l) => l.startsWith('*'));
    expect(starred).toBeDefined();
    const prefix = /\srw\s+(\w+:)\s*$/.exec(starred!)![1];

    expect(await r.executeCommand('pwd')).toContain(prefix);
    expect(await r.executeCommand('dir')).toBe(await r.executeCommand(`dir ${prefix}`));
  });

  it('the current filesystem carries its asterisk', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    const output = await r.executeCommand('show file systems');
    expect(lineWith(output, 'flash:').startsWith('*')).toBe(true);
    expect(lineWith(output, 'nvram:').startsWith('*')).toBe(false);
  });

  it('a switch answers too, with ITS own flash capacity', async () => {
    const sw = await enabled(new CiscoSwitch('SW1'));
    const r = await enabled(new CiscoRouter('R1'));

    const switchSize = numbersIn(lineWith(await sw.executeCommand('show file systems'), 'flash:'))[0];
    const routerSize = numbersIn(lineWith(await r.executeCommand('show file systems'), 'flash:'))[0];

    expect(switchSize).toBeGreaterThan(0);
    expect(switchSize).not.toBe(routerSize);
  });
});

describe('NVRAM has a single size', () => {
  it('dir nvram: and show file systems report the same total', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    const dir = await r.executeCommand('dir nvram:');
    const dirTotal = numbersIn(
      dir.split('\n').find((l) => l.includes('bytes total')) ?? '')[0];

    const fsTotal = numbersIn(lineWith(await r.executeCommand('show file systems'), 'nvram:'))[0];
    expect(fsTotal).toBe(dirTotal);
  });

  it('show startup-config counts against the same NVRAM', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    await r.executeCommand('write memory');
    const startup = await r.executeCommand('show startup-config');
    const reported = /Using \d+ out of (\d+) bytes/.exec(startup);
    expect(reported).not.toBeNull();

    const fsTotal = numbersIn(lineWith(await r.executeCommand('show file systems'), 'nvram:'))[0];
    expect(Number(reported![1])).toBe(fsTotal);
  });

  it('the switch NVRAM is not the router one', async () => {
    const sw = await enabled(new CiscoSwitch('SW1'));
    const r = await enabled(new CiscoRouter('R1'));
    const switchTotal = numbersIn(lineWith(await sw.executeCommand('show file systems'), 'nvram:'))[0];
    const routerTotal = numbersIn(lineWith(await r.executeCommand('show file systems'), 'nvram:'))[0];
    expect(switchTotal).not.toBe(routerTotal);
  });

  it('saving a configuration reduces NVRAM free space', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    const empty = numbersIn(lineWith(await r.executeCommand('show file systems'), 'nvram:'))[1];

    await r.executeCommand('configure terminal');
    await r.executeCommand('hostname A-FAIRLY-LONG-NAME-TO-FILL-THE-NVRAM');
    await r.executeCommand('end');
    await r.executeCommand('write memory');

    const filled = numbersIn(lineWith(await r.executeCommand('show file systems'), 'nvram:'))[1];
    expect(filled).toBeLessThan(empty);
  });
});
