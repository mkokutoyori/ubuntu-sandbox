/**
 * Probes — la résolution de noms sait enfin attendre.
 *
 * `docs/PRD-resolvectl.md` §7.1 assumait une limite : valider (DNSSEC) ou
 * chiffrer (DoT) demande des allers-retours, et `INssSource` était
 * synchrone de bout en bout. À froid, `getent hosts` ne rendait donc
 * rien — silencieusement, ce qui est le pire des deux mondes : le nom
 * était résoluble, le système répondait « inconnu ».
 *
 * Ce que ces probes vérifient n'est pas qu'un appel réussit, mais que
 * les deux chemins — le vieux synchrone et le nouveau asynchrone —
 * s'accordent. Une réponse qui dépendrait du fait qu'on ait interrogé
 * avant ne serait pas une résolution, mais un cache déguisé.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { makeARecord, makeSoaRecord, makeNsRecord } from '@/network/dns/wire/ResourceRecord';
import type { ResourceRecord, DsRecordData } from '@/network/dns/wire/ResourceRecord';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsUdpServer } from '@/network/dns/transport/DnsUdpTransport';
import { generateZoneKey, makeDsForKey } from '@/network/dns/dnssec/DnsKey';
import { signZone } from '@/network/dns/dnssec/DnsSigner';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const LONG = 30_000;
const MASK = new SubnetMask('255.255.255.0');
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Un serveur `dnsmasq` ordinaire, servant `web.lab.local`. */
async function lab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'DNS1');
  pc.powerOn();
  srv.powerOn();
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), MASK);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.9'), MASK);
  new Cable('c1').connect(pc.getPorts()[0], srv.getPorts()[0]);

  const dns = (srv as unknown as {
    dnsService: { addRecord(r: unknown): void; start(): void };
  }).dnsService;
  dns.addRecord({ name: 'web.lab.local', type: 'A', value: '10.0.0.50', ttl: 300 });
  dns.addRecord({ name: 'dns1.lab.local', type: 'A', value: '10.0.0.9', ttl: 300 });
  dns.start();
  await pause(150);

  await pc.executeCommand('sudo resolvectl dns eth0 10.0.0.9');
  await pc.executeCommand('sudo resolvectl domain eth0 lab.local');
  await pc.executeCommand(
    "sudo sh -c 'printf \"nameserver 127.0.0.53\\nsearch lab.local\\n\" > /etc/resolv.conf'");
  return { pc, srv };
}

function soaFor(name: string) {
  return makeSoaRecord(name, 3600, {
    mname: `ns.${name}`, rname: `hostmaster.${name}`,
    serial: 1, refresh: 3600, retry: 600, expire: 604800, minimum: 300,
  });
}

/** Une zone réellement signée, servie sur le câble. */
async function labSigne(): Promise<{
  pc: LinuxPC; anchor: ResourceRecord<DsRecordData>;
}> {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const srv = new LinuxServer('linux-server', 'auth', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  sw.powerOn(); srv.powerOn(); pc.powerOn();
  new Cable('c0').connect(srv.getPorts()[0], sw.getPorts()[0]);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[1]);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.9'), MASK);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), MASK);

  const keys = {
    zsk: generateZoneKey('lab.test', 'zsk', 3600),
    ksk: generateZoneKey('lab.test', 'ksk', 3600),
  };
  const zone = new Zone('lab.test', soaFor('lab.test'));
  zone.addRecord(makeNsRecord('lab.test', 86400, 'ns.lab.test'));
  zone.addRecord(makeARecord('ns.lab.test', 3600, '10.0.0.9'));
  zone.addRecord(makeARecord('web.lab.test', 3600, '198.51.100.7'));
  signZone(zone, keys);

  const store = new ZoneStore();
  store.addZone(zone);
  const auth = new AuthoritativeServer(store);
  bindDnsUdpServer(srv, (q) => auth.answer(q), 53, 'named');
  await pause(150);

  await pc.executeCommand('sudo resolvectl dns eth0 10.0.0.9');
  await pc.executeCommand('sudo resolvectl domain eth0 lab.test');
  await pc.executeCommand(
    "sudo sh -c 'printf \"nameserver 127.0.0.53\\n\" > /etc/resolv.conf'");
  return { pc, anchor: makeDsForKey('lab.test', 3600, keys.ksk) };
}

function trust(pc: LinuxPC, anchor: ResourceRecord<DsRecordData>): void {
  (pc as unknown as {
    setDnssecTrustAnchors(a: readonly ResourceRecord<DsRecordData>[]): void;
  }).setDnssecTrustAnchors([anchor]);
}

describe('Scénario 1 — `getent hosts` à froid sous DNS-over-TLS', () => {
  it('la toute première requête suffit', async () => {
    const { pc } = await lab();
    await pc.executeCommand('sudo resolvectl dnsovertls eth0 yes');

    expect(
      await pc.executeCommand('getent hosts web.lab.local'),
      'aucune requête ne l\'a précédée : rien ne peut venir du cache',
    ).toContain('10.0.0.50');
  }, LONG);

  it('`ahosts` et `ahostsv4` répondent aussi', async () => {
    const { pc } = await lab();
    await pc.executeCommand('sudo resolvectl dnsovertls eth0 yes');

    expect(await pc.executeCommand('getent ahosts web.lab.local')).toContain('STREAM');
    expect(await pc.executeCommand('getent ahostsv4 web.lab.local')).toContain('10.0.0.50');
  }, LONG);

  it('le code de retour distingue trouvé et inconnu', async () => {
    const { pc } = await lab();
    await pc.executeCommand('sudo resolvectl dnsovertls eth0 yes');

    expect(await pc.executeCommand('getent hosts web.lab.local; echo rc=$?')).toContain('rc=0');
    expect(await pc.executeCommand('getent hosts nulle.part; echo rc=$?')).toContain('rc=2');
  }, LONG);

  it('un script en profite aussi', async () => {
    const { pc } = await lab();
    await pc.executeCommand('sudo resolvectl dnsovertls eth0 yes');
    await pc.executeCommand(
      "printf '#!/bin/bash\\ngetent hosts web.lab.local\\n' > /tmp/r.sh; chmod +x /tmp/r.sh");

    expect(await pc.executeCommand('bash /tmp/r.sh')).toContain('10.0.0.50');
  }, LONG);
});

