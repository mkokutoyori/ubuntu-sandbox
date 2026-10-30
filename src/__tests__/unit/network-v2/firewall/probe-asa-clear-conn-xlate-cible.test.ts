/*
 * ASA `clear conn`, `clear xlate` and `clear logging buffer`: the filters
 * were never read, so `clear conn address 10.0.0.1` wiped EVERY connection
 * and `clear conn zorglub`, `clear xlate zorglub` and `clear logging buffer
 * zorglub` were accepted.
 *
 * Measured before the change: 6 of the 10 cases fall (address, port and
 * protocol filters each removed both sessions, plus the three `zorglub`
 * forms). The 4 that pass either way: the lab witness (two real sessions are
 * in the table), `clear conn` and `clear conn all` clearing both, and
 * `clear xlate` accepted bare. Filter grammar (all | address | port |
 * protocol; global | local | gport | lport | interface) is from memory, not
 * from a fetched page.
 */
import { describe, it, expect } from 'vitest';
import { AsaFirewall } from '@/network/devices/firewall/vendors/asa/AsaFirewall';
import { makeFlowKey } from '@/network/devices/firewall/session/FlowKey';

async function lab(): Promise<{ run: (c: string) => Promise<string>; held: () => string[] }> {
  const fw = new AsaFirewall('firewall-cisco', 'ASA1', 0, 0);
  fw.powerOn();
  const table = fw.getSessionTable();
  const options = {
    ingressZone: '', egressZone: '', ingressInterface: 'GigabitEthernet0/0',
    egressInterface: 'GigabitEthernet0/1', timeoutSec: 300,
  };
  table.install(makeFlowKey('10.0.0.1', 1024, '10.0.0.9', 80, 6), {
    ...options, replyKey: makeFlowKey('10.0.0.9', 80, '10.0.0.1', 1024, 6),
  });
  table.install(makeFlowKey('10.0.0.2', 1025, '10.0.0.9', 53, 17), {
    ...options, replyKey: makeFlowKey('10.0.0.9', 53, '10.0.0.2', 1025, 17),
  });
  await fw.executeCommand('enable');
  return {
    run: (c) => fw.executeCommand(c),
    held: () => table.view().all().map((s) => s.c2s.sourceIP).sort(),
  };
}

describe('clear conn', () => {
  it('witness: two sessions are in the table', async () => {
    expect((await lab()).held()).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  it.each(['clear conn', 'clear conn all'])('`%s` clears everything', async (line) => {
    const { run, held } = await lab();
    expect(await run(line)).toBe('');
    expect(held()).toEqual([]);
  });

  it.each([
    ['clear conn address 10.0.0.1', ['10.0.0.2']],
    ['clear conn port 53', ['10.0.0.1']],
    ['clear conn protocol udp', ['10.0.0.1']],
  ])('`%s` clears only the matching session', async (line, left) => {
    const { run, held } = await lab();
    expect(await run(line)).toBe('');
    expect(held()).toEqual(left);
  });

  it.each(['clear conn zorglub', 'clear xlate zorglub', 'clear logging buffer zorglub'])(
    '`%s` is refused', async (line) => {
      const { run, held } = await lab();
      expect(await run(line)).toMatch(/Invalid input|ERROR/i);
      expect(held()).toHaveLength(2);
    });

  it('`clear xlate` is accepted bare', async () => {
    expect(await (await lab()).run('clear xlate')).toBe('');
  });
});
