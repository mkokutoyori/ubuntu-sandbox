/**
 * Probes — le conflit de noms, détecté puis tranché.
 *
 * Les deux protocoles répondaient jusqu'ici sans jamais vérifier que le
 * nom leur appartenait. Deux machines portant le même nom sur un lien
 * répondaient toutes les deux, et le demandeur gardait la première
 * arrivée — un tirage au sort déguisé en résolution.
 *
 * Les deux RFC traitent le cas différemment, et c'est le cœur de ce qui
 * est vérifié ici : LLMNR **signale** (bit C), mDNS **renomme** (§9).
 *
 * Ce fichier pose aussi un garde sur une erreur réellement commise :
 * l'en-tête LLMNR redéfinit le bit 10 en `C` (Conflict) là où le DNS
 * place `AA`. Le répondeur posait `aa: true` sur chaque réponse « parce
 * qu'un répondeur LLMNR fait autorité » — il annonçait donc un conflit
 * à chaque fois. Les scénarios 2 et 3 mesurent le bit, pas l'intention.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { EndHost } from '@/network/devices/EndHost';
import { queryMulticastDns } from '@/network/dns/transport/MulticastDnsTransport';
import { buildLegacyQueryMessage, nextDnsTransactionId } from '@/network/dns/compat/DnsWireCompat';
import { LLMNR_BINDING, readLlmnrBits } from '@/network/llmnr/types';
import { nextCandidateName } from '@/network/mdns/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const LONG = 40_000;
const MASK = new SubnetMask('255.255.255.0');
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Pc = LinuxPC & {
  getLlmnrAgent(): {
    nameState(): string; whenReady(): Promise<void>; ownName(): string;
    start(): void; stop(): void;
  };
  getMdnsAgent(): {
    nameState(): string; whenReady(): Promise<void>; ownName(): string;
    start(): void; stop(): void;
  };
};

/** Deux machines sur un lien ; `sameName` leur donne le même nom d'hôte. */
function lab(sameName: boolean): { a: Pc; b: Pc; sw: GenericSwitch } {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const a = new LinuxPC('linux-pc', 'alpha', 0, 0);
  const b = new LinuxPC('linux-pc', sameName ? 'alpha' : 'bravo', 0, 0);
  sw.powerOn(); a.powerOn(); b.powerOn();
  new Cable('c1').connect(a.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(b.getPorts()[0], sw.getPorts()[1]);
  a.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), MASK);
  b.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), MASK);
  return { a: a as Pc, b: b as Pc, sw };
}

/** Interroge le lien en LLMNR et rend la réponse brute, bits compris. */
async function askLlmnr(from: LinuxPC, name: string) {
  const query = buildLegacyQueryMessage(nextDnsTransactionId(), name, 'A', {
    recursionDesired: false,
  });
  const responses = await queryMulticastDns(
    from as unknown as EndHost, LLMNR_BINDING, query!, 1000, { firstOnly: true });
  return responses[0] ?? null;
}

describe('Scénario 1 — LLMNR vérifie que le nom est bien à lui', () => {
  it('deux noms distincts : chacun conclut à l\'unicité', async () => {
    const { a, b } = lab(false);
    await Promise.all([a.getLlmnrAgent().whenReady(), b.getLlmnrAgent().whenReady()]);

    expect(a.getLlmnrAgent().nameState()).toBe('unique');
    expect(b.getLlmnrAgent().nameState()).toBe('unique');
  }, LONG);

  it('deux machines du même nom : les deux constatent le conflit', async () => {
    const { a, b } = lab(true);
    await Promise.all([a.getLlmnrAgent().whenReady(), b.getLlmnrAgent().whenReady()]);

    // LLMNR n'arbitre pas : personne ne gagne le nom, les deux savent
    // seulement qu'il est disputé (RFC 4795 §4).
    expect(a.getLlmnrAgent().nameState()).toBe('conflicted');
    expect(b.getLlmnrAgent().nameState()).toBe('conflicted');
  }, LONG);

  it('un hôte seul sur le lien garde son nom', async () => {
    const { a, b } = lab(true);
    b.getLlmnrAgent().stop();
    a.getLlmnrAgent().start();
    await a.getLlmnrAgent().whenReady();

    expect(
      a.getLlmnrAgent().nameState(),
      'sans personne pour répondre, il n\'y a pas de conflit à trouver',
    ).toBe('unique');
  }, LONG);
});

describe('Scénario 2 — le bit C dit la vérité sur le fil', () => {
  it('un nom non disputé répond avec C à zéro', async () => {
    const { a, b } = lab(false);
    await Promise.all([a.getLlmnrAgent().whenReady(), b.getLlmnrAgent().whenReady()]);

    const reponse = await askLlmnr(a, 'bravo');
    expect(reponse).not.toBeNull();
    const bits = readLlmnrBits(reponse!.flags);
    expect(
      bits.conflict,
      'le bit 10 est C en LLMNR, pas AA : le poser systématiquement annonçait un conflit permanent',
    ).toBe(false);
    expect(bits.tentative).toBe(false);
  }, LONG);

  it('un nom disputé répond avec C à un', async () => {
    const { a, b } = lab(true);
    await Promise.all([a.getLlmnrAgent().whenReady(), b.getLlmnrAgent().whenReady()]);

    const reponse = await askLlmnr(a, 'alpha');
    expect(reponse).not.toBeNull();
    expect(
      readLlmnrBits(reponse!.flags).conflict,
      'c\'est la seule façon dont LLMNR signale un nom disputé',
    ).toBe(true);
  }, LONG);

  it('la réponse reste utilisable malgré le conflit', async () => {
    const { a, b } = lab(true);
    await Promise.all([a.getLlmnrAgent().whenReady(), b.getLlmnrAgent().whenReady()]);

    const reponse = await askLlmnr(a, 'alpha');
    expect(
      reponse!.answers.length,
      'LLMNR signale, il ne se tait pas : le demandeur décide',
    ).toBeGreaterThan(0);
  }, LONG);
});

