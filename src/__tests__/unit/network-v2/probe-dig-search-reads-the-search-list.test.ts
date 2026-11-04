/*
 * dig +search against the real dig 9.18.39 with a resolv.conf holding `search banquehorizon.com` and `nameserver 10.20.20.53`: without +search dig asks for the name as typed (`web.` is NXDOMAIN); with it, a
 * name with fewer dots than ndots (1 by default) is tried with each suffix of the list first (`web` is asked as web.banquehorizon.com., and its reply is the one printed, question included), a name with
 * at least ndots dots is tried as typed first and then with the suffixes, an NXDOMAIN moves to the next candidate, and when every candidate fails the reply of the last, the name alone, is printed
 * (`;nexiste.`). `+nosearch` turns it off. The simulator accepted +search and ignored it. What the real dig does when every candidate fails also prints the stats of the tried queries twice in some
 * cases (`web.banquehorizon +search`): not reproduced, recorded in TODO.md.
 * Run on PC-CONSEILLER of labs/dns-agence-bancaire, whose search list is horizon.local (the zone of DC1: `intranet` is a CNAME of dc1).
 * Measured before the change (git stash push -- src/network src/powershell): 2 of the 5 tests fall (the name is asked as typed whatever the option, so the suffix is never tried); the 3 that pass either way are the
 * WITNESS, the name that exists as typed or nowhere (the same question with or without +search) and +nosearch.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { Equipment } from '@/network';
import { buildDnsAgenceBancaire } from '@/labs/dnsAgenceBancaire/build';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

async function lab() {
  const built = await buildDnsAgenceBancaire();
  const devices = new Map<string, Equipment>([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
  const client = devices.get('PC-CONSEILLER')!;
  return (command: string) => built.bench.shell(client, command);
}

describe('dig +search', () => {
  it('WITNESS: without +search the name is asked as typed and does not exist', async () => {
    const run = await lab();
    const out = await run('dig intranet +noall +comments +question');
    expect(out).toContain('status: NXDOMAIN');
    expect(out).toContain(';intranet.');
  });

  it('asks a name with fewer dots than ndots with the suffix of the list and prints that reply', async () => {
    const run = await lab();
    const out = await run('dig intranet +search +noall +comments +question +answer');
    expect(out).toContain('status: NOERROR');
    expect(out).toMatch(/^;intranet\.horizon\.local\.\s+IN\s+A$/m);
    expect(out).toMatch(/^intranet\.horizon\.local\.\s+\d+\s+IN\s+CNAME\s+dc1\.horizon\.local\.$/m);
    expect(out).toMatch(/^dc1\.horizon\.local\.\s+\d+\s+IN\s+A\s+10\.20\.20\.10$/m);
  });

  it('+short prints the answer of the candidate that exists', async () => {
    const run = await lab();
    expect((await run('dig intranet +search +short')).trim().split('\n')).toEqual(['dc1.horizon.local.', '10.20.20.10']);
  });

  it('a name that exists as typed is asked as typed first, and a name that exists nowhere prints the reply for the name alone', async () => {
    const run = await lab();
    expect((await run('dig dc1.horizon.local +search +short')).trim()).toBe('10.20.20.10');
    const out = await run('dig nexiste +search +noall +comments +question');
    expect(out).toContain('status: NXDOMAIN');
    expect(out).toContain(';nexiste.');
  });

  it('+nosearch after +search turns it off', async () => {
    const run = await lab();
    expect(await run('dig intranet +search +nosearch +noall +comments')).toContain('status: NXDOMAIN');
  });
});
