/**
 * NAT64 sur un routeur, avec de vraies trames : un hote IPv6 seul atteint un serveur IPv4 a travers
 * le traducteur a etats (RFC 6146) installe sur le plan de donnees IPv6 et IPv4 du routeur.
 *
 * Mesure avant correction : le plan de donnees IPv6 ne connaissait que le transfert IPv6 vers IPv6 ;
 * un paquet a destination du prefixe de traduction n'avait pas de route (« destination unreachable ») et
 * aucun paquet IPv4 n'etait emis. Le lab : PC IPv6 seul - routeur - serveur IPv4 nginx, prefixe
 * 2001:db8:64::/96 (un prefixe propre au site parce que la plage de documentation 203.0.113.0/24
 * est non globale et que le prefixe bien connu refuse de la representer, RFC 6052 §3.1).
 *
 * Avec src remis avant la correction, 4 cas sur 6 tombent. Deux passent dans les deux etats : le temoin
 * (le serveur repond en IPv4 direct, donc le lab est sain) et « sans traducteur, pas de reponse »,
 * que l'absence de traducteur satisfait aussi ; ce dernier borne le cas qui traduit. La commande qui active la fonction est ici une API du routeur : aucune
 * documentation d'equipementier du NAT64 n'est dans official_docs, la commande reste a ecrire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Nat64Prefix } from '@/network/nat/nat64/Nat64Prefix';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const PREFIX = '2001:db8:64::/96';
const SERVER_V6 = '2001:db8:64::cb00:7105';

async function lab(enable = true) {
  const sw6 = new GenericSwitch('switch-generic', 'sw6', 8, 0, 0);
  const sw4 = new GenericSwitch('switch-generic', 'sw4', 8, 0, 0);
  const r = new CiscoRouter('R-NAT64', 0, 0);
  const pc = new LinuxPC('linux-pc', 'V6ONLY', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV4', 0, 0);
  new Cable('1').connect(pc.getPorts()[0], sw6.getPorts()[0]);
  new Cable('2').connect(sw6.getPorts()[7], r.getPort('GigabitEthernet0/0')!);
  new Cable('3').connect(r.getPort('GigabitEthernet0/1')!, sw4.getPorts()[0]);
  new Cable('4').connect(srv.getPorts()[0], sw4.getPorts()[1]);
  srv.getPorts()[0].configureIP(new IPAddress('203.0.113.5'), new SubnetMask('255.255.255.240'));
  srv.setDefaultGateway(new IPAddress('203.0.113.2'));
  await srv.executeCommand('systemctl start nginx');
  for (const line of ['enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::1/64', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 203.0.113.2 255.255.255.240', 'no shutdown', 'end']) {
    await r.executeCommand(line);
  }
  await pc.executeCommand('ip -6 addr add 2001:db8:1::10/64 dev eth0');
  await pc.executeCommand('ip -6 route add default via 2001:db8:1::1');
  if (enable) r.enableNat64({ prefix: Nat64Prefix.parse(PREFIX), pool: [new IPAddress('203.0.113.8')] });
  return { r, pc, srv };
}

describe('NAT64 on the router data plane', () => {
  it('witness: the IPv4 server answers a direct IPv4 request from its own segment', async () => {
    const { r } = await lab(false);
    expect(await r.executeCommand('ping 203.0.113.5')).toContain('!');
  });

  it('an IPv6-only host fetches a page from an IPv4-only server through the translator', async () => {
    const { pc, r } = await lab();
    const page = await pc.executeCommand(`curl -s -m 5 'http://[${SERVER_V6}]/'`);
    expect(page).toMatch(/nginx/i);
    const bindings = r.getNat64()!.getBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ protocol: 'tcp', v4Address: '203.0.113.8' });
    expect(bindings[0].v6Address).toMatch(/^2001:db8:1:/);
    const session = r.getNat64()!.getSessions()[0];
    expect(session).toMatchObject({ v4Destination: '203.0.113.5', v4DestinationPort: 80, v6DestinationPort: 80 });
  });

  it('the server sees the pool address, never the IPv6 host', async () => {
    const { pc, srv } = await lab();
    await pc.executeCommand(`curl -s -m 5 'http://[${SERVER_V6}]/'`);
    const log = await srv.executeCommand('cat /var/log/nginx/access.log');
    expect(log).toContain('203.0.113.8');
    expect(log).not.toContain('2001:db8:1:');
  });

  it('an IPv6 echo to the embedded address is answered, and the identifier crosses the translator', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand(`ping -6 -c 2 ${SERVER_V6}`)).toContain('2 received');
  });

  it('without the translator the same request gets no answer', async () => {
    const { pc } = await lab(false);
    expect(await pc.executeCommand(`ping -6 -c 1 ${SERVER_V6}`)).toContain('0 received');
  });

  it('answers ARP for the pool address, so the server can reply on its own segment', async () => {
    const { pc, srv } = await lab();
    await pc.executeCommand(`curl -s -m 5 'http://[${SERVER_V6}]/'`);
    expect(await srv.executeCommand('arp -n')).toContain('203.0.113.8');
  });
});
