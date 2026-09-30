/*
 * Cisco IOS, DHCPv6 sur le moteur commun (RFC 8415) : `ipv6 dhcp server <pool>
 * rapid-commit preference N`, `prefix-delegation pool` + `ipv6 local pool`,
 * `prefix-delegation <prefix> <duid> [iaid N]`, `show ipv6 dhcp binding|pool`,
 * `clear ipv6 dhcp binding` et rendu dans `show running-config`.
 * Syntaxes et formats de sortie : documentation Cisco IOS « IPv6 Services:
 * DHCP for IPv6 » (commandes `show ipv6 dhcp binding`, `show ipv6 dhcp pool`,
 * `prefix-delegation`, `ipv6 local pool`) ; le texte de la page n'est pas
 * joignable depuis cet environnement, les formats viennent des exemples de la
 * documentation reproduits de memoire : ils ne sont pas verifies mot a mot.
 *
 * Avant le correctif : `ipv6 dhcp server POOL1 rapid-commit` etait accepte et
 * ignore, `prefix-delegation` et `ipv6 local pool` refuses, aucun `show ipv6
 * dhcp`, et la configuration des pools v6 absente de `show running-config` :
 * les 12 cas tombent, sauf le temoin (bail par SOLICIT/REQUEST) qui passe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = async (d: Cmd, cmds: string[]) => {
  let last = '';
  for (const c of cmds) last = await d.executeCommand(c);
  return last;
};

async function lab(extra: string[] = []) {
  const h1 = new LinuxPC('linux-pc', 'H1');
  const r1 = new CiscoRouter('R1');
  new Cable('a').connect(h1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  await run(r1, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::1/64', 'no shutdown', 'exit',
    'ipv6 dhcp pool POOL1', 'address prefix 2001:db8:1::/64 lifetime 3600 1800',
    'dns-server 2001:4860:4860::8888', 'domain-name test.lab',
    ...extra, 'exit',
    'interface GigabitEthernet0/0', 'ipv6 dhcp server POOL1', 'exit', 'end',
  ]);
  return { h1, r1 };
}

describe('temoin', () => {
  it('SOLICIT/ADVERTISE/REQUEST/REPLY : le routeur porte le bail', async () => {
    const { h1, r1 } = await lab();
    await h1.executeCommand('dhclient -6 eth0');
    expect(r1._getDHCPv6ServerInternal().getBindings().length).toBe(1);
  });
});

describe('ipv6 dhcp server <pool> rapid-commit preference', () => {
  it('rapid-commit : le client obtient son adresse en deux messages', async () => {
    const { h1, r1 } = await lab();
    await run(r1, ['configure terminal', 'interface GigabitEthernet0/0', 'ipv6 dhcp server POOL1 rapid-commit', 'end']);
    const out = h1.requestDhcpv6Lease('eth0', true, { rapidCommit: true });
    expect(out).toContain('(rapid commit)');
    expect(out).not.toContain('DHCPv6 REQUEST');
  });

  it('preference : portee par l Advertise', async () => {
    const { r1 } = await lab();
    await run(r1, ['configure terminal', 'interface GigabitEthernet0/0', 'ipv6 dhcp server POOL1 preference 30', 'end']);
    expect(r1._getDHCPv6ServerInternal().getPool('POOL1')!.preference).toBe(30);
  });

  it('un mot-cle inconnu est refuse', async () => {
    const { r1 } = await lab();
    const out = await run(r1, ['configure terminal', 'interface GigabitEthernet0/0', 'ipv6 dhcp server POOL1 zorglub']);
    expect(out).toContain('Invalid input');
  });

  it('le rendu de l interface porte les mots-cles', async () => {
    const { r1 } = await lab();
    await run(r1, ['configure terminal', 'interface GigabitEthernet0/0', 'ipv6 dhcp server POOL1 rapid-commit preference 30', 'end']);
    expect(await r1.executeCommand('show running-config')).toContain(' ipv6 dhcp server POOL1 rapid-commit preference 30');
  });
});

describe('delegation de prefixes', () => {
  it('ipv6 local pool + prefix-delegation pool : le client recoit un /48', async () => {
    const { h1, r1 } = await lab(['prefix-delegation pool CUSTOMERS']);
    await run(r1, ['configure terminal', 'ipv6 local pool CUSTOMERS 2001:db8:aa00::/40 48', 'end']);
    h1.requestDhcpv6Lease('eth0', false, { prefixDelegation: true });
    expect(h1.getDhcpv6Lease('eth0')?.prefix).toEqual({ prefix: '2001:db8:aa00::', prefixLength: 48 });
  });

  it('prefix-delegation statique par DUID : le client designe recoit son prefixe', async () => {
    const { h1, r1 } = await lab();
    const duid = `0003000 1${h1.getPort('eth0')!.getMAC().toString().replace(/:/g, '')}`.replace(' ', '');
    await run(r1, ['configure terminal', 'ipv6 dhcp pool POOL1', `prefix-delegation 2001:db8:bb00::/48 ${duid} iaid 1`, 'end']);
    h1.requestDhcpv6Lease('eth0', false, { prefixDelegation: true });
    expect(h1.getDhcpv6Lease('eth0')?.prefix).toEqual({ prefix: '2001:db8:bb00::', prefixLength: 48 });
  });

  it('prefix-delegation avec un DUID non hexadecimal est refuse', async () => {
    const { r1 } = await lab();
    const out = await run(r1, ['configure terminal', 'ipv6 dhcp pool POOL1', 'prefix-delegation 2001:db8:bb00::/48 zzzz']);
    expect(out).toContain('Invalid input');
  });
});

describe('show ipv6 dhcp', () => {
  it('binding : client, DUID, IA NA, adresse, durees et expiration', async () => {
    const { h1, r1 } = await lab();
    await h1.executeCommand('dhclient -6 eth0');
    const out = await r1.executeCommand('show ipv6 dhcp binding');
    const address = r1._getDHCPv6ServerInternal().getBindings()[0].address.toUpperCase();
    expect(out).toMatch(/^Client: FE80::/m);
    expect(out).toContain('  DUID: 00030001');
    expect(out).toContain('  Username : unassigned');
    expect(out).toMatch(/IA NA: IA ID 0x00000001, T1 900, T2 1440/);
    expect(out).toContain(`Address: ${address}`);
    expect(out).toContain('preferred lifetime 1800, valid lifetime 3600');
    expect(out).toMatch(/expires at .* \(\d+ seconds\)/);
  });

  it('binding IA PD : prefixe delegue', async () => {
    const { h1, r1 } = await lab(['prefix-delegation pool CUSTOMERS']);
    await run(r1, ['configure terminal', 'ipv6 local pool CUSTOMERS 2001:db8:aa00::/40 48', 'end']);
    h1.requestDhcpv6Lease('eth0', false, { prefixDelegation: true });
    const out = await r1.executeCommand('show ipv6 dhcp binding');
    expect(out).toContain('IA PD: IA ID 0x00000001');
    expect(out).toContain('Prefix: 2001:DB8:AA00::/48');
  });

  it('pool : prefixe, durees, DNS, domaine et clients actifs', async () => {
    const { h1, r1 } = await lab();
    await h1.executeCommand('dhclient -6 eth0');
    const out = await r1.executeCommand('show ipv6 dhcp pool');
    expect(out).toContain('DHCPv6 pool: POOL1');
    expect(out).toContain('Address allocation prefix: 2001:DB8:1::/64 valid 3600 preferred 1800 (1 in use, 0 conflicts)');
    expect(out).toContain('DNS server: 2001:4860:4860::8888');
    expect(out).toContain('Domain name: test.lab');
    expect(out).toContain('Active clients: 1');
  });

  it('clear ipv6 dhcp binding : bail efface', async () => {
    const { h1, r1 } = await lab();
    await h1.executeCommand('dhclient -6 eth0');
    await r1.executeCommand('clear ipv6 dhcp binding');
    expect(r1._getDHCPv6ServerInternal().getBindings()).toEqual([]);
  });
});

describe('show running-config', () => {
  it('rend le pool v6, la delegation et le pool local', async () => {
    const { r1 } = await lab(['prefix-delegation pool CUSTOMERS']);
    await run(r1, ['configure terminal', 'ipv6 local pool CUSTOMERS 2001:db8:aa00::/40 48', 'end']);
    const out = await r1.executeCommand('show running-config');
    expect(out).toContain('ipv6 local pool CUSTOMERS 2001:db8:aa00::/40 48');
    expect(out).toContain('ipv6 dhcp pool POOL1');
    expect(out).toContain(' address prefix 2001:db8:1::/64 lifetime 3600 1800');
    expect(out).toContain(' prefix-delegation pool CUSTOMERS');
    expect(out).toContain(' dns-server 2001:4860:4860::8888');
    expect(out).toContain(' domain-name test.lab');
  });
});
