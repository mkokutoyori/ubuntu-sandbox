/**
 * Une tempête de diffusion se VOIT dans les compteurs.
 *
 * Mesure de départ, sur une boucle L2 réelle — deux commutateurs reliés
 * par DEUX câbles, STP coupé, un seul `ping` donc une seule requête ARP
 * de diffusion : 2554 trames traversent le fil contre 9 avec STP, et la
 * table MAC apprend le poste sur le lien inter-commutateurs alors qu'il
 * est câblé ailleurs. La tempête a donc bien lieu. Elle n'était visible
 * NULLE PART dans les vues :
 *
 *  - `show interfaces` écrivait `Received 0 broadcasts (0 IP multicasts)`
 *    en dur — la ligne qui compte exactement ce qu'une tempête produit ;
 *  - `5 minute input rate 0 bits/sec, 0 packets/sec` était en dur des
 *    deux côtés, c'est-à-dire la ligne qu'un opérateur regarde EN
 *    PREMIER ;
 *  - `load-interval`, qui est le réglage servant à raccourcir cette
 *    moyenne quand on traque une rafale, était rangé sur une propriété
 *    ad hoc (`port as unknown as { loadIntervalSec?: number }`) que
 *    personne ne lisait côté routeur, et tombait dans un fourre-tout de
 *    chaînes côté commutateur ;
 *  - `show interfaces counters` affichait `framesIn` sous l'intitulé
 *    `InUcastPkts` : les trames de diffusion étaient comptées comme de
 *    l'unicast, donc l'en-tête mentait ;
 *  - `display interface` de VRP écrivait `Input: 0 packets, 0 bytes` en
 *    dur, dans les DEUX vues qui le rendent, alors que le port compte
 *    pour de bon.
 *
 * `PortCounters` gagne donc broadcast et multicast, comptés aux points
 * d'émission et de réception réels ; l'unicast est DÉRIVÉ
 * (`framesIn - broadcastIn - multicastIn`) et non stocké. Le débit est
 * un seul modèle (`PortLoad`, moyenne à décroissance exponentielle sur
 * l'intervalle de charge) lu par IOS et par VRP avec leurs mots
 * respectifs.
 *
 * Discrimine par `git stash` : 7 cas tombent avant correctif. J'en
 * avais annoncé 9, et la mesure a corrigé deux fois la prévision.
 *
 * Les 4 qui passent des deux côtés sont nommés :
 *  - « le TÉMOIN : la boucle produit vraiment la tempête » observe les
 *    compteurs de TRAMES, qui existaient déjà, et non les vues ; c'est
 *    son objet — sans lui, une sonde faite de vues ne dirait pas si le
 *    laboratoire produit quoi que ce soit. Sa PREMIÈRE rédaction ne
 *    témoignait de rien : le montage appelait `getLoadRates()`, une
 *    méthode que le correctif ajoute, donc le témoin tombait avec le
 *    reste ; il prend maintenant un montage qui n'en dépend pas.
 *  - « load-interval est rendu dans la configuration » : le fourre-tout
 *    de chaînes du commutateur le recopiait déjà, ce qui est justement
 *    ce qui rendait son inertie invisible ;
 *  - les deux cas de `PortLoad`, module neuf donc non retiré par la
 *    restauration : ils éprouvent la décroissance et la période
 *    d'échantillonnage, que rien d'autre ne couvre.
 *
 * Références : capture réelle `ntc-templates`
 * `cisco_ios/show_interfaces` (bloc `5 minute … rate` /
 * `Received N broadcasts`) et `huawei_vrp/display_interface`
 * (`Input:  N packets, N bytes` puis `Unicast:` / `Multicast:` /
 * `Broadcast:` / `Jumbo:`), plus la sortie documentée par Cisco pour
 * `show interfaces counters` (`Port InOctets InUcastPkts InMcastPkts
 * InBcastPkts`, puis la table `Out…`) — le dépôt n'en rendait qu'UNE
 * table mélangeant les deux sens, forme qu'aucun IOS ne produit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { PortLoad } from '@/network/hardware/PortLoad';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

let horloge: VirtualTimeScheduler;
beforeEach(() => {
  horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);
});

async function boucle(stp: boolean, echantillonner = true) {
  const a = new CiscoSwitch('switch-cisco', 'SW-A', 8);
  const b = new CiscoSwitch('switch-cisco', 'SW-B', 8);
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  new Cable('l1').connect(a.getPort('FastEthernet0/1')!, b.getPort('FastEthernet0/1')!);
  new Cable('l2').connect(a.getPort('FastEthernet0/2')!, b.getPort('FastEthernet0/2')!);
  new Cable('h').connect(a.getPort('FastEthernet0/8')!, pc.getPort('eth0')!);
  if (!stp) {
    for (const d of [a, b]) {
      await d.executeCommand('enable');
      await d.executeCommand('configure terminal');
      await d.executeCommand('no spanning-tree vlan 1');
      await d.executeCommand('end');
    }
  }
  await pc.executeCommand('sudo ip addr add 10.0.0.1/24 dev eth0');
  await pc.executeCommand('sudo ip link set eth0 up');
  await a.executeCommand('enable');
  if (echantillonner) a.getPort('FastEthernet0/1')!.getLoadRates();
  await horloge.advanceUntilSettled(pc.executeCommand('ping -c 1 -W 1 10.0.0.99'));
  horloge.advance(10_000);
  return { a, b, pc };
}

describe('la tempête est observable', () => {
  it('le TÉMOIN : la boucle produit vraiment la tempête', async () => {
    const { a } = await boucle(false, false);
    expect(a.getPort('FastEthernet0/1')!.getCounters().framesIn).toBeGreaterThan(100);
    const { a: sain } = await boucle(true, false);
    expect(sain.getPort('FastEthernet0/1')!.getCounters().framesIn).toBeLessThan(20);
  });

  it('show interfaces COMPTE les diffusions reçues', async () => {
    const { a } = await boucle(false);
    const out = await a.executeCommand('show interfaces FastEthernet0/1');
    const ligne = out.split('\n').find(l => l.includes('broadcasts'))!;
    const recues = Number(ligne.trim().split(' ')[1]);
    expect(recues).toBeGreaterThan(100);
  });

  it('sans boucle, la même ligne reste à zéro', async () => {
    const { a } = await boucle(true);
    expect(await a.executeCommand('show interfaces FastEthernet0/1'))
      .toContain('Received 0 broadcasts');
  });

  it('le débit de charge est mesuré, plus écrit en dur', async () => {
    const { a } = await boucle(false);
    const out = await a.executeCommand('show interfaces FastEthernet0/1');
    const ligne = out.split('\n').find(l => l.includes('input rate'))!;
    expect(ligne).toMatch(/5 minute input rate \d+ bits\/sec/);
    expect(ligne).not.toContain('rate 0 bits/sec');
  });

  it('load-interval raccourcit la moyenne, et la vue le DIT', async () => {
    const a = new CiscoSwitch('switch-cisco', 'SW-C', 4);
    await a.executeCommand('enable');
    await a.executeCommand('configure terminal');
    await a.executeCommand('interface FastEthernet0/1');
    await a.executeCommand('load-interval 30');
    await a.executeCommand('end');
    expect(a.getPort('FastEthernet0/1')!.getLoadIntervalSec()).toBe(30);
    expect(await a.executeCommand('show interfaces FastEthernet0/1'))
      .toContain('30 second input rate');
  });

  it('load-interval refuse une valeur hors grille', async () => {
    const a = new CiscoSwitch('switch-cisco', 'SW-D', 4);
    await a.executeCommand('enable');
    await a.executeCommand('configure terminal');
    await a.executeCommand('interface FastEthernet0/1');
    expect(await a.executeCommand('load-interval 45')).toContain('Invalid input');
    expect(a.getPort('FastEthernet0/1')!.getLoadIntervalSec()).toBe(300);
  });

  it('load-interval est rendu dans la configuration, donc rejoué', async () => {
    const a = new CiscoSwitch('switch-cisco', 'SW-E', 4);
    await a.executeCommand('enable');
    await a.executeCommand('configure terminal');
    await a.executeCommand('interface FastEthernet0/1');
    await a.executeCommand('load-interval 60');
    await a.executeCommand('end');
    expect(await a.executeCommand('show running-config')).toContain('load-interval 60');
  });

  it('show interfaces counters sépare unicast, multicast et diffusion', async () => {
    const { a } = await boucle(false);
    const out = await a.executeCommand('show interfaces counters FastEthernet0/1');
    expect(out).toContain('InOctets    InUcastPkts    InMcastPkts    InBcastPkts');
    expect(out).toContain('OutOctets   OutUcastPkts   OutMcastPkts   OutBcastPkts');
    const entree = out.split('\n')[1].trim().split(/\s+/);
    expect(Number(entree[4])).toBeGreaterThan(100);
    expect(Number(entree[2])).toBe(0);
  });

  it('VRP : display interface lit les compteurs du port', async () => {
    const r1 = new HuaweiRouter('R1');
    const r2 = new HuaweiRouter('R2');
    new Cable('w').connect(r1.getPorts()[0], r2.getPorts()[0]);
    for (const d of [r1, r2]) {
      await d.executeCommand('system-view');
      await d.executeCommand('lldp enable');
      await d.executeCommand('quit');
    }
    const nom = r1.getPorts()[0].getName();
    const out = await r1.executeCommand(`display interface ${nom}`);
    expect(out).not.toContain('Input:  0 packets, 0 bytes');
    expect(out).toMatch(/Input:  [1-9]\d* packets, [1-9]\d* bytes/);
    expect(out).toMatch(/Multicast: +[1-9]/);
    expect(out).toContain('Input bandwidth utilization');
  });

  it('la moyenne décroît comme celle d IOS', () => {
    const load = new PortLoad();
    expect(load.setIntervalSec(30)).toBe(true);
    expect(load.setIntervalSec(45)).toBe(false);
    load.sample(0, { bytesIn: 0, framesIn: 0, bytesOut: 0, framesOut: 0 });
    load.sample(10_000, { bytesIn: 12_500, framesIn: 100, bytesOut: 0, framesOut: 0 });
    const premier = load.rates().inBitsPerSec;
    expect(premier).toBeGreaterThan(0);
    load.sample(20_000, { bytesIn: 12_500, framesIn: 100, bytesOut: 0, framesOut: 0 });
    expect(load.rates().inBitsPerSec).toBeLessThan(premier);
  });

  it('clear counters remet aussi la MOYENNE à zéro', async () => {
    const { a } = await boucle(false);
    const port = a.getPort('FastEthernet0/1')!;
    expect(port.getLoadRates().inBitsPerSec).toBeGreaterThan(0);
    port.resetCounters();
    horloge.advance(10_000);
    const apres = port.getLoadRates();
    expect(apres.inBitsPerSec).toBe(0);
    expect(apres.inPacketsPerSec).toBe(0);
  });

  it('une lecture rapprochée ne rééchantillonne pas', () => {
    const load = new PortLoad();
    load.sample(0, { bytesIn: 0, framesIn: 0, bytesOut: 0, framesOut: 0 });
    load.sample(1_000, { bytesIn: 999_999, framesIn: 9_999, bytesOut: 0, framesOut: 0 });
    expect(load.rates().inBitsPerSec).toBe(0);
  });
});
