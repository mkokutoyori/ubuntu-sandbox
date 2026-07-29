/**
 * Probes — LLMNR et mDNS, pour de vrai.
 *
 * `docs/PRD-resolvectl.md` §7 rangeait les deux en « réglage seul » :
 * `LLMNR=` et `MulticastDNS=` étaient stockés et rapportés par `status`,
 * sans qu'aucun paquet ne parte jamais.
 *
 * Le préalable était plus profond qu'annoncé : un hôte ne savait ni
 * émettre ni recevoir un datagramme multicast. `resolveRoute` n'avait
 * aucune route pour 224.0.0.0/4, et `handleIPv4` jetait un paquet de
 * groupe faute d'être « pour nous ». Le scénario 1 tient cette base :
 * sans elle, les deux protocoles n'auraient rien eu pour voyager.
 *
 * Ce qui est vérifié ensuite n'est pas qu'un nom se résout, mais que
 * couper le répondeur change le résultat. Un protocole dont on ne peut
 * pas observer l'absence n'est pas un protocole.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LLMNR_PORT, LLMNR_IPV4_GROUP } from '@/network/llmnr/types';
import { MDNS_PORT, MDNS_IPV4_GROUP } from '@/network/mdns/types';

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

/** alpha, bravo et charlie sur un même commutateur. */
async function lab(): Promise<{ a: LinuxPC; b: LinuxPC; c: LinuxPC }> {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const a = new LinuxPC('linux-pc', 'alpha', 0, 0);
  const b = new LinuxPC('linux-pc', 'bravo', 0, 0);
  const c = new LinuxPC('linux-pc', 'charlie', 0, 0);
  sw.powerOn(); a.powerOn(); b.powerOn(); c.powerOn();
  new Cable('c1').connect(a.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(b.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(c.getPorts()[0], sw.getPorts()[2]);
  a.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), MASK);
  b.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), MASK);
  c.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), MASK);
  for (const pc of [a, b, c]) {
    await pc.executeCommand("sudo sh -c 'printf \"nameserver 127.0.0.53\\n\" > /etc/resolv.conf'");
  }
  await pause(120);
  return { a, b, c };
}

/** L'agent mDNS de l'hôte, pour attendre l'acquisition du nom. */
function mdnsAgent(pc: LinuxPC): { whenReady(): Promise<void> } {
  return (pc as unknown as { getMdnsAgent(): { whenReady(): Promise<void> } }).getMdnsAgent();
}

type McastHost = LinuxPC & {
  udpBind(p: number, l: (d: unknown) => void, n?: string): void;
  sendUdpDatagram(ip: IPAddress, dp: number, sp: number, payload: unknown, n?: number): boolean;
};

describe('Scénario 1 — un hôte sait enfin parler à un groupe', () => {
  it('un datagramme vers un groupe atteint tous les pairs du lien', async () => {
    const { a, b, c } = await lab();
    const recus: string[] = [];
    (b as McastHost).udpBind(9999, () => recus.push('b'), 'probe');
    (c as McastHost).udpBind(9999, () => recus.push('c'), 'probe');

    const envoye = (a as McastHost).sendUdpDatagram(
      new IPAddress(LLMNR_IPV4_GROUP), 9999, 9999, { x: 1 }, 8);
    await pause(120);

    expect(envoye, 'faute de route vers 224.0.0.0/4, rien ne partait').toBe(true);
    expect(recus.sort(), 'un groupe s\'adresse à tout le lien').toEqual(['b', 'c']);
  }, LONG);

  it('un groupe non rejoint n\'est pas remonté', async () => {
    const { a, b } = await lab();
    const recus: string[] = [];
    (b as McastHost).udpBind(9999, () => recus.push('b'), 'probe');

    // 239.1.1.1 n'est pas un groupe réservé : sans adhésion, la carte de
    // b doit l'écarter, sans quoi « rejoindre » ne voudrait rien dire.
    (a as McastHost).sendUdpDatagram(new IPAddress('239.1.1.1'), 9999, 9999, { x: 1 }, 8);
    await pause(120);
    expect(recus).toEqual([]);

    b.joinMulticastGroup('eth0', '239.1.1.1');
    await pause(50);
    (a as McastHost).sendUdpDatagram(new IPAddress('239.1.1.1'), 9999, 9999, { x: 1 }, 8);
    await pause(120);
    expect(recus, 'après adhésion, le même envoi passe').toEqual(['b']);
  }, LONG);
});

describe('Scénario 2 — LLMNR répond pour son nom, et pour lui seul', () => {
  it('alpha résout bravo par le lien', async () => {
    const { a } = await lab();
    const out = await a.executeCommand('resolvectl query bravo');
    expect(out).toContain('10.0.0.2');
    expect(
      out,
      'le protocole employé doit être nommé : c\'est ce qui distingue le lien d\'un serveur',
    ).toContain('protocol LLMNR/IPv4');
  }, LONG);

  it('un nom que personne ne porte reste sans réponse', async () => {
    const { a } = await lab();
    const out = await a.executeCommand('resolvectl query delta; echo rc=$?');
    expect(out).toContain('Name or service not known');
    expect(out).toContain('rc=1');
  }, LONG);

  it('un nom qualifié ne part pas sur le groupe', async () => {
    const { a } = await lab();
    // RFC 4795 §2.1 : LLMNR ne sert que le mono-label. `bravo.example`
    // relève du DNS, et il n'y a pas de serveur ici.
    expect(await a.executeCommand('resolvectl query bravo.example; echo rc=$?'))
      .toContain('rc=1');
  }, LONG);

  it('deux pairs distincts répondent chacun pour eux-mêmes', async () => {
    const { a } = await lab();
    expect(await a.executeCommand('resolvectl query bravo')).toContain('10.0.0.2');
    expect(await a.executeCommand('resolvectl query charlie')).toContain('10.0.0.3');
  }, LONG);

  it('`ss` montre le port 5355 réellement tenu', async () => {
    const { a } = await lab();
    expect(await a.executeCommand('ss -ulnp')).toContain(`0.0.0.0:${LLMNR_PORT}`);
  }, LONG);
});

