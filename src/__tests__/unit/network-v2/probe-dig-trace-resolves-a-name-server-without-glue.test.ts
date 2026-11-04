/*
 * Probe — `dig +trace @resolver name` finds the address of a name server the referral gives without glue by asking the resolver it was given, as the system resolver does for the real dig, and not the server of the
 * hop it has just left.
 *
 * Measured first (the lab of labs/dns-agence-bancaire, after the zone exemple.test was created on NS1-BANK and delegated by ROOT-NS to ns1.banquehorizon.com, a name outside the root zone, so with no glue):
 * `dig +trace @10.20.20.53 www.exemple.test` printed the root hop and the referral `test. NS ns1.banquehorizon.com.` and stopped on `;; connection timed out; no servers could be reached`: the address of
 * ns1.banquehorizon.com was asked, recursively, to the ROOT (198.51.100.1), which does not recurse and does not know the name.
 * The trace with the same delegation WITH glue (`com`, `banquehorizon.com`) never needed that lookup and passed either way.
 * Discrimination (git stash push -- src/network): 1 of the 2 cases falls (the delegation without glue); the other is the WITNESS (the glue case walks to the answer).
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

describe('dig +trace and a delegation without glue', () => {
  it('WITNESS: a delegation with glue walks from the root to the answer', async () => {
    await buildDnsAgenceBancaire();
    const devices = new Map<string, Equipment>([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
    const text = await devices.get('PC-CONSEILLER')!.executeCommand('dig +trace @10.20.20.53 www.banquehorizon.com');
    expect(text).toContain('www.banquehorizon.com.\t3600\tIN\tCNAME\tweb.banquehorizon.com.');
  });

  it('the address of a name server named without glue is asked to the resolver given on the command line', async () => {
    const lab = await buildDnsAgenceBancaire();
    const devices = new Map<string, Equipment>([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
    const ns1 = devices.get('NS1-BANK')!;
    const root = devices.get('ROOT-NS')!;
    await lab.bench.writeFile(ns1, '/etc/bind/db.exemple.test', '$TTL 3600\n@ IN SOA ns1.banquehorizon.com. hostmaster.banquehorizon.com. ( 1 7200 900 1209600 3600 )\n@ IN NS ns1.banquehorizon.com.\nwww IN A 203.0.113.40');
    await lab.bench.shell(ns1, 'echo \'zone "exemple.test" { type primary; file "/etc/bind/db.exemple.test"; };\' | sudo tee -a /etc/bind/named.conf', 'sudo rndc reconfig');
    await lab.bench.shell(root, 'echo \'test. IN NS ns1.banquehorizon.com.\' | sudo tee -a /etc/bind/db.root', 'sudo rndc reload');
    const text = await devices.get('PC-CONSEILLER')!.executeCommand('dig +trace @10.20.20.53 www.exemple.test');
    expect(text).toContain('test.\t\t\t86400\tIN\tNS\tns1.banquehorizon.com.');
    expect(text).toContain('www.exemple.test.\t3600\tIN\tA\t203.0.113.40');
    expect(text).not.toContain('no servers could be reached');
  });
});