describe('Scénario 3 — le bit T pendant la vérification', () => {
  it('un répondeur qui vérifie encore répond en tentative', async () => {
    const { a, b } = lab(false);
    // On interroge sans attendre `whenReady` : la vérification de `b` est
    // encore en cours, et c'est précisément ce que le bit T annonce.
    expect(b.getLlmnrAgent().nameState()).toBe('tentative');

    const reponse = await askLlmnr(a, 'bravo');
    expect(reponse).not.toBeNull();
    expect(
      readLlmnrBits(reponse!.flags).tentative,
      'le bit 8 est T en LLMNR : la possession n\'est pas encore établie',
    ).toBe(true);
  }, LONG);

  it('une fois la vérification finie, T retombe', async () => {
    const { a, b } = lab(false);
    await b.getLlmnrAgent().whenReady();

    const reponse = await askLlmnr(a, 'bravo');
    expect(readLlmnrBits(reponse!.flags).tentative).toBe(false);
  }, LONG);
});

describe('Scénario 4 — mDNS sonde puis renomme', () => {
  it('le second arrivé prend `alpha-2.local`', async () => {
    const { a, b } = lab(true);
    a.getMdnsAgent().start();
    await a.getMdnsAgent().whenReady();
    b.getMdnsAgent().start();
    await b.getMdnsAgent().whenReady();

    expect(a.getMdnsAgent().ownName()).toBe('alpha.local');
    expect(
      b.getMdnsAgent().ownName(),
      'mDNS renomme là où LLMNR se contente de signaler',
    ).toBe('alpha-2.local');
    expect(b.getMdnsAgent().nameState()).toBe('claimed');
  }, LONG);

  it('des noms distincts ne déclenchent aucun renommage', async () => {
    const { a, b } = lab(false);
    a.getMdnsAgent().start();
    b.getMdnsAgent().start();
    await Promise.all([a.getMdnsAgent().whenReady(), b.getMdnsAgent().whenReady()]);

    expect(a.getMdnsAgent().ownName()).toBe('alpha.local');
    expect(b.getMdnsAgent().ownName()).toBe('bravo.local');
  }, LONG);

  it('le nom de repli est réellement résoluble sur le lien', async () => {
    const { a, b } = lab(true);
    a.getMdnsAgent().start();
    await a.getMdnsAgent().whenReady();
    b.getMdnsAgent().start();
    await b.getMdnsAgent().whenReady();
    await pause(120);

    await a.executeCommand('sudo resolvectl mdns eth0 yes');
    const out = await a.executeCommand('resolvectl query alpha-2.local');
    expect(
      out,
      'un renommage qui ne serait pas annoncé ne servirait à rien',
    ).toContain('10.0.0.2');
    expect(out).toContain('protocol mDNS/IPv4');
  }, LONG);

  it('la suite de noms candidats suit la convention de la RFC', () => {
    expect(nextCandidateName('alpha.local', 1)).toBe('alpha.local');
    expect(nextCandidateName('alpha.local', 2)).toBe('alpha-2.local');
    expect(nextCandidateName('alpha.local', 3)).toBe('alpha-3.local');
    // Un nom déjà suffixé ne s'empile pas : `alpha-2` → `alpha-3`.
    expect(nextCandidateName('alpha-2.local', 3)).toBe('alpha-3.local');
  });
});

describe('Scénario 5 — deux sondages simultanés se départagent', () => {
  it('l\'un obtient le nom, l\'autre se rabat — jamais les deux', async () => {
    const { a, b } = lab(true);
    a.getMdnsAgent().start();
    b.getMdnsAgent().start();
    await Promise.all([a.getMdnsAgent().whenReady(), b.getMdnsAgent().whenReady()]);

    const noms = [a.getMdnsAgent().ownName(), b.getMdnsAgent().ownName()].sort();
    expect(
      noms,
      'sans départage, les deux revendiqueraient le même nom ou renonceraient ensemble',
    ).toEqual(['alpha-2.local', 'alpha.local']);
    expect(a.getMdnsAgent().nameState()).toBe('claimed');
    expect(b.getMdnsAgent().nameState()).toBe('claimed');
  }, LONG);

  it('un hôte qui sonde encore ne répond pas pour le nom', async () => {
    const { a, b } = lab(false);
    b.getMdnsAgent().start();
    expect(b.getMdnsAgent().nameState()).toBe('probing');

    // Répondre pendant le sondage reviendrait à affirmer une possession
    // qu'on est justement en train de vérifier.
    await a.executeCommand('sudo resolvectl mdns eth0 yes');
    const out = await a.executeCommand('resolvectl query bravo.local; echo rc=$?');
    expect(out).toContain('rc=1');
  }, LONG);
});
