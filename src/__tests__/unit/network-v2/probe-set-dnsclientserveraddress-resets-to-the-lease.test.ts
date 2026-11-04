/*
 * Set-DnsClientServerAddress -ResetServerAddresses (Microsoft DnsClient module: "resets the DNS server addresses to the default value", which on an adapter configured by DHCP is the servers of
 * the lease, and a switch that cannot be combined with -ServerAddresses). Measured on PC-GUICHET1 of labs/dns-agence-bancaire, whose lease carries 10.20.20.10 and 10.20.20.53: with the adapter pointed at a
 * static 10.20.20.250 the cmdlet used to answer `Set-DnsClientServerAddress requires -ServerAddresses` and left the static server in place, so the only way back was `ipconfig /renew`, which
 * does not touch a static list.
 * Measured before the change (git stash push -- src/network src/powershell): 2 of the 3 tests fall (the reset and the refusal of the two parameters together); the one that passes either way
 * is the WITNESS, which builds the same lab, points the adapter to the static server and reads it back.
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

const LEASE = '10.20.20.10\n10.20.20.53';
const SERVERS = '(Get-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -AddressFamily IPv4).ServerAddresses';

async function guichet() {
  const lab = await buildDnsAgenceBancaire();
  const devices = new Map<string, Equipment>([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
  const client = devices.get('PC-GUICHET1')!;
  const read = async () => (await lab.bench.powershell(client, SERVERS)).trim();
  return { lab, client, read };
}

describe('Set-DnsClientServerAddress -ResetServerAddresses', () => {
  it('WITNESS: the lab hands out its two servers and a static server replaces it', async () => {
    const { lab, client, read } = await guichet();
    expect(await read()).toBe(LEASE);
    await lab.bench.powershell(client, 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 10.20.20.250');
    expect(await read()).toBe('10.20.20.250');
  });

  it('gives the adapter back the servers of its lease', async () => {
    const { lab, client, read } = await guichet();
    await lab.bench.powershell(client, 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 10.20.20.250');
    await lab.bench.powershell(client, 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ResetServerAddresses');
    expect(await read()).toBe(LEASE);
  });

  it('refuses -ServerAddresses and -ResetServerAddresses together and changes nothing', async () => {
    const { lab, client, read } = await guichet();
    const output = await lab.bench.powershell(client, 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 10.20.20.250 -ResetServerAddresses');
    expect(output).toContain('Parameter set cannot be resolved using the specified named parameters.');
    expect(await read()).toBe(LEASE);
  });
});
