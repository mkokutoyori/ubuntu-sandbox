/*
 * A restarted named holds nothing it had learned: the cache lives in the memory of the process. Measured on DNS-RES of labs/dns-agence-bancaire: after `systemctl restart named` the SERVFAIL kept for
 * www.broken.com (servfail-ttl 30) was still answered, and `rndc dumpdb -cache` still listed the sets of the names asked before the restart, so the only way to forget a failure was `rndc flush`.
 * Measured before the change (git stash push -- src/network): 2 of the 3 tests fall (the positive entry and the SERVFAIL entry survive the restart); the one that passes either way is the WITNESS, the same
 * lab asked twice without restart, which keeps both entries.
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

async function resolverLab() {
  const lab = await buildDnsAgenceBancaire();
  const devices = new Map<string, Equipment>([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
  const client = devices.get('PC-CONSEILLER')!;
  const resolver = devices.get('DNS-RES')!;
  await lab.bench.shell(client, 'dig @10.20.20.53 www.banquehorizon.com +short');
  const dumped = async () => lab.bench.shell(resolver, 'sudo rndc dumpdb -cache; sudo cat /var/cache/bind/named_dump.db');
  return { lab, resolver, dumped };
}

describe('named restarted', () => {
  it('WITNESS: the cache holds the name that was asked', async () => {
    const { dumped } = await resolverLab();
    expect(await dumped()).toContain('web.banquehorizon.com.');
  });

  it('holds nothing of what it had cached before the restart', async () => {
    const { lab, resolver, dumped } = await resolverLab();
    await lab.bench.shell(resolver, 'sudo systemctl restart named');
    const after = await dumped();
    expect(after).not.toContain('web.banquehorizon.com.');
    expect(after).not.toContain('www.banquehorizon.com.');
  });

  it('forgets a failure kept in the SERVFAIL cache', async () => {
    const { lab, resolver, dumped } = await resolverLab();
    const devices = new Map<string, Equipment>([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
    await lab.bench.powershell(devices.get('TLD-NS')!, 'Add-DnsServerZoneDelegation -Name com -ChildZoneName broken -NameServer ns.broken.com -IPAddress 203.0.113.99');
    await lab.bench.shell(devices.get('PC-CONSEILLER')!, 'dig @10.20.20.53 www.broken.com +noall +comments');
    expect(await dumped()).toContain('www.broken.com/A [ttl');
    await lab.bench.shell(resolver, 'sudo systemctl restart named');
    expect(await dumped()).not.toContain('www.broken.com/A [ttl');
  });
});
