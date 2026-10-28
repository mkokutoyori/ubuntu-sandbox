/*
 * `show memory|boot|flash:|controllers|environment` declared a free REST
 * tail and ignored it, so `show boot zorglub` printed the boot variables.
 *
 * Measured before the change: 5 of the 11 cases fall (one unknown word per
 * command); the 6 witnesses (bare forms plus `memory statistics`,
 * `controllers GigabitEthernet0/0`, `environment temperature`) pass either
 * way. The selector sets - memory: statistics|summary|free|io|processor|
 * allocating-process|dead|fragment|failures; flash: all|chips|detail|err|
 * summary; environment: all|fan|power|temperature|status|table|voltage|
 * alarm|leds; controllers: an interface; boot: nothing - are from memory,
 * not from a fetched page.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function exec(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  await r.executeCommand('enable');
  return r;
}

const WITNESSES = [
  'show memory', 'show memory statistics', 'show boot', 'show flash:',
  'show controllers GigabitEthernet0/0', 'show environment temperature',
];

const REFUSALS = [
  'show memory zorglub', 'show boot zorglub', 'show flash: zorglub',
  'show controllers zorglub', 'show environment zorglub',
];

describe('show exec tails', () => {
  it.each(WITNESSES)('witness: `%s` is accepted', async (line) => {
    expect(await (await exec()).executeCommand(line)).not.toMatch(/Invalid input/);
  });

  it.each(REFUSALS)('`%s` is refused', async (line) => {
    expect(await (await exec()).executeCommand(line)).toMatch(/Invalid input detected/);
  });
});
