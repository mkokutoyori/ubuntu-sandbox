/**
 * A relative path after `cd` in the same command line: `cd /tmp && echo x > f`, `cd /tmp; x=$(< f)`, `cd /tmp; [ -f f ]`.
 *
 * Measured on a fresh LinuxPC (bash does `cd` first and resolves every later word against the new directory): a redirect target
 * was resolved by the host against the directory the line STARTED in, because the host only learns the new directory when the next
 * external command is dispatched, while the interpreter already knew it (it expands globs against its own PWD). `cd /tmp && echo x > f`
 * therefore wrote /home/user/f. With the sources at HEAD 2 of the 5 cases fall (`>` and `>>`). The other three pass either way: the
 * `$(< file)` source, the file test and the witness meet the file through the same directory that wrote it, so the lab is sound but
 * the stale base does not show.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let pc: LinuxPC;

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
});

describe('relative paths after cd on one line', () => {
  it('> lands in the new directory', async () => {
    await pc.executeCommand('cd /tmp && echo x > landed.txt');
    expect(await pc.executeCommand('[ -e /tmp/landed.txt ] && echo in-tmp; [ -e /home/user/landed.txt ] && echo in-home')).toBe('in-tmp');
  });

  it('>> lands in the new directory', async () => {
    await pc.executeCommand('echo old > /tmp/appended.txt');
    await pc.executeCommand('cd /tmp; echo new >> appended.txt');
    expect(await pc.executeCommand('cat /tmp/appended.txt')).toBe('old\nnew');
  });

  it('$(< file) reads from the new directory', async () => {
    expect(await pc.executeCommand('cd /tmp; echo hi > read.txt; v=$(< read.txt); echo "[$v]"')).toBe('[hi]');
  });

  it('a file test looks in the new directory', async () => {
    expect(await pc.executeCommand('cd /tmp; touch tested.txt; [ -f tested.txt ] && echo yes || echo no')).toBe('yes');
  });

  it('WITNESS: a cd to the directory the line started in changes nothing', async () => {
    await pc.executeCommand('cd /tmp');
    await pc.executeCommand('cd /tmp; echo x > same.txt');
    expect(await pc.executeCommand('cat /tmp/same.txt')).toBe('x');
  });
});
