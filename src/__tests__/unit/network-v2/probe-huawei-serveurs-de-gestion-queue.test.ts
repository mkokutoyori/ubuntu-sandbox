/*
 * `telnet server enable`, `stelnet server enable` and `ntp-service
 * authentication enable` followed by a stray word.
 *
 * Measured before the change: 3 of the 6 cases fall; the three refusals were
 * accepted and the stray word dropped. The three witnesses (the bare forms)
 * pass either way. The wider habit of these management configurators - an
 * unknown form is recorded verbatim as a raw line (`recordRaw`) instead of
 * being refused - is not closed here: the VRP grammar was not reachable, so
 * it is recorded in TODO.md rather than guessed.
 */
import { describe, it, expect } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function inSystemView(): Promise<Cli> {
  const r = new HuaweiRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  await r.executeCommand('system-view');
  return r;
}

describe('Huawei management enable commands', () => {
  it.each([
    'telnet server enable', 'stelnet server enable', 'ntp-service authentication enable',
  ])('witness: `%s` is accepted', async (line) => {
    expect(await (await inSystemView()).executeCommand(line)).toBe('');
  });

  it.each([
    'telnet server enable zorglub', 'stelnet server enable zorglub',
    'ntp-service authentication enable zorglub',
  ])('`%s` is refused', async (line) => {
    expect(await (await inSystemView()).executeCommand(line)).toMatch(/Error/);
  });
});
