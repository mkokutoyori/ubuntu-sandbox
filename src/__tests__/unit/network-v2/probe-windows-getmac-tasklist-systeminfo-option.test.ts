/*
 * `getmac`, `tasklist` and `systeminfo` ignored a switch or word they do not
 * have (`getmac /zorglub`, `tasklist zorglub`, `systeminfo /zorglub` printed
 * their normal output). Windows answers `ERROR: Invalid argument/option -
 * '<token>'.` and `Type "<CMD> /?" for usage.`, the same shape `whoami`
 * already used (that string now comes from one helper, WinSwitchGuard).
 *
 * Measured before the change: 6 of the 13 cases fall (every refusal); the 7
 * witnesses (bare forms, `/fo csv`, `/v`, `/nh`) pass either way. The switch
 * tables are from memory of the usage texts, not from a fetched page.
 */
import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';

type Sh = { executeCommand(line: string): Promise<string> };

function pc(): Sh {
  const machine = new WindowsPC('windows-pc', 'WIN1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

describe('valid switches still work', () => {
  it.each([
    'getmac', 'getmac /fo csv', 'getmac /v', 'tasklist', 'tasklist /fo csv /nh',
    'tasklist /fi "imagename eq explorer.exe"', 'systeminfo',
  ])('witness: `%s`', async (line) => {
    expect(await pc().executeCommand(line)).not.toMatch(/Invalid argument\/option/);
  });
});

describe('an unknown switch or word is refused', () => {
  it.each([
    ['getmac /zorglub', '/zorglub', 'GETMAC'],
    ['getmac zorglub', 'zorglub', 'GETMAC'],
    ['tasklist /zorglub', '/zorglub', 'TASKLIST'],
    ['tasklist zorglub', 'zorglub', 'TASKLIST'],
    ['systeminfo /zorglub', '/zorglub', 'SYSTEMINFO'],
    ['systeminfo zorglub', 'zorglub', 'SYSTEMINFO'],
  ])('`%s`', async (line, token, command) => {
    const output = await pc().executeCommand(line);
    expect(output).toContain(`ERROR: Invalid argument/option - '${token}'.`);
    expect(output).toContain(`Type "${command} /?" for usage.`);
  });
});
