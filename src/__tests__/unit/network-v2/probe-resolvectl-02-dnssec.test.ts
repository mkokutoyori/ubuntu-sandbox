/**
 * Probes — DNSSEC sur le chemin du stub.
 *
 * `docs/PRD-resolvectl.md` §7 disait que le validateur existait sans être
 * branché : le réglage `DNSSEC=` était accepté et rapporté, sans effet sur
 * la résolution. Un réglage qui ne fait rien est le défaut que toute cette
 * série corrige — il est ici corrigé.
 *
 * La zone est réellement signée et servie sur le câble par un serveur
 * autoritatif ; la validation remonte la chaîne par de vraies requêtes
 * DNSKEY. Les trois verdicts sont atteints pour de bon : `secure` sur une
 * zone signée intacte, `bogus` sur un enregistrement falsifié après
 * signature, `insecure` sur une zone non signée.
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
import { RRType } from '@/network/dns/wire/RRType';
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

function soaFor(name: string) {
  return makeSoaRecord(name, 3600, {
    mname: `ns.${name || 'root'}`, rname: `hostmaster.${name || 'root'}`,
    serial: 1, refresh: 3600, retry: 600, expire: 604800, minimum: 300,
  });
}

interface Lab {
  pc: LinuxPC;
  /** L'ancre de confiance à poser sur le client. */
  anchor: ResourceRecord<DsRecordData>;
}

/**
 * Un serveur autoritatif sert `lab.test` signée ; le client lui parle
 * directement. `tamper` altère l'adresse APRÈS signature, ce qui est
 * exactement ce que DNSSEC doit détecter.
 * `unsigned` sert la même zone sans aucune signature.
 */
async function lab(options: { tamper?: boolean; unsigned?: boolean } = {}): Promise<Lab> {
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
  if (!options.unsigned) signZone(zone, keys);

  if (options.tamper) {
    // Signature valide, donnée modifiée : le RRSIG ne colle plus.
    // L'écriture force le champ en lecture seule : c'est exactement ce
    // que fait un attaquant sur le fil, pas une API légitime.
    const rrset = zone.getRRSet('web.lab.test', RRType.A)!;
    (rrset[0].data as { address: IPAddress }).address = new IPAddress('203.0.113.66');
  }

  const store = new ZoneStore();
  store.addZone(zone);
  const auth = new AuthoritativeServer(store);
  bindDnsUdpServer(srv, (q) => auth.answer(q), 53, 'named');
  await pause(150);

  await pc.executeCommand('sudo resolvectl dns eth0 10.0.0.9');
  await pc.executeCommand('sudo resolvectl domain eth0 lab.test');
  return { pc, anchor: makeDsForKey('lab.test', 3600, keys.ksk) };
}

/** Pose l'ancre de confiance sur l'hôte, comme le ferait un opérateur. */
function trust(pc: LinuxPC, anchor: ResourceRecord<DsRecordData>): void {
  (pc as unknown as {
    setDnssecTrustAnchors(a: readonly ResourceRecord<DsRecordData>[]): void;
  }).setDnssecTrustAnchors([anchor]);
}

describe('Scénario 1 — une réponse signée est authentifiée', () => {
  it('`resolvectl query` annonce la donnée comme authentifiée', async () => {
    const { pc, anchor } = await lab();
    trust(pc, anchor);

    const out = await pc.executeCommand('resolvectl query web.lab.test');
    expect(out).toContain('198.51.100.7');
    expect(
      out,
      'le verdict vient d\'une vraie remontée de chaîne, pas d\'un drapeau posé à la main',
    ).toContain('Data is authenticated: yes');
  }, LONG);

  it('sans ancre de confiance, la même réponse n\'est pas authentifiée', async () => {
    const { pc } = await lab();

    const out = await pc.executeCommand('resolvectl query web.lab.test');
    expect(out, 'la réponse reste utilisable').toContain('198.51.100.7');
    expect(
      out,
      'aucune ancre : rien ne permet d\'affirmer que la chaîne est valide',
    ).toContain('Data is authenticated: no');
  }, LONG);

  it('les statistiques comptent les réponses validées', async () => {
    const { pc, anchor } = await lab();
    trust(pc, anchor);
    await pc.executeCommand('resolvectl query web.lab.test');

    const stats = await pc.executeCommand('resolvectl statistics');
    expect(stats).toMatch(/Secure:\s+1/);
    expect(stats).toContain('DNSSEC supported by current servers: yes');
  }, LONG);
});

