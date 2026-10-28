/*
 * A command declared as bare keywords never accepts a trailing word.
 *
 * The defect class: `ip multicast-routing zorglub` was registered greedy
 * while reading no argument, so it was accepted and did nothing. On the
 * socle a path made only of keywords, with no option bag, must answer
 * incomplete or invalid when a stray word follows — except the commands
 * that legitimately take a free-form target the declaration does not
 * model as a place, listed by name below so a new one is a decision.
 *
 * Measured on the Cisco router and switch tables when this guard was
 * written: 5 of the several thousand keyword-only paths accepted a stray
 * word, all four distinct commands in the allowlist. The witness proves the
 * parser does reject a stray word after an ordinary command.
 */
import { describe, it, expect } from 'vitest';
import { newSession } from '@/cli/CliSession';
import { parseCommand } from '@/cli/CommandParser';
import type { CommandTable } from '@/cli/CommandTable';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

const TAKE_A_FREE_TARGET = new Set([
  'ping', 'traceroute', 'show crypto pki server', 'show crypto ca server',
]);

type Shelled = { getShell(): { socleTable(): CommandTable | null } };

function strayWordAccepted(device: unknown): string[] {
  const table = (device as Shelled).getShell().socleTable() as CommandTable;
  const accepted: string[] = [];
  for (const spec of table.specs()) {
    if (spec.hidden || spec.existsOnlyNegated || spec.options) continue;
    if (!spec.path.every((step) => typeof step === 'string')) continue;
    const head = spec.path.join(' ');
    if (TAKE_A_FREE_TARGET.has(head)) continue;
    const session = newSession('R1', device as object,
      { privilegeLevel: 15, initialMode: spec.modes[0] });
    if (parseCommand(table, `${head} zorglub`, session).status === 'ok') {
      accepted.push(`[${spec.modes[0]}] ${head}`);
    }
  }
  return accepted;
}

describe('a keyword-only command refuses a stray word', () => {
  it('witness: the parser rejects a stray word after an ordinary command', () => {
    const table = (new CiscoRouter('R1', 0, 0) as unknown as Shelled).getShell()
      .socleTable() as CommandTable;
    const session = newSession('R1', {}, { privilegeLevel: 15, initialMode: 'privileged' });
    expect(parseCommand(table, 'show version', session).status).toBe('ok');
    expect(parseCommand(table, 'show version zorglub', session).status).not.toBe('ok');
  });

  it('witness: the allowlist is real — ping takes a free target', () => {
    const table = (new CiscoRouter('R1', 0, 0) as unknown as Shelled).getShell()
      .socleTable() as CommandTable;
    const session = newSession('R1', {}, { privilegeLevel: 15, initialMode: 'privileged' });
    expect(parseCommand(table, 'ping zorglub', session).status).toBe('ok');
  });

  it.each([
    ['router', () => new CiscoRouter('R1', 0, 0)],
    ['switch', () => new CiscoSwitch('SW1', 0, 0)],
  ])('no keyword-only path of the %s table accepts it', (_name, make) => {
    expect(strayWordAccepted(make())).toEqual([]);
  });
});
