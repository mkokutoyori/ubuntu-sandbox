/**
 * `ssh` from a machine that has no address and no route reports
 * `Network is unreachable`, like OpenSSH, and never reaches a login.
 *
 * Measured before the fix: `peerLiveness` answered "alive" whenever the source
 * device had no configured address, so the terminal went on to the connection
 * and printed `user@10.99.99.99: Permission denied (publickey,password).` for
 * an address nobody owns.
 *
 * Discriminated with `git stash push -- src/network/protocols/ssh`: 1 of the 3
 * cases falls before the fix (the terminal one). The other two are the
 * WITNESSES: the executeCommand path already answered correctly, and an
 * address the machine owns is still reported reachable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { peerLiveness } from '@/network/protocols/ssh/sessionLiveness';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}

let pc: LinuxPC;

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1');
  pc.powerOn();
});

describe('ssh from a machine with no address and no route', () => {
  it('the terminal says Network is unreachable', async () => {
    const term = new LinuxTerminalSession('t', pc);
    term.setInput('ssh user@10.99.99.99');
    term.setInputBuf('ssh user@10.99.99.99');
    term.handleKey(key('Enter'));
    await new Promise((r) => setTimeout(r, 300));
    const screen = term.lines.map((l) => l.text).join('\n');
    expect(screen).toContain('Network is unreachable');
    expect(screen).not.toContain('Permission denied');
  });

  it('WITNESS: the non-interactive path already says so', async () => {
    expect(await pc.executeCommand('ssh user@10.99.99.99')).toContain('Network is unreachable');
  });

  it('WITNESS: the loopback address is still reachable', () => {
    expect(peerLiveness(pc, '127.0.0.1')()).toBe(true);
  });
});
