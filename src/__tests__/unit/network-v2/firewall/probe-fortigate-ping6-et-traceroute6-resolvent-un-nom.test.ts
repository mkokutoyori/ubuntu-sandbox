/*
 * `execute ping6` et `execute tracert6` d'un FortiGate acceptent un NOM et le
 * resolvent par le DNS du systeme en demandant un enregistrement AAAA, comme
 * `execute ping` et `execute traceroute` le font en demandant un A.
 *
 * Mesure de depart : `execute ping6 web6.lab.local` ne lisait sa cible que
 * comme une adresse IPv6 et repondait « Unable to send the ICMP packet: No
 * route to destination. » pour un nom ; `execute tracert6` repondait
 * `tracert6: unknown host`. Le client DNS du pare-feu (`FirewallDnsClient`)
 * savait deja demander un AAAA (`resolve(nom, 'ipv6')`), personne ne le lui
 * demandait.
 *
 * L'AUTORITE — la reference CLI FortiOS 7.6.7 livree dans le depot
 * (`official_docs/forti-cli-ref-767.txt`) nomme `execute ping6` « PINGv6
 * command » et `execute tracert6` « Traceroute for IPv6 » sans en donner le
 * parametre, alors qu'elle ecrit `execute traceroute <dest>` « IP address or
 * hostname ». Qu'un NOM soit accepte par les formes v6 est donc la lecon de la
 * parente avec les formes v4 et la memoire de l'aide d'un FortiGate reel, non
 * un texte atteignable d'ici. De meme, `ping6: cannot resolve <nom>: Unknown
 * host` est la phrase de `execute ping` (elle-meme de memoire) transposee ;
 * pour tracert6 la phrase `tracert6: unknown host` existait deja.
 *
 * Ecrite a l'aveugle. Le FortiGate est client DNS en IPv4 (le resolveur est a
 * 192.168.1.53, declare dans `config system dns`) et parle IPv6 sur
 * 2001:db8::/64 vers la cible. 5 des 9 cas tombent avant (git stash push --
 * src/network ; la base porte deja le client DNS refonde sur DnsCache) : les
 * deux formes de ping6 par nom, le nom irresolvable, le nom qui n'a qu'un
 * enregistrement A — ping6 le ramene a « cannot resolve » et non a « no route
 * » — et l'entete de tracert6. TEMOINS, qui passent des deux cotes : la cible
 * en adresse litterale, qui pingue et trace ; `execute ping` d'un nom qui n'a
 * qu'un AAAA, qui ne doit pas se resoudre ; et `tracert6: unknown host`, la
 * phrase d'un nom irresolvable, qui existait deja.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import {
  makeAaaaRecord, makeARecord, makeNsRecord, makeSoaRecord,
} from '@/network/dns/wire/ResourceRecord';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsUdpServer } from '@/network/dns/transport/DnsUdpTransport';

const RESOLVER = '192.168.1.53';
const TARGET6 = '2001:db8::10';
const TARGET4 = '192.168.1.80';

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
  const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 150);
  const dns = new LinuxServer('linux-server', 'DNS', -200, 150);
  const web = new LinuxServer('linux-server', 'WEB', -200, 250);
  for (const device of [dns, web, sw]) device.powerOn();
  new Cable('a').connect(fgt.getPort('port1')!, sw.getPort('eth0')!);
  new Cable('b').connect(dns.getPorts()[0], sw.getPort('eth1')!);
  new Cable('c').connect(web.getPorts()[0], sw.getPort('eth2')!);
  await type(fgt, [
    'config system interface', 'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping',
    'config ipv6', 'set ip6-address 2001:db8::1/64', 'set ip6-allowaccess ping', 'end',
    'next', 'end',
  ]);

  const zone = new Zone('lab.local', makeSoaRecord('lab.local', 3600, {
    mname: 'ns1.lab.local', rname: 'hostmaster.lab.local',
    serial: 2026100501, refresh: 7200, retry: 3600, expire: 1209600, minimum: 60,
  }));
  zone.addRecord(makeNsRecord('lab.local', 86400, 'ns1.lab.local'));
  zone.addRecord(makeARecord('ns1.lab.local', 3600, RESOLVER));
  zone.addRecord(makeARecord('web.lab.local', 60, TARGET4));
  zone.addRecord(makeAaaaRecord('web6.lab.local', 60, TARGET6));
  const store = new ZoneStore();
  store.addZone(zone);
  dns.getPorts()[0].configureIP(new IPAddress(RESOLVER), new SubnetMask('255.255.255.0'));
  const authoritative = new AuthoritativeServer(store);
  bindDnsUdpServer(dns, (query) => authoritative.answer(query));
  await type(dns, ['ip link set eth0 up', `ip addr add ${RESOLVER}/24 dev eth0`]);
  await type(web, [
    'ip link set eth0 up', `ip addr add ${TARGET4}/24 dev eth0`, `ip -6 addr add ${TARGET6}/64 dev eth0`,
  ]);
  await type(fgt, ['config system dns', `set primary ${RESOLVER}`, 'end']);
  await fgt.executeCommand(`execute ping6 ${TARGET6}`);
  return { fgt };
}

describe('execute ping6 with an address — WITNESS', () => {
  it('reaches the host', async () => {
    const { fgt } = await lab();
    const out = await fgt.executeCommand(`execute ping6 ${TARGET6}`);

    expect(out).toContain(`PING ${TARGET6} (${TARGET6}): 56 data bytes`);
    expect(out).toContain('5 packets transmitted, 5 packets received');
  });
});

describe('execute ping6 with a name', () => {
  it('names the host and the resolved address in the header', async () => {
    const { fgt } = await lab();
    const out = await fgt.executeCommand('execute ping6 web6.lab.local');

    expect(out).toContain(`PING web6.lab.local (${TARGET6}): 56 data bytes`);
  });

  it('is answered by the address the name resolves to, and the statistics name the host', async () => {
    const { fgt } = await lab();
    const out = await fgt.executeCommand('execute ping6 web6.lab.local');

    expect(out).toContain(`64 bytes from ${TARGET6}: icmp_seq=0`);
    expect(out).toContain('--- web6.lab.local ping statistics ---');
    expect(out).toContain('5 packets transmitted, 5 packets received');
  });

  it('says so when the name does not resolve, instead of claiming there is no route', async () => {
    const { fgt } = await lab();
    const out = await fgt.executeCommand('execute ping6 nosuchhost.lab.local');

    expect(out).toBe('ping6: cannot resolve nosuchhost.lab.local: Unknown host');
  });

  it('asks for an AAAA: a name that only has an A record does not resolve', async () => {
    const { fgt } = await lab();
    const out = await fgt.executeCommand('execute ping6 web.lab.local');

    expect(out).toBe('ping6: cannot resolve web.lab.local: Unknown host');
  });
});

describe('execute ping with the family the name does not have — WITNESS', () => {
  it('does not resolve a name that only has an AAAA', async () => {
    const { fgt } = await lab();
    const out = await fgt.executeCommand('execute ping web6.lab.local');

    expect(out).toBe('ping: cannot resolve web6.lab.local: Unknown host');
  });
});

describe('execute tracert6', () => {
  it('reaches an address — WITNESS', async () => {
    const { fgt } = await lab();
    const out = await fgt.executeCommand(`execute tracert6 ${TARGET6}`);

    expect(out).toContain(`traceroute to ${TARGET6} (${TARGET6})`);
  });

  it('resolves a name and shows both in the header', async () => {
    const { fgt } = await lab();
    const out = await fgt.executeCommand('execute tracert6 web6.lab.local');

    expect(out).toContain(`traceroute to web6.lab.local (${TARGET6})`);
  });

  it('answers unknown host for a name that does not resolve', async () => {
    const { fgt } = await lab();
    const out = await fgt.executeCommand('execute tracert6 nosuchhost.lab.local');

    expect(out).toBe('tracert6: unknown host');
  });
});
