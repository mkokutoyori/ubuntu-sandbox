/**
 * `config system dns` : `set cache-notfound-responses enable|disable` (defaut disable) et `set dns-cache-ttl <60-86400>` (defaut 1800) -- FortiOS CLI Reference 7.4.12.
 * Le client DNS du pare-feu s'appuie sur le DnsCache du depot (limites de TTL positif et negatif deja prevues) : `dns-cache-ttl` plafonne la duree de
 * conservation des reponses, et sans `cache-notfound-responses` un « nom inconnu » n'est pas retenu -- un nom ajoute ensuite a la zone se resout aussitot,
 * alors qu'avec l'option la reponse negative persiste jusqu'a l'expiration.
 * Mesure de depart : attributs inconnus et cache negatif toujours actif ; 2 des 4 cas tombent avant (le plafond, le nom ajoute apres un echec) ; 2 passent des deux cotes : le temoin (une reponse positive est conservee) et « enable », car le cache negatif etait deja toujours actif.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { makeARecord, makeSoaRecord, makeNsRecord } from '@/network/dns/wire/ResourceRecord';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsUdpServer } from '@/network/dns/transport/DnsUdpTransport';

const RESOLVEUR = '192.168.1.53';
const SERVEUR_WEB = '192.168.1.80';
const AUTRE_WEB = '192.168.1.81';
const EXTERNE = '203.0.113.50';
const CLIENT = '203.0.113.10';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function zoneLab(): { store: ZoneStore; zone: Zone } {
  const zone = new Zone('lab.local', makeSoaRecord('lab.local', 3600, {
    mname: 'ns1.lab.local', rname: 'hostmaster.lab.local',
    serial: 2026082001, refresh: 7200, retry: 3600, expire: 1209600, minimum: 60,
  }));
  zone.addRecord(makeNsRecord('lab.local', 86400, 'ns1.lab.local'));
  zone.addRecord(makeARecord('ns1.lab.local', 3600, RESOLVEUR));
  zone.addRecord(makeARecord('web.lab.local', 60, SERVEUR_WEB));
  zone.addRecord(makeARecord('long.lab.local', 3600, SERVEUR_WEB));

  const store = new ZoneStore();
  store.addZone(zone);
  return { store, zone };
}

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell();
  const commutateur = new GenericSwitch('switch-generic', 'SW', 8, 0, 150);
  const dns = new LinuxServer('linux-server', 'DNS', -200, 150);
  const web = new LinuxServer('linux-server', 'WEB', -200, 250);
  const autre = new LinuxServer('linux-server', 'WEB2', -200, 350);
  const client = new LinuxPC('linux-pc', 'PC', 200, 0);
  for (const d of [dns, web, autre, client, commutateur]) d.powerOn();

  new Cable('a').connect(fw.getPort('port1')!, commutateur.getPort('eth0')!);
  new Cable('b').connect(dns.getPorts()[0], commutateur.getPort('eth1')!);
  new Cable('c').connect(web.getPorts()[0], commutateur.getPort('eth2')!);
  new Cable('e').connect(autre.getPorts()[0], commutateur.getPort('eth3')!);
  new Cable('d').connect(client.getPorts()[0], fw.getPort('port2')!);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');

  const mask = new SubnetMask('255.255.255.0');
  dns.getPorts()[0].configureIP(new IPAddress(RESOLVEUR), mask);

  const { store, zone } = zoneLab();
  const serveurDns = new AuthoritativeServer(store);
  bindDnsUdpServer(dns, (query) => serveurDns.answer(query));

  await runOn(dns, ['ip link set eth0 up', `ip addr add ${RESOLVEUR}/24 dev eth0`,
    'ip route add default via 192.168.1.1']);
  await runOn(web, ['ip link set eth0 up', `ip addr add ${SERVEUR_WEB}/24 dev eth0`,
    'ip route add default via 192.168.1.1', 'systemctl start nginx']);
  await runOn(autre, ['ip link set eth0 up', `ip addr add ${AUTRE_WEB}/24 dev eth0`,
    'ip route add default via 192.168.1.1', 'systemctl start nginx']);
  await runOn(client, ['ip link set eth0 up', `ip addr add ${CLIENT}/24 dev eth0`,
    'ip route add default via 203.0.113.1']);

  return { fw, sh, client, zone };
}


beforeEach(() => { Logger.reset(); });

const dns = (sh: FortiShell, ...extra: string[]) => run(sh, 'config system dns', `set primary ${RESOLVEUR}`, ...extra, 'end');

describe('system dns : cache-notfound-responses et dns-cache-ttl', () => {
  it('temoin : une reponse positive est conservee', async () => {
    const { fw, sh } = await laboratoire();
    dns(sh);
    expect(fw.getDnsClient().resolve('long.lab.local')).toContain(SERVEUR_WEB);
    expect(fw.getDnsClient().entries().find((entry) => entry.fqdn === 'long.lab.local')?.ttl).toBeGreaterThan(0);
  });

  it('dns-cache-ttl plafonne la duree de conservation', async () => {
    const { fw, sh } = await laboratoire();
    dns(sh, 'set dns-cache-ttl 120');
    fw.getDnsClient().resolve('long.lab.local');
    expect(fw.getDnsClient().entries().find((entry) => entry.fqdn === 'long.lab.local')?.ttl).toBeLessThanOrEqual(120);
  });

  it('sans cache-notfound-responses un nom ajoute apres un echec se resout aussitot', async () => {
    const { fw, sh, zone } = await laboratoire();
    dns(sh);
    expect(fw.getDnsClient().resolve('ghost.lab.local')).toEqual([]);
    zone.addRecord(makeARecord('ghost.lab.local', 60, SERVEUR_WEB));
    expect(fw.getDnsClient().resolve('ghost.lab.local')).toContain(SERVEUR_WEB);
  });

  it('avec cache-notfound-responses enable la reponse negative persiste', async () => {
    const { fw, sh, zone } = await laboratoire();
    dns(sh, 'set cache-notfound-responses enable');
    expect(fw.getDnsClient().resolve('ghost.lab.local')).toEqual([]);
    zone.addRecord(makeARecord('ghost.lab.local', 60, SERVEUR_WEB));
    expect(fw.getDnsClient().resolve('ghost.lab.local')).toEqual([]);
  });
});
