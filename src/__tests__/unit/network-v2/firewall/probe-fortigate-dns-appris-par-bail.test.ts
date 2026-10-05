/*
 * Un FortiGate dont une interface est cliente DHCP interroge aussi les
 * serveurs DNS que le bail lui a appris, tant que `dns-server-override`
 * vaut `enable` ; `disable` les ecarte.
 *
 * Mesure de depart, sur un FortiGate dont port1 est en `mode dhcp` face a un
 * serveur ISC qui annonce `option domain-name-servers` : le bail portait bien
 * le serveur DNS (le client DHCP le range dans `DHCPClientLease`), mais
 * `FirewallDnsClient` ne lisait que `config system dns` — `execute ping
 * web.lab.local` n'atteignait jamais le resolveur du bail — et
 * `dns-server-override` n'existait pas sur `config system interface`.
 *
 * L'AUTORITE — la reference CLI FortiOS 7.6.7 livree dans le depot
 * (`official_docs/forti-cli-ref-767.txt`, `config system interface`) :
 * `dns-server-override`, « Enable/disable use DNS acquired by DHCP or
 * PPPoE », option `enable` par defaut. La reference ne dit pas dans quel
 * ordre le resolveur essaie les serveurs ; les serveurs de `config system
 * dns` passent d'abord, ceux des baux ensuite, et l'ordre est le seul choix
 * ecrit ici sans source.
 *
 * Ecrite a l'aveugle. Le serveur du FAI est a la fois serveur DHCP (ISC) et
 * resolveur autoritaire (`bindDnsUdpServer`). `config system dns` garde le
 * resolveur d'usine, injoignable : seul le bail peut repondre. 3 des 7 cas
 * tombent avant (git stash push -- src/network) : la resolution par le bail,
 * son retour apres un `disable`, et l'attribut affiche sur une interface DHCP.
 * Passent des deux cotes : les deux TEMOINS (le bail porte bien le serveur et
 * l'adresse y est joignable ; un resolveur declare a la main repond quand il
 * est seul) et deux cas STRUCTURELS que l'ancien code satisfaisait faute de
 * lire le bail — `disable` ecarte le serveur du bail, et une interface revenue
 * en `static` ne le consulte plus : ils gardent le retrait contre la
 * correction, pas contre l'etat anterieur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { makeARecord, makeSoaRecord, makeNsRecord } from '@/network/dns/wire/ResourceRecord';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsUdpServer } from '@/network/dns/transport/DnsUdpTransport';

const ISP = '203.0.113.1';
const TARGET = '203.0.113.80';

interface Terminal { executeCommand(command: string): Promise<string> }

async function type(device: Terminal, lines: readonly string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function lab() {
  const isp = new LinuxServer('linux-server', 'ISP', -200, 0);
  const target = new LinuxServer('linux-server', 'TGT', -200, 100);
  isp.powerOn();
  target.powerOn();
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  new Cable('wan').connect(isp.getPort('eth0')!, fgt.getPort('port1')!);
  new Cable('far').connect(target.getPort('eth0')!, fgt.getPort('port2')!);

  const zone = new Zone('lab.local', makeSoaRecord('lab.local', 3600, {
    mname: 'ns1.lab.local', rname: 'hostmaster.lab.local',
    serial: 2026100402, refresh: 7200, retry: 3600, expire: 1209600, minimum: 60,
  }));
  zone.addRecord(makeNsRecord('lab.local', 86400, 'ns1.lab.local'));
  zone.addRecord(makeARecord('ns1.lab.local', 3600, ISP));
  zone.addRecord(makeARecord('web.lab.local', 60, TARGET));
  const store = new ZoneStore();
  store.addZone(zone);
  const authoritative = new AuthoritativeServer(store);
  bindDnsUdpServer(isp, (query) => authoritative.answer(query));
  isp.getPorts()[0].configureIP(new IPAddress(ISP), new SubnetMask('255.255.255.0'));

  await type(isp, [
    `ip addr add ${ISP}/24 dev eth0`, 'ip link set eth0 up',
    `printf 'subnet 203.0.113.0 netmask 255.255.255.0 {\\n  range 203.0.113.50 203.0.113.60;\\n  option routers ${ISP};\\n  option domain-name-servers ${ISP};\\n}\\n' > /etc/dhcp/dhcpd.conf`,
    'systemctl restart isc-dhcp-server',
  ]);
  await type(target, ['ip link set eth0 up', `ip addr add ${TARGET}/24 dev eth0`, 'ip route add default via 203.0.113.1']);
  await type(fgt, [
    'config system interface', 'edit port2', 'set mode static', 'set ip 203.0.113.2 255.255.255.0', 'next', 'end',
  ]);
  return { fgt, isp };
}

const joinWan = (settings: readonly string[] = []): string[] =>
  ['config system interface', 'edit port1', 'set mode dhcp', ...settings, 'next', 'end'];

describe('name resolution on a FortiGate with a DHCP interface', () => {
  it('learns the resolver in its lease — WITNESS', async () => {
    const { fgt } = await lab();
    await type(fgt, joinWan());

    expect(await fgt.executeCommand('execute ping 203.0.113.1')).toContain('5 packets received');
  });

  it('resolves a name through the resolver the lease carried', async () => {
    const { fgt } = await lab();
    await type(fgt, joinWan());
    const out = await fgt.executeCommand('execute ping web.lab.local');

    expect(out).toContain(`PING web.lab.local (${TARGET}): 56 data bytes`);
  });

  it('does not resolve through the lease under dns-server-override disable', async () => {
    const { fgt } = await lab();
    await type(fgt, joinWan(['set dns-server-override disable']));
    const out = await fgt.executeCommand('execute ping web.lab.local');

    expect(out).toBe('ping: cannot resolve web.lab.local: Unknown host');
  });

  it('follows the switch from disable back to enable on a held lease', async () => {
    const { fgt } = await lab();
    await type(fgt, joinWan(['set dns-server-override disable']));
    await type(fgt, joinWan(['set dns-server-override enable']));
    const out = await fgt.executeCommand('execute ping web.lab.local');

    expect(out).toContain(`PING web.lab.local (${TARGET})`);
  });

  it('stops using the lease resolver once the interface leaves DHCP', async () => {
    const { fgt } = await lab();
    await type(fgt, joinWan());
    await type(fgt, ['config system interface', 'edit port1', 'set mode static', 'set ip 203.0.113.9 255.255.255.0', 'next', 'end']);
    await fgt.executeCommand('execute ping 203.0.113.80');
    const out = await fgt.executeCommand('execute ping web.lab.local');

    expect(out).toBe('ping: cannot resolve web.lab.local: Unknown host');
  });

  it('prefers a resolver declared by hand, and still answers when it is the only one — WITNESS', async () => {
    const { fgt } = await lab();
    await type(fgt, ['config system dns', `set primary ${ISP}`, 'end']);
    await type(fgt, ['config system interface', 'edit port1', 'set mode static', 'set ip 203.0.113.9 255.255.255.0', 'next', 'end']);
    const out = await fgt.executeCommand('execute ping web.lab.local');

    expect(out).toContain(`PING web.lab.local (${TARGET})`);
  });

  it('shows the attribute on a DHCP interface and hides it on a static one', async () => {
    const { fgt } = await lab();
    await type(fgt, joinWan());
    const dhcp = await fgt.executeCommand('show full-configuration system interface port1');
    const fixed = await fgt.executeCommand('show full-configuration system interface port2');

    expect(dhcp).toContain('set dns-server-override enable');
    expect(fixed).not.toContain('dns-server-override');
  });
});
