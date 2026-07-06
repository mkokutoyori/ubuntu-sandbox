/**
 * `C:\users.txt` — a small account-roster documentation file seeded next
 * to the other sample data files (`numbers.txt`/`nums.txt`), listing every
 * local user's name, password, and group memberships. Rendered from
 * `WindowsUserManager` (the real source of truth for accounts) rather than
 * a second, hand-maintained copy of the same data in `WindowsFileSystem.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('C:\\users.txt account roster', () => {
  it('exists at the root, next to numbers.txt', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-PC1');
    const dir = await pc.executeCommand('dir C:\\');
    expect(dir).toContain('users.txt');
    expect(dir).toContain('numbers.txt');
  });

  it('lists the built-in accounts with their real passwords and groups', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-PC1');
    const content = await pc.executeCommand('type C:\\users.txt');

    expect(content).toMatch(/Administrator \/ admin \/ Administrators/);
    expect(content).toMatch(/Guest \/ \(none\) \/ Guests/);
    expect(content).toMatch(/User \/ user \/ Users/);
  });

  it('lists the standard alice/bob/carl/dave cast with password === username', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-PC1');
    const content = await pc.executeCommand('type C:\\users.txt');

    for (const u of ['alice', 'bob', 'carl', 'dave']) {
      expect(content).toMatch(new RegExp(`${u} / ${u} /`));
    }
  });

  it('never shows a blank password field — disabled/no-password accounts read "(none)"', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-PC1');
    const content = await pc.executeCommand('type C:\\users.txt');

    expect(content).not.toMatch(/^\w+ \/ \/ /m);
    expect(content).toMatch(/DefaultAccount \/ \(none\) \/ \(none\)/);
  });
});