describe('Scénario 2 — une réponse falsifiée est refusée', () => {
  it('un enregistrement modifié après signature est écarté', async () => {
    const { pc, anchor } = await lab({ tamper: true });
    trust(pc, anchor);

    const out = await pc.executeCommand('resolvectl query web.lab.test');
    expect(out).toContain('DNSSEC validation failed');
    expect(
      out,
      'l\'adresse falsifiée ne doit jamais être rendue',
    ).not.toContain('203.0.113.66');
  }, LONG);

  it('le refus se distingue d\'un nom inconnu', async () => {
    const { pc, anchor } = await lab({ tamper: true });
    trust(pc, anchor);

    const out = await pc.executeCommand('resolvectl query web.lab.test');
    expect(
      out,
      'il y avait une réponse : dire « nom inconnu » masquerait l\'attaque',
    ).not.toContain('Name or service not known');
  }, LONG);

  it('le refus vaut même en `allow-downgrade`, qui est le défaut', async () => {
    const { pc, anchor } = await lab({ tamper: true });
    trust(pc, anchor);
    await pc.executeCommand('sudo resolvectl dnssec eth0 allow-downgrade');

    expect(
      await pc.executeCommand('resolvectl query web.lab.test'),
      'allow-downgrade tolère le non signé, jamais le falsifié',
    ).toContain('DNSSEC validation failed');
  }, LONG);

  it('le stub refuse aussi sur le fil, pas seulement dans la commande', async () => {
    const { pc, anchor } = await lab({ tamper: true });
    trust(pc, anchor);

    expect(
      await pc.executeCommand('dig @127.0.0.53 +short web.lab.test'),
      'la validation est dans le résolveur, pas dans l\'affichage',
    ).not.toContain('203.0.113.66');
  }, LONG);
});

describe('Scénario 3 — une zone non signée, selon le mode', () => {
  it('`allow-downgrade` l\'accepte et le dit non authentifié', async () => {
    const { pc, anchor } = await lab({ unsigned: true });
    trust(pc, anchor);

    const out = await pc.executeCommand('resolvectl query web.lab.test');
    expect(out).toContain('198.51.100.7');
    expect(out).toContain('Data is authenticated: no');
  }, LONG);

  it('`DNSSEC=yes` la refuse, puisqu\'aucune signature ne la couvre', async () => {
    const { pc, anchor } = await lab({ unsigned: true });
    trust(pc, anchor);
    await pc.executeCommand('sudo resolvectl dnssec eth0 yes');

    expect(await pc.executeCommand('resolvectl query web.lab.test'))
      .toContain('no signed data and DNSSEC=yes');
  }, LONG);

  it('`DNSSEC=no` n\'essaie même pas de valider', async () => {
    const { pc, anchor } = await lab({ unsigned: true });
    trust(pc, anchor);
    await pc.executeCommand('sudo resolvectl dnssec eth0 no');

    const out = await pc.executeCommand('resolvectl query web.lab.test');
    expect(out).toContain('198.51.100.7');
    expect(out).toContain('Data is authenticated: no');
  }, LONG);

  it('le mode du lien l\'emporte sur le global', async () => {
    const { pc, anchor } = await lab({ unsigned: true });
    trust(pc, anchor);
    await pc.executeCommand('sudo resolvectl dnssec eth0 yes');

    expect(await pc.executeCommand('resolvectl status eth0')).toContain('DNSSEC setting: yes');
    expect(await pc.executeCommand('resolvectl query web.lab.test'))
      .toContain('no signed data');
  }, LONG);
});
