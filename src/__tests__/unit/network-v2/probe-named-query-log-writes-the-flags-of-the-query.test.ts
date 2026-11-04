/*
 * The flags that named writes after the type in the query log (BIND 9.18.39, recorded by running the real dig against the real named with `rndc querylog on`): `+` when the question asks for recursion and `-`
 * when it does not (`+norecurse`), `E(0)` when it carries an EDNS OPT (and nothing under `+noedns`), `T` when it came over TCP, `D` when the OPT sets DO (`+dnssec`), `K` when it carries a cookie. The
 * simulator wrote a `+` in every line. Measured with the real dig: `+short` gave `+E(0)K`, `+noedns` gave `+`, `+norecurse` gave `-E(0)K`, `+tcp` gave `+E(0)TK`, `+nocookie` gave `+E(0)` and
 * `+dnssec` gave `+E(0)DK`. The simulator's dig sends no cookie, so its lines end where the real ones end before the `K`.
 * Measured before the change (git stash push -- src/network): 4 of the 5 tests fall (`-`, `E(0)`, `T` and `D` were never written); the one that passes either way is the WITNESS, which only reads the
 * first character of the flags of the default question.
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

async function flagsOf(options: string): Promise<string> {
  const lab = await buildDnsAgenceBancaire();
  const devices = new Map<string, Equipment>([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
  const resolver = devices.get('DNS-RES')!;
  await lab.bench.shell(resolver, 'sudo rndc querylog on');
  await lab.bench.shell(devices.get('PC-CONSEILLER')!, `dig @10.20.20.53 mail.banquehorizon.com ${options} +short`);
  const log = await lab.bench.shell(resolver, 'sudo cat /var/log/named/query.log');
  return /query: mail\.banquehorizon\.com IN A (\S+) \(10\.20\.20\.53\)/.exec(log)![1];
}

describe('the flags of a query in the query log', () => {
  it('WITNESS: the log holds the line of the question and the address of the server', async () => {
    expect(await flagsOf('')).toMatch(/^[+-]/);
  });

  it('a default dig is recursive and carries an EDNS OPT', async () => {
    expect(await flagsOf('')).toBe('+E(0)');
  });

  it('+norecurse is written with a minus', async () => {
    expect(await flagsOf('+norecurse')).toBe('-E(0)');
  });

  it('+noedns leaves no OPT and +tcp adds T', async () => {
    expect(await flagsOf('+noedns')).toBe('+');
    expect(await flagsOf('+tcp')).toBe('+E(0)T');
  });

  it('+dnssec adds D', async () => {
    expect(await flagsOf('+dnssec')).toBe('+E(0)D');
  });
});
