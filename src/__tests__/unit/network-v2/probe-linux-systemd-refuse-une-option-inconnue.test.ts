/*
 * `systemctl --zorglub-x` listed the units, `hostnamectl --zorglub-x` printed the
 * status, `loginctl --zorglub-x` listed the sessions and `timedatectl
 * --zorglub-x` answered "Unknown command verb": the option was read as a verb or
 * dropped. systemd's tools refuse with `<tool>: unrecognized option '<opt>'` and
 * status 1; the four now share the getopt reader with the option sets of systemd
 * 249 (Ubuntu 22.04) written from memory of `systemctl --help`. Only refusals
 * are added: the options these tools accept are read as before.
 *
 * Measured before the change: 9 cases, 4 fall (the unknown long option of each tool
 * and an unknown short option); the 5 witnesses (accepted options) pass either way.
 */
import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

type Sh = { executeCommand(line: string): Promise<string> };

async function run(line: string): Promise<string> {
  const machine = new LinuxServer('linux-server', 'S1') as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine.executeCommand(line);
}

describe('witnesses: accepted options still work', () => {
  it.each([
    'systemctl --no-pager --type=service --state=running list-units',
    'systemctl -t service -a list-units',
    'systemctl --failed',
    'systemctl --version',
    'hostnamectl --static',
  ])('%s', async (line) => {
    expect(await run(line)).not.toMatch(/unrecognized option|invalid option/);
  });
});

describe('an unknown option is refused', () => {
  it.each([
    ['systemctl --zorglub-x', "systemctl: unrecognized option '--zorglub-x'"],
    ['hostnamectl --zorglub-x', "hostnamectl: unrecognized option '--zorglub-x'"],
    ['loginctl --zorglub-x', "loginctl: unrecognized option '--zorglub-x'"],
    ['timedatectl --zorglub-x', "timedatectl: unrecognized option '--zorglub-x'"],
  ])('%s', async (line, message) => {
    expect(await run(line)).toContain(message);
  });
});
