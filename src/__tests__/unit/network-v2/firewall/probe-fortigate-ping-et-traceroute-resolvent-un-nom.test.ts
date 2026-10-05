/*
 * `execute ping` et `execute traceroute` d'un FortiGate acceptent un NOM et le
 * resolvent par le DNS du systeme, comme ils acceptent une adresse.
 *
 * Mesure de depart : `execute ping web.lab.local` LEVAIT une exception
 * (« Invalid IP address: web.lab.local », issue de la lecture de la cible
 * comme une adresse) au lieu de repondre ; `execute traceroute` de meme. Le
 * client DNS du pare-feu (`FirewallDnsClient`) existait et servait deja aux
 * objets d'adresse FQDN et aux VIP ; les commandes de diagnostic ne le
 * consultaient pas.
 *
 * L'AUTORITE — la reference des commandes FortiOS : `execute ping
 * {<ipv4>|<fqdn>}` et `execute traceroute {<ipv4>|<fqdn>}` ; l'entete d'un
 * ping est `PING <nom> (<adresse>): <n> data bytes`, les reponses nomment
 * l'adresse, les statistiques le nom. Ce qui n'est PAS atteignable d'ici : le
 * texte exact d'un nom irresolvable. La phrase `ping: cannot resolve <nom>:
 * Unknown host` est celle de la memoire d'un FortiGate reel ; elle n'est
 * attestee par aucune source lisible depuis cet environnement, et le
 * commit le dit. Pour traceroute, la phrase `traceroute: unknown host`
 * existait deja dans le code.
 *
 * Ecrite a l'aveugle. Le laboratoire est celui de `fortios-vip-fqdn` : un
 * resolveur autoritaire sur le fil, `config system dns` pour le declarer.
 * 8 des 11 cas tombent avant, mesures avec git stash push -- src/network
 * src/terminal : les sept de la resolution de noms et le moniteur dont le
 * serveur n'a pas de route. Les TEMOINS — la cible en adresse litterale, qui pingue et trace,
 * et le moniteur dont le serveur repond — passent des deux cotes et prouvent
 * que le laboratoire est sain.
 *
 * Trouve en chemin : deux sondes de sante (le moniteur de lien et le moniteur
 * de repartition de charge) lisaient `begin(adresse)?.step(1) !== null`. Une
 * cible sans route donnait `undefined !== null`, donc VRAIE : un serveur que
 * rien n'atteint etait declare vivant. Les deux passent maintenant par
 * `Firewall.answersEcho`, qui lit le refus.
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
import { makeARecord, makeSoaRecord, makeNsRecord } from '@/network/dns/wire/ResourceRecord';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsUdpServer } from '@/network/dns/transport/DnsUdpTransport';

const RESOLVER = '192.168.1.53';
const WEB = '192.168.1.80';

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

async function lab(declareResolver = true) {
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
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
  ]);

  const zone = new Zone('lab.local', makeSoaRecord('lab.local', 3600, {
    mname: 'ns1.lab.local', rname: 'hostmaster.lab.local',
    serial: 2026100401, refresh: 7200, retry: 3600, expire: 1209600, minimum: 60,
  }));
  zone.addRecord(makeNsRecord('lab.local', 86400, 'ns1.lab.local'));
  zone.addRecord(makeARecord('ns1.lab.local', 3600, RESOLVER));
  zone.addRecord(makeARecord('web.lab.local', 60, WEB));
  const store = new ZoneStore();
  store.addZone(zone);
  dns.getPorts()[0].configureIP(new IPAddress(RESOLVER), new SubnetMask('255.255.255.0'));
  const authoritative = new AuthoritativeServer(store);
  bindDnsUdpServer(dns, (query) => authoritative.answer(query));
  await type(dns, ['ip link set eth0 up', `ip addr add ${RESOLVER}/24 dev eth0`, 'ip route add default via 192.168.1.1']);
  await type(web, ['ip link set eth0 up', `ip addr add ${WEB}/24 dev eth0`, 'ip route add default via 192.168.1.1']);
  if (declareResolver) await type(fgt, ['config system dns', `set primary ${RESOLVER}`, 'end']);
  return { fgt };
}

describe('execute ping with an address — WITNESS', () => {
  it('reaches the web server', async () => {
    const { fgt } = await lab();
    const out = await fgt.executeCommand(`execute ping ${WEB}`);

    expect(out).toContain(`PING ${WEB} (${WEB}): 56 data bytes`);
    expect(out).toContain(`bytes from ${WEB}: icmp_seq=0`);
    expect(out).toContain('5 packets transmitted, 5 packets received, 0% packet loss');
  });
});

describe('execute ping with a name', () => {
  it('does not throw', async () => {
    const { fgt } = await lab();

    await expect(fgt.executeCommand('execute ping web.lab.local')).resolves.toBeTypeOf('string');
  });

  it('names the host and the resolved address in the header', async () => {
    const { fgt } = await lab();
    const out = await fgt.executeCommand('execute ping web.lab.local');

    expect(out).toContain(`PING web.lab.local (${WEB}): 56 data bytes`);
  });

  it('is answered by the address the name resolves to', async () => {
    const { fgt } = await lab();
    const out = await fgt.executeCommand('execute ping web.lab.local');

    expect(out).toContain(`64 bytes from ${WEB}: icmp_seq=0`);
    expect(out).toContain('--- web.lab.local ping statistics ---');
    expect(out).toContain('5 packets transmitted, 5 packets received, 0% packet loss');
  });

  it('says so when the name does not resolve, instead of claiming there is no route', async () => {
    const { fgt } = await lab();
    const out = await fgt.executeCommand('execute ping nosuchhost.lab.local');

    expect(out).toBe('ping: cannot resolve nosuchhost.lab.local: Unknown host');
  });

  it('cannot resolve at all without a declared resolver reaching the name', async () => {
    const { fgt } = await lab(false);
    const out = await fgt.executeCommand('execute ping web.lab.local');

    expect(out).toBe('ping: cannot resolve web.lab.local: Unknown host');
  });
});

describe('execute traceroute', () => {
  it('reaches an address — WITNESS', async () => {
    const { fgt } = await lab();
    const out = await fgt.executeCommand(`execute traceroute ${WEB}`);

    expect(out).toContain(`traceroute to ${WEB} (${WEB})`);
  });

  it('resolves a name and shows both in the header', async () => {
    const { fgt } = await lab();
    const out = await fgt.executeCommand('execute traceroute web.lab.local');

    expect(out).toContain(`traceroute to web.lab.local (${WEB})`);
  });

  it('answers unknown host for a name that does not resolve', async () => {
    const { fgt } = await lab();
    const out = await fgt.executeCommand('execute traceroute nosuchhost.lab.local');

    expect(out).toBe('traceroute: unknown host');
  });
});

describe('a link monitor whose server has no route', () => {
  const monitor = (server: string): string[] => [
    'config system link-monitor', 'edit "M"', 'set srcintf "port1"', `set server "${server}"`,
    'set protocol ping', 'set failtime 1', 'next', 'end',
  ];

  it('reads alive for a server that answers — WITNESS', async () => {
    const { fgt } = await lab();
    await type(fgt, monitor(WEB));
    const status = await fgt.executeCommand('diagnose sys link-monitor status');

    expect(status).toMatch(/state: alive/);
  });

  it('reads dead for a server nothing routes to', async () => {
    const { fgt } = await lab();
    await type(fgt, monitor('10.99.99.99'));
    const status = await fgt.executeCommand('diagnose sys link-monitor status');

    expect(status).toMatch(/state: dead/);
    expect(status).not.toMatch(/state: alive/);
  });
});