describe('Scénario 2 — `getent hosts` à froid sous DNSSEC', () => {
  it('une zone signée est résolue, ancre posée', async () => {
    const { pc, anchor } = await labSigne();
    trust(pc, anchor);

    expect(
      await pc.executeCommand('getent hosts web.lab.test'),
      'valider demande de remonter la chaîne : il faut pouvoir attendre',
    ).toContain('198.51.100.7');
  }, LONG);

  it('`getent` et `resolvectl query` s\'accordent sur la même machine', async () => {
    const { pc, anchor } = await labSigne();
    trust(pc, anchor);

    const parGetent = await pc.executeCommand('getent hosts web.lab.test');
    const parResolvectl = await pc.executeCommand('resolvectl query web.lab.test');
    expect(parGetent).toContain('198.51.100.7');
    expect(
      parResolvectl,
      'deux chemins vers le même résolveur ne peuvent pas diverger',
    ).toContain('198.51.100.7');
  }, LONG);
});

describe('Scénario 3 — le reste de la résolution suit', () => {
  it('`ping` résout le nom à froid sous DoT', async () => {
    const { pc } = await lab();
    await pc.executeCommand('sudo resolvectl dnsovertls eth0 yes');

    expect(
      await pc.executeCommand('ping -c 1 web.lab.local'),
      'l\'adresse doit apparaître : c\'est la résolution, pas la joignabilité, qui est en cause',
    ).toContain('10.0.0.50');
  }, LONG);

  it('`curl` dépasse la résolution à froid sous DoT', async () => {
    const { pc } = await lab();
    await pc.executeCommand('sudo resolvectl dnsovertls eth0 yes');

    // Rien n'écoute en 80 sur DNS1 : le refus attendu est celui de la
    // connexion, surtout pas « Could not resolve host ».
    expect(await pc.executeCommand('curl http://dns1.lab.local/'))
      .not.toContain('Could not resolve host');
  }, LONG);
});

describe('Scénario 4 — les autres bases restent synchrones et intactes', () => {
  it('passwd, group et services répondent comme avant', async () => {
    const { pc } = await lab();

    expect(await pc.executeCommand('getent passwd root')).toContain('root:x:0:0');
    expect(await pc.executeCommand('getent group root')).toContain('root:x:0');
    expect(await pc.executeCommand('getent services ssh')).toContain('22/tcp');
  }, LONG);

  it('`-s files` court-circuite le réseau', async () => {
    const { pc } = await lab();
    await pc.executeCommand('sudo resolvectl dnsovertls eth0 yes');

    const out = await pc.executeCommand('getent -s files hosts web.lab.local; echo rc=$?');
    expect(out, 'la source `files` ne connaît pas ce nom').toContain('rc=2');
    expect(out).not.toContain('10.0.0.50');
  }, LONG);

  it('l\'énumération et une base inconnue gardent leur comportement', async () => {
    const { pc } = await lab();

    expect(await pc.executeCommand('getent hosts')).toContain('127.0.0.1');
    expect(await pc.executeCommand('getent frobnicate; echo rc=$?')).toContain('rc=1');
  }, LONG);
});

describe('Scénario 5 — le stub distingue enfin les types', () => {
  it('une recherche A+AAAA ne perd plus la moitié qui a abouti', async () => {
    const { pc } = await lab();

    // `hosts` interroge A puis AAAA. La zone n'a pas d'AAAA : le stub
    // rendait SERVFAIL, ce que le résolveur lisait comme un échec global
    // et qui faisait jeter l'adresse A déjà obtenue.
    expect(await pc.executeCommand('getent hosts web.lab.local')).toContain('10.0.0.50');
  }, LONG);

  it('`dig AAAA` ne rend pas l\'adresse IPv4 du nom', async () => {
    const { pc } = await lab();
    await pc.executeCommand('resolvectl query web.lab.local');

    expect(
      await pc.executeCommand('dig @127.0.0.53 web.lab.local AAAA +short'),
      'le stub répondait à tout comme si c\'était une requête A',
    ).not.toContain('10.0.0.50');
    expect(await pc.executeCommand('dig @127.0.0.53 web.lab.local A +short')).toContain('10.0.0.50');
  }, LONG);

  it('`dig` accepte le type avant le nom, comme le vrai', async () => {
    const { pc } = await lab();

    // `dig AAAA web.lab.local` prenait « AAAA » pour le nom cherché et
    // repartait en A : la réponse était celle d'une autre question.
    expect(await pc.executeCommand('dig @127.0.0.53 AAAA web.lab.local +short'))
      .not.toContain('10.0.0.50');
    expect(await pc.executeCommand('dig @127.0.0.53 A web.lab.local +short'))
      .toContain('10.0.0.50');
  }, LONG);
});
