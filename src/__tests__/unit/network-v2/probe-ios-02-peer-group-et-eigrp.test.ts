/**
 * Sondes — groupe de pairs BGP, EIGRP classique, storm-control.
 *
 * Priorité 8 de `docs/audit/11-transcripts-debug-2026-08.md`.
 *
 * **Le groupe de pairs était le défaut le plus trompeur du lot**, et la
 * mesure l'a montré pire que ce que l'audit décrivait. L'audit notait que
 * `neighbor IBGP peer-group` était accepté puis `neighbor IBGP remote-as`
 * refusé — accepter la première moitié d'une construction. Mesuré sur un
 * `CiscoRouter` neuf, il y avait une seconde conséquence, invisible dans
 * les transcripts : le NOM DU GROUPE était enregistré comme un voisin
 * dans le moteur BGP, si bien que `show ip bgp summary` affichait
 *
 *     IBGP            4 0          0        0       0    0    0 never    Idle
 *
 * un pair qui n'existe pas, avec un AS 0 qui n'existe pas non plus. Un
 * groupe de pairs est un MODÈLE : il n'a pas de session, ne s'établit
 * pas, et n'a rien à faire dans cette table.
 *
 * Le modèle est donc séparé (`BgpPeerGroup`, tenu à part des voisins pour
 * qu'on ne puisse pas les confondre), et `applyBgpPeerGroup` recopie les
 * réglages sur les membres. La recopie tourne après CHAQUE modification
 * du gabarit parce que sur un vrai IOS l'ordre ne compte pas : régler
 * `remote-as` sur le groupe après que les membres l'ont rejoint doit les
 * atteindre quand même. Un réglage posé explicitement sur le voisin n'est
 * jamais écrasé — le gabarit fournit un défaut, il ne confisque pas.
 *
 * Côté EIGRP, les compteurs de `show ip eigrp traffic` sont **réels** :
 * ajoutés aux points d'émission et de réception du moteur. Query, Reply
 * et SIA restent structurellement à zéro et c'est un FAIT, pas un trou —
 * ce moteur n'a pas d'état Active et n'en émet jamais (`CLAUDE.md`).
 *
 * **Restent délibérément refusés** : les sous-commandes du mode nommé
 * (`hello-interval`, `hold-time`, `authentication mode`). Elles règlent
 * des minuteries que le moteur n'a pas — il est explicitement sans
 * timers, « une passe de convergence EST l'intervalle de hello ». Les
 * accepter donnerait une valeur que rien ne lirait.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

async function routeurBgp(asn = 65000): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand(`router bgp ${asn}`);
  return r;
}

describe('Scénario 1 — un groupe de pairs est un modèle, pas un pair', () => {
  it('le déclarer ne crée aucun voisin', async () => {
    const r = await routeurBgp();
    expect(await r.executeCommand('neighbor IBGP peer-group')).toBe('');
    const sum = await r.executeCommand('do show ip bgp summary');
    expect(sum).not.toContain('IBGP');
  });

  it('le régler est accepté — c\'était la moitié refusée', async () => {
    const r = await routeurBgp();
    await r.executeCommand('neighbor IBGP peer-group');
    expect(await r.executeCommand('neighbor IBGP remote-as 65000')).toBe('');
    expect(await r.executeCommand('neighbor IBGP update-source Loopback0')).toBe('');
    expect(await r.executeCommand('neighbor IBGP description Interne')).toBe('');
  });

  it('un membre hérite du gabarit', async () => {
    const r = await routeurBgp();
    await r.executeCommand('neighbor IBGP peer-group');
    await r.executeCommand('neighbor IBGP remote-as 65000');
    await r.executeCommand('neighbor 10.0.0.2 peer-group IBGP');
    const sum = await r.executeCommand('do show ip bgp summary');
    expect(sum).toContain('10.0.0.2');
    expect(sum).toMatch(/10\.0\.0\.2\s+4 65000/);
  });

  it('l\'ordre ne compte pas : régler le gabarit APRÈS l\'adhésion marche', async () => {
    const r = await routeurBgp();
    await r.executeCommand('neighbor IBGP peer-group');
    await r.executeCommand('neighbor 10.0.0.3 peer-group IBGP');
    await r.executeCommand('neighbor IBGP remote-as 65000');
    expect(await r.executeCommand('do show ip bgp summary')).toMatch(/10\.0\.0\.3\s+4 65000/);
  });

  it('le gabarit ne confisque pas un réglage explicite du voisin', async () => {
    const r = await routeurBgp();
    await r.executeCommand('neighbor IBGP peer-group');
    await r.executeCommand('neighbor 10.0.0.4 remote-as 65100');
    await r.executeCommand('neighbor 10.0.0.4 peer-group IBGP');
    await r.executeCommand('neighbor IBGP remote-as 65000');
    expect(await r.executeCommand('do show ip bgp summary')).toMatch(/10\.0\.0\.4\s+4 65100/);
  });

  it('le groupe n\'apparaît JAMAIS dans le résumé, même réglé', async () => {
    const r = await routeurBgp();
    await r.executeCommand('neighbor IBGP peer-group');
    await r.executeCommand('neighbor IBGP remote-as 65000');
    await r.executeCommand('neighbor 10.0.0.2 peer-group IBGP');
    const sum = await r.executeCommand('do show ip bgp summary');
    expect(sum.split('\n').some((l) => l.startsWith('IBGP'))).toBe(false);
  });

  it('rejoindre un groupe non déclaré est refusé', async () => {
    const r = await routeurBgp();
    expect(await r.executeCommand('neighbor 10.0.0.5 peer-group NEXISTEPAS'))
      .toContain('Configure the peer-group');
  });

  it('un nom qui n\'est ni une IP ni un groupe reste refusé', async () => {
    const r = await routeurBgp();
    expect(await r.executeCommand('neighbor PASUNGROUPE remote-as 65000'))
      .toContain('Invalid input');
  });
});

describe('Scénario 2 — `no bgp default ipv4-unicast`', () => {
  it('est accepté et vraiment mémorisé', async () => {
    const r = await routeurBgp();
    expect(await r.executeCommand('no bgp default ipv4-unicast')).toBe('');
    expect(await r.executeCommand('bgp default ipv4-unicast')).toBe('');
  });
});

describe('Scénario 3 — EIGRP classique : les commandes qui manquaient', () => {
  async function routeurEigrp(): Promise<CiscoRouter> {
    const r = new CiscoRouter('R2');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('router eigrp 100');
    await r.executeCommand('network 10.0.0.0 0.0.0.255');
    return r;
  }

  it('`metric maximum-hops` est accepté et validé', async () => {
    const r = await routeurEigrp();
    expect(await r.executeCommand('metric maximum-hops 50')).toBe('');
    expect(await r.executeCommand('metric maximum-hops 300')).toContain('Invalid input');
    expect(await r.executeCommand('metric maximum-hops abc')).toContain('Invalid input');
  });

  it('`show ip eigrp traffic` rend des compteurs, pas un refus', async () => {
    const r = await routeurEigrp();
    const out = await r.executeCommand('do show ip eigrp traffic');
    expect(out).toContain('IP-EIGRP Traffic Statistics for AS 100');
    expect(out).toContain('Hellos sent/received:');
    // Zéro parce que ce moteur n'a pas d'état Active — un fait, pas un trou.
    expect(out).toContain('Queries sent/received: 0/0');
  });

  it('`show ip eigrp accounting` répond', async () => {
    const r = await routeurEigrp();
    expect(await r.executeCommand('do show ip eigrp accounting'))
      .toContain('EIGRP-IPv4 Accounting for AS(100)');
  });

  it('`clear ip eigrp neighbors` est accepté', async () => {
    const r = await routeurEigrp();
    await r.executeCommand('exit');
    await r.executeCommand('exit');
    expect(await r.executeCommand('clear ip eigrp neighbors')).toBe('');
  });

  it('le maximum-hops réglé remonte dans `show eigrp protocols`', async () => {
    const r = await routeurEigrp();
    await r.executeCommand('metric maximum-hops 50');
    const out = await r.executeCommand('do show eigrp protocols');
    expect(out).toContain('EIGRP-IPv4 Protocol for AS(100)');
    expect(out).toContain('Maximum hopcount 50');
  });

  it('les vues du mode nommé lisent le MÊME moteur que les classiques', async () => {
    const r = await routeurEigrp();
    const nomme = await r.executeCommand('do show eigrp address-family ipv4 neighbors');
    const classique = await r.executeCommand('do show ip eigrp neighbors');
    // Un routeur ne tient pas deux EIGRP selon la syntaxe employée : les
    // deux vues doivent parler du même AS.
    expect(nomme).toContain('AS(100)');
    expect(classique).toBeTruthy();
  });

  it('les minuteries du mode nommé restent refusées, faute de moteur', async () => {
    const r = await routeurEigrp();
    await r.executeCommand('exit');
    await r.executeCommand('router eigrp CORPO');
    await r.executeCommand('address-family ipv4 unicast autonomous-system 100');
    await r.executeCommand('af-interface GigabitEthernet0/0');
    // Ce moteur est sans minuteries (« une passe de convergence EST
    // l'intervalle de hello ») : accepter donnerait une valeur que rien
    // ne lirait.
    expect(await r.executeCommand('hello-interval 5')).toContain('Invalid input');
    expect(await r.executeCommand('hold-time 15')).toContain('Invalid input');
  });
});

describe('Scénario 4 — OSPF `log-adjacency-changes detail`', () => {
  it('le suffixe `detail` est accepté', async () => {
    const r = new CiscoRouter('R3');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('router ospf 1');
    expect(await r.executeCommand('log-adjacency-changes')).toBe('');
    expect(await r.executeCommand('log-adjacency-changes detail')).toBe('');
  });

  it('un suffixe inconnu reste refusé', async () => {
    const r = new CiscoRouter('R4');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('router ospf 1');
    expect(await r.executeCommand('log-adjacency-changes zzz')).toContain('Invalid input');
  });
});

describe('Scénario 5 — `show storm-control` lit la config réelle', () => {
  async function switchAvecStorm(): Promise<CiscoSwitch> {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 26, 0, 0);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('storm-control broadcast level 20');
    await sw.executeCommand('exit');
    await sw.executeCommand('exit');
    return sw;
  }

  it('le seuil configuré est celui affiché', async () => {
    const sw = await switchAvecStorm();
    const out = await sw.executeCommand('show storm-control');
    expect(out).toContain('Interface  Filter State');
    expect(out).toContain('Fa0/1');
    // Deux décimales, la forme du vrai IOS.
    expect(out).toContain('20.00%');
  });

  it('sans configuration, seul l\'en-tête sort — rien n\'est inventé', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW2', 26, 0, 0);
    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show storm-control');
    expect(out).toBe('Interface  Filter State   Upper        Lower        Current');
  });

  it('le filtre par type ne montre que ce type', async () => {
    const sw = await switchAvecStorm();
    expect(await sw.executeCommand('show storm-control broadcast')).toContain('Fa0/1');
    expect(await sw.executeCommand('show storm-control multicast'))
      .toBe('Interface  Filter State   Upper        Lower        Current');
  });
});
