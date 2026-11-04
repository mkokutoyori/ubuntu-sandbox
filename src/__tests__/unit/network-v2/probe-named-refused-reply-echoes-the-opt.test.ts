/*
 * A client that allow-query excludes gets a REFUSED that still carries the OPT of its question (real named 9.18.39 and the real dig: `ADDITIONAL: 1`, `; EDNS: version: 0, flags:; udp: 1232`, and with `+noedns`
 * `ADDITIONAL: 0`). Measured on DNS-RES of labs/dns-agence-bancaire once its `agence` ACL is changed so that PC-CONSEILLER is no longer in it: the reply said `ADDITIONAL: 0` and no OPT even for a question
 * that carried one. The real reply also holds the extended error `EDE: 18 (Prohibited)`, which the simulator does not write (TODO.md).
 * Measured before the change (git stash push -- src/network): 1 of the 3 tests falls (the OPT of the refusal); the 2 that pass either way are the WITNESS (the refusal itself) and the question without EDNS.
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

async function refusedBy(options: string): Promise<string> {
  const lab = await buildDnsAgenceBancaire();
  const devices = new Map<string, Equipment>([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
  await lab.bench.shell(devices.get('DNS-RES')!, "sudo sed -i 's#10.20.0.0/16;#10.99.0.0/16;#' /etc/bind/named.conf; sudo rndc reconfig");
  return lab.bench.shell(devices.get('PC-CONSEILLER')!, `dig @10.20.20.53 www.banquehorizon.com ${options} +noall +comments`);
}

describe('REFUSED sent to a client that allow-query excludes', () => {
  it('WITNESS: the question is refused', async () => {
    expect(await refusedBy('')).toContain('status: REFUSED');
  });

  it('echoes the OPT of the question', async () => {
    const out = await refusedBy('');
    expect(out).toContain('QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1');
    expect(out).toContain('; EDNS: version: 0, flags:; udp: 1232');
  });

  it('adds none to a question without EDNS', async () => {
    expect(await refusedBy('+noedns')).toContain('ADDITIONAL: 0');
  });
});