describe('Scénario 3 — le réglage ouvre et ferme un vrai port', () => {
  it('`llmnr no` ferme le port du répondeur', async () => {
    const { b } = await lab();
    expect(await b.executeCommand('ss -ulnp')).toContain(`0.0.0.0:${LLMNR_PORT}`);

    await b.executeCommand('sudo resolvectl llmnr eth0 no');
    await pause(80);
    expect(
      await b.executeCommand('ss -ulnp'),
      'un réglage qui ne ferme rien serait le défaut que cette série corrige',
    ).not.toContain(`0.0.0.0:${LLMNR_PORT}`);
  }, LONG);

  it('et le pair ne le résout plus', async () => {
    const { a, b } = await lab();
    expect(await a.executeCommand('resolvectl query bravo')).toContain('10.0.0.2');

    await b.executeCommand('sudo resolvectl llmnr eth0 no');
    // Le cache de `a` tient encore la réponse d'avant, et il a raison :
    // sans ce vidage, la question ne repartirait pas sur le lien et le
    // test mesurerait le cache au lieu du répondeur.
    await a.executeCommand('sudo resolvectl flush-caches');
    await pause(80);
    expect(await a.executeCommand('resolvectl query bravo; echo rc=$?')).toContain('rc=1');
  }, LONG);

  it('`llmnr no` côté demandeur coupe aussi ses propres questions', async () => {
    const { a } = await lab();
    await a.executeCommand('sudo resolvectl llmnr eth0 no');
    await pause(80);

    expect(await a.executeCommand('resolvectl query bravo; echo rc=$?')).toContain('rc=1');
  }, LONG);
});

describe('Scénario 4 — mDNS, éteint par défaut comme sur Ubuntu', () => {
  it('`.local` ne résout pas tant que mDNS est éteint', async () => {
    const { a } = await lab();
    expect(await a.executeCommand('resolvectl status eth0')).toContain('MulticastDNS setting: no');
    expect(await a.executeCommand('resolvectl query bravo.local; echo rc=$?')).toContain('rc=1');
  }, LONG);

  it('allumé des deux côtés, `bravo.local` répond', async () => {
    const { a, b } = await lab();
    await a.executeCommand('sudo resolvectl mdns eth0 yes');
    await b.executeCommand('sudo resolvectl mdns eth0 yes');
    // Un répondeur mDNS ne répond qu'une fois son nom sondé et acquis
    // (RFC 6762 §8.1) : attendre une durée fixe mesurerait la patience du
    // test, pas le protocole.
    await mdnsAgent(b).whenReady();

    const out = await a.executeCommand('resolvectl query bravo.local');
    expect(out).toContain('10.0.0.2');
    expect(out).toContain('protocol mDNS/IPv4');
  }, LONG);

  it('le port 5353 suit le réglage', async () => {
    const { b } = await lab();
    expect(await b.executeCommand('ss -ulnp')).not.toContain(`0.0.0.0:${MDNS_PORT}`);

    await b.executeCommand('sudo resolvectl mdns eth0 yes');
    await pause(80);
    expect(await b.executeCommand('ss -ulnp')).toContain(`0.0.0.0:${MDNS_PORT}`);
  }, LONG);

  it('un `.local` que personne ne porte reste sans réponse', async () => {
    const { a, b } = await lab();
    await a.executeCommand('sudo resolvectl mdns eth0 yes');
    await b.executeCommand('sudo resolvectl mdns eth0 yes');
    await mdnsAgent(b).whenReady();

    expect(await a.executeCommand('resolvectl query delta.local; echo rc=$?')).toContain('rc=1');
  }, LONG);

  it('le groupe mDNS n\'est pas celui de LLMNR', async () => {
    expect(MDNS_IPV4_GROUP).toBe('224.0.0.251');
    expect(LLMNR_IPV4_GROUP).toBe('224.0.0.252');
  }, LONG);
});

describe('Scénario 5 — le reste du système en profite', () => {
  it('`getent hosts` résout un nom mono-label par le lien', async () => {
    const { a } = await lab();
    expect(
      await a.executeCommand('getent hosts bravo'),
      'LLMNR doit être atteignable par le chemin NSS, pas seulement par resolvectl',
    ).toContain('10.0.0.2');
  }, LONG);

  it('`ping` par le nom traverse réellement le lien', async () => {
    const { a } = await lab();
    const out = await a.executeCommand('ping -c 1 bravo');
    expect(out).toContain('10.0.0.2');
    expect(out, 'le nom résolu doit désigner une machine joignable').toContain('1 received');
  }, LONG);

  it('`getent` et `resolvectl` s\'accordent sur la même machine', async () => {
    const { a } = await lab();
    const parGetent = await a.executeCommand('getent hosts charlie');
    const parResolvectl = await a.executeCommand('resolvectl query charlie');
    expect(parGetent).toContain('10.0.0.3');
    expect(parResolvectl).toContain('10.0.0.3');
  }, LONG);

  it('une réponse du lien n\'est jamais annoncée comme authentifiée', async () => {
    const { a } = await lab();
    expect(
      await a.executeCommand('resolvectl query bravo'),
      'personne ne signe une réponse LLMNR : le prétendre serait le mensonge que cette série traque',
    ).toContain('Data is authenticated: no');
  }, LONG);
});
