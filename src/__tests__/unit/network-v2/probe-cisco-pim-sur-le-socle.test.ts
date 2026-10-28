/*
 * PIM configuration (interface and global) declared natively on the socle
 * instead of re-read from the trie.
 *
 * Measured before the change: 8 of the 12 cases fall —
 *   rp-address 999.1.1.1 and join-prune-interval 0 answered a bare
 *     "% Invalid ..." with no caret,
 *   spt-threshold accepted any word and kept nothing, so a valid one never
 *     reached the running-config,
 *   bsr-candidate accepted a hash mask length of 99999,
 *   `no ip pim dr-priority` DISABLED PIM on the interface instead of
 *     restoring the default priority,
 *   query-interval was stored and never rendered in the running-config,
 *   dr-priority zorglub answered "% Invalid priority" without a caret.
 * Pass either way (4): the witnesses — a valid rp-address, its removal, a
 * valid bsr-candidate, and `no ip pim sparse-mode`.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function router(...lines: string[]): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of [
    'enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', ...lines,
  ]) await r.executeCommand(l);
  return r;
}

const running = async (r: Cli): Promise<string> => r.executeCommand('do show running-config');
const CARET = /\^\n% Invalid input detected at '\^' marker\./;

describe('PIM global configuration on the socle', () => {
  it('witness: a valid static RP is applied and rendered', async () => {
    const r = await router('ip pim rp-address 10.0.0.9');
    expect(await running(r)).toContain('ip pim rp-address 10.0.0.9');
  });

  it('refuses a malformed RP address at the caret', async () => {
    const r = await router();
    expect(await r.executeCommand('ip pim rp-address 999.1.1.1')).toMatch(CARET);
  });

  it('`no ip pim rp-address` removes the static RP', async () => {
    const r = await router('ip pim rp-address 10.0.0.9', 'no ip pim rp-address 10.0.0.9');
    expect(await running(r)).not.toContain('ip pim rp-address');
  });

  it('refuses a spt-threshold that is neither infinity nor a rate', async () => {
    const r = await router();
    expect(await r.executeCommand('ip pim spt-threshold zorglub')).toMatch(CARET);
  });

  it('renders the spt-threshold it accepted, and `no` removes it', async () => {
    const r = await router('ip pim spt-threshold 5');
    expect(await running(r)).toContain('ip pim spt-threshold 5');
    await r.executeCommand('no ip pim spt-threshold');
    expect(await running(r)).not.toContain('ip pim spt-threshold');
  });

  it('witness: a valid candidate BSR is accepted', async () => {
    const r = await router();
    expect(await r.executeCommand('ip pim bsr-candidate GigabitEthernet0/0 24 10')).toBe('');
  });

  it('refuses a hash mask length beyond 32', async () => {
    const r = await router();
    expect(await r.executeCommand('ip pim bsr-candidate GigabitEthernet0/0 99999'))
      .toMatch(CARET);
  });

  it('refuses a join-prune interval of zero', async () => {
    const r = await router();
    expect(await r.executeCommand('ip pim join-prune-interval 0')).toMatch(CARET);
  });
});

describe('PIM interface configuration on the socle', () => {
  it('witness: `no ip pim sparse-mode` disables PIM on the interface', async () => {
    const r = await router('interface GigabitEthernet0/0', 'ip pim sparse-mode');
    expect(await running(r)).toContain('ip pim sparse-mode');
    await r.executeCommand('no ip pim sparse-mode');
    expect(await running(r)).not.toContain('ip pim sparse-mode');
  });

  it('`no ip pim dr-priority` restores the default and keeps PIM enabled', async () => {
    const r = await router('interface GigabitEthernet0/0', 'ip pim sparse-mode',
      'ip pim dr-priority 5');
    expect(await running(r)).toContain('ip pim dr-priority 5');
    await r.executeCommand('no ip pim dr-priority');
    const after = await running(r);
    expect(after).not.toContain('ip pim dr-priority');
    expect(after).toContain('ip pim sparse-mode');
  });

  it('renders a non-default query-interval and `no` restores it', async () => {
    const r = await router('interface GigabitEthernet0/0', 'ip pim sparse-mode',
      'ip pim query-interval 20');
    expect(await running(r)).toContain('ip pim query-interval 20');
    await r.executeCommand('no ip pim query-interval');
    expect(await running(r)).not.toContain('ip pim query-interval');
  });

  it('refuses a non-numeric DR priority at the caret', async () => {
    const r = await router('interface GigabitEthernet0/0');
    expect(await r.executeCommand('ip pim dr-priority zorglub')).toMatch(CARET);
  });
});
