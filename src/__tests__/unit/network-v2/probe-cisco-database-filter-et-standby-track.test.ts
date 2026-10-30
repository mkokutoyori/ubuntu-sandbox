/*
 * `ip ospf database-filter` and `standby <n> track` / `vrrp <n> track`.
 * `ip ospf database-filter zorglub` was accepted and silently did nothing
 * (only `all out` set the filter; any other word returned success), and the
 * tracked object of `standby 1 track zorglub` was any word.
 *
 * Measured before the change: 5 of the 10 cases fall (the three database-filter
 * refusals - `zorglub`, `all zorglub`, `all out zorglub` - and the two track
 * refusals); the 5 witnesses (`ip ospf database-filter all out`, `standby 1 track 10`,
 * `standby 1 track GigabitEthernet0/1`, `vrrp 1 track 10`, and `all out` rendered
 * back in the running-config) pass either way. Accepted tracked objects (1-1000, or
 * an interface name) are from memory, not from a fetched page.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function onInterface(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal', 'interface GigabitEthernet0/0']) {
    await r.executeCommand(l);
  }
  return r;
}

describe('witnesses', () => {
  it.each([
    'ip ospf database-filter all out', 'standby 1 track 10', 'standby 1 track GigabitEthernet0/1',
    'vrrp 1 track 10',
  ])('`%s` is accepted', async (line) => {
    expect(await (await onInterface()).executeCommand(line)).toBe('');
  });

  it('witness: `all out` is rendered back in the running-config', async () => {
    const cli = await onInterface();
    await cli.executeCommand('ip ospf database-filter all out');
    await cli.executeCommand('end');
    expect(await cli.executeCommand('show running-config')).toContain('ip ospf database-filter all out');
  });
});

describe('refusals', () => {
  it.each([
    'ip ospf database-filter zorglub', 'ip ospf database-filter all zorglub',
    'ip ospf database-filter all out zorglub', 'standby 1 track zorglub', 'vrrp 1 track zorglub',
  ])('`%s` is refused', async (line) => {
    expect(await (await onInterface()).executeCommand(line)).toMatch(/Invalid input detected|Incomplete command/);
  });
});
