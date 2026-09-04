/**
 * Un commutateur logiciel ne commutait RIEN, et trois attributs sur
 * cinq etaient jetes.
 *
 * Mesure de depart, sur un FortiGate dont `port1` et `port2` sont
 * membres du meme `system switch-interface` et dont les deux voisins
 * sont dans le meme /24 : `ping` rend `100% packet loss`, `ip neigh`
 * rend `FAILED`, et rien ne traverse — c'est-a-dire tout ce que cette
 * commande existe pour faire. La cause n'est pas dans un attribut :
 * `handleArpFrame` ne fait que REPONDRE pour les adresses du pare-feu
 * lui-meme, et le pontage n'existait que dans `switchBridgeStage`,
 * c'est-a-dire dans le pipeline IPv4 — une couche trop haut. Une trame
 * ARP n'arrivait donc jamais au voisin, les hotes ne se resolvaient
 * pas, et le pipeline IPv4 n'etait jamais atteint. Le pontage descend
 * dans `handleFrame`, avant l'aiguillage par type de trame, parce qu'un
 * commutateur relaie CE QUI PASSE et non les seuls paquets IP.
 *
 * **`BridgeFdb` existait deja et etait deja alimente**, `handleFrame`
 * appelant `learn()` sur chaque trame depuis toujours pour le mode
 * transparent. Le commutateur logiciel le LIT plutot que de porter une
 * seconde table d'adresses : une machine qui apprendrait deux fois la
 * meme chose finirait par repondre deux choses differentes.
 *
 * **`type {switch | hub}`** etait rendu par `show` et jete par
 * `onCommit`, et le comportement n'etait ni l'un ni l'autre : l'etage
 * prenait le PREMIER autre membre du groupe, quelle que soit l'adresse
 * de destination. La reference tranche : `switch` pour la commutation
 * normale, `hub` « to duplicate packets to all member ports ». Les deux
 * sont desormais distinguables sur le fil — un concentrateur livre a
 * un tiers ce qui ne lui est pas adresse, un commutateur non.
 *
 * **`intra-switch-policy` etait declare `enable | disable`** la ou la
 * reference ecrit `implicit | explicit`, donc la valeur reelle etait
 * REFUSEE (`value parse error before 'explicit'`) et la valeur acceptee
 * n'existe pas sur une vraie machine. Le sens est celui de la
 * documentation : `implicit` laisse passer entre membres, `explicit`
 * exige une politique. Decision ecrite plutot que tue : sous `explicit`
 * l'ARP est PONTE quand meme, parce qu'une politique se prononce sur
 * des adresses IP et qu'un hote qui ne peut pas resoudre son voisin ne
 * pourrait jamais lui parler, meme quand la politique l'autorise.
 *
 * **La famille SPAN n'existait qu'a un tiers**, et le tiers present
 * etait nuisible : `span-dest-port` etait declare et jete, tandis que
 * `span`, `span-direction` et `config span-source-port` n'existaient
 * pas — si bien que `set span enable`, par l'abreviation que la CLI
 * pratique, resolvait vers `span-dest-port` et posait « enable » comme
 * NOM DE PORT de destination, en silence. Les quatre sont declarees et
 * honorees, `rx` a la reception et `tx` a l'emission, chacune gardee
 * contre la re-entrance comme `Switch.emitMirror` l'est deja.
 *
 * Discrimine par `git stash push -- src/network/` : 7 des 13 cas
 * tombent — j'en avais annonce 11 avant de mesurer, et la mesure a
 * raison. Les 6 qui passent des deux cotes sont nommes ici avec, pour
 * chacun, la raison pour laquelle il ne discrimine pas :
 *
 *   - « deux hotes hors commutateur logiciel se joignent par le
 *     routage » est le TEMOIN, et il est indispensable : sans lui, un
 *     laboratoire mal cable et un pontage absent seraient
 *     indiscernables ;
 *   - « les membres declares sont rendus » passait deja, et c'est
 *     l'enonce meme du defaut : rendus, et lus par personne ;
 *   - les QUATRE cas negatifs — « un commutateur n'envoie pas a un
 *     tiers », « sous explicit et sans politique le trafic est
 *     bloque », « sans span le port de destination ne voit rien » et
 *     « span-source-port restreint la recopie » — passaient avant le
 *     correctif pour une raison qui ne prouve rien : RIEN ne
 *     traversait, donc compter zero etait vrai sans que le mecanisme
 *     existe. Ils n'ont de contenu qu'apres, et chacun a un jumeau
 *     positif qui tombe, lequel est ce qui les rend lisibles.
 *
 * La mesure de leurs compteurs a demande une precision qui merite
 * d'etre dite : compter les trames IPv4 recues ne discriminait pas, les
 * hotes du laboratoire emettant leur propre trafic de fond. Le compteur
 * ne retient que l'echo A vers B, c'est-a-dire exactement le paquet
 * dont on demande s'il a ete livre a un tiers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, ETHERTYPE_IPV4 } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(command: string): Promise<string> }

async function runOn(device: Cmd, ...commands: string[]): Promise<string> {
  let last = '';
  for (const command of commands) last = await device.executeCommand(command);
  return last;
}

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

interface Labo {
  fw: FortiGate;
  sh: FortiShell;
  a: LinuxPC;
  b: LinuxPC;
  c: LinuxPC;
  spy: LinuxPC;
}

async function laboratoire(reglages: readonly string[] = []): Promise<Labo> {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell() as FortiShell;
  const a = new LinuxPC('linux-pc', 'A', 200, 0);
  const b = new LinuxPC('linux-pc', 'B', 200, 100);
  const c = new LinuxPC('linux-pc', 'C', 200, 200);
  const spy = new LinuxPC('linux-pc', 'SPY', 200, 300);
  [a, b, c, spy].forEach(pc => pc.powerOn());

  new Cable('c1').connect(fw.getPort('port1')!, a.getPorts()[0]);
  new Cable('c2').connect(fw.getPort('port2')!, b.getPorts()[0]);
  new Cable('c3').connect(fw.getPort('port3')!, c.getPorts()[0]);
  new Cable('c4').connect(fw.getPort('port4')!, spy.getPorts()[0]);

  run(sh, 'config system switch-interface', 'edit "lan"',
    'set member "port1" "port2" "port3"', ...reglages, 'next', 'end');

  await runOn(a, 'ip link set eth0 up', 'ip addr add 10.0.0.10/24 dev eth0');
  await runOn(b, 'ip link set eth0 up', 'ip addr add 10.0.0.11/24 dev eth0');
  await runOn(c, 'ip link set eth0 up', 'ip addr add 10.0.0.12/24 dev eth0');
  await runOn(spy, 'ip link set eth0 up', 'ip addr add 10.0.0.13/24 dev eth0');

  return { fw, sh, a, b, c, spy };
}

async function routedWitness(): Promise<{ a: LinuxPC }> {
  const fw = new FortiGate('firewall-fortinet', 'FGT2', 0, 0);
  const sh = fw.getShell() as FortiShell;
  const a = new LinuxPC('linux-pc', 'RA', 400, 0);
  const b = new LinuxPC('linux-pc', 'RB', 400, 100);
  a.powerOn();
  b.powerOn();
  new Cable('r1').connect(fw.getPort('port1')!, a.getPorts()[0]);
  new Cable('r2').connect(fw.getPort('port2')!, b.getPorts()[0]);

  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', 'set ip 10.5.1.1 255.255.255.0', 'next',
    'edit "port2"', 'set mode static', 'set ip 10.5.2.1 255.255.255.0', 'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"', 'next', 'end');

  await runOn(a, 'ip link set eth0 up', 'ip addr add 10.5.1.10/24 dev eth0',
    'ip route add default via 10.5.1.1');
  await runOn(b, 'ip link set eth0 up', 'ip addr add 10.5.2.10/24 dev eth0',
    'ip route add default via 10.5.2.1');
  await runOn(a, 'ping -c 1 10.5.2.10');
  return { a };
}

function countEchoesOn(pc: LinuxPC, from: string, to: string): () => number {
  let seen = 0;
  pc.getBus().subscribe('port.frame.received', (event: unknown) => {
    const frame = (event as {
      payload?: { frame?: { etherType?: number; payload?: unknown } };
    }).payload?.frame;
    if (frame?.etherType !== ETHERTYPE_IPV4) return;
    const packet = frame.payload as {
      sourceIP?: { toString(): string }; destinationIP?: { toString(): string };
    } | undefined;
    if (packet?.sourceIP?.toString() === from
      && packet?.destinationIP?.toString() === to) seen++;
  });
  return () => seen;
}

describe('le commutateur logiciel commute', () => {
  it('deux hotes hors commutateur logiciel se joignent par le routage', async () => {
    const { a } = await routedWitness();

    expect(await runOn(a, 'ping -c 2 10.5.2.10')).toContain(', 0% packet loss');
  }, 25000);

  it('les membres declares sont rendus', async () => {
    const { sh } = await laboratoire();

    expect(sh.execute('show system switch-interface'))
      .toContain('set member "port1" "port2" "port3"');
  }, 25000);

  it('deux membres du meme commutateur logiciel se joignent', async () => {
    const { a } = await laboratoire();

    expect(await runOn(a, 'ping -c 2 10.0.0.11')).toContain(', 0% packet loss');
  }, 25000);

  it('l_ARP traverse, donc le voisin est resolu', async () => {
    const { a } = await laboratoire();
    await runOn(a, 'ping -c 1 10.0.0.11');

    expect(await runOn(a, 'ip neigh')).toMatch(/10\.0\.0\.11 .*REACHABLE/);
  }, 25000);

  it('un troisieme membre est joignable par le meme commutateur', async () => {
    const { a } = await laboratoire();

    expect(await runOn(a, 'ping -c 2 10.0.0.12')).toContain(', 0% packet loss');
  }, 25000);

  it('un commutateur n_envoie pas a un tiers ce qui ne lui est pas adresse', async () => {
    const labo = await laboratoire();
    await runOn(labo.a, 'ping -c 1 10.0.0.11');
    const seen = countEchoesOn(labo.c, '10.0.0.10', '10.0.0.11');
    await runOn(labo.a, 'ping -c 3 10.0.0.11');

    expect(seen()).toBe(0);
  }, 25000);

  it('un concentrateur duplique vers tous les membres', async () => {
    const labo = await laboratoire(['set type hub']);
    await runOn(labo.a, 'ping -c 1 10.0.0.11');
    const seen = countEchoesOn(labo.c, '10.0.0.10', '10.0.0.11');
    await runOn(labo.a, 'ping -c 3 10.0.0.11');

    expect(seen()).toBeGreaterThan(0);
  }, 25000);

  it('la valeur explicit est acceptee et rendue', async () => {
    const { sh } = await laboratoire(['set intra-switch-policy explicit']);

    expect(sh.execute('show system switch-interface'))
      .toContain('set intra-switch-policy explicit');
  }, 25000);

  it('sous explicit et sans politique, le trafic entre membres est bloque', async () => {
    const { a } = await laboratoire(['set intra-switch-policy explicit']);

    expect(await runOn(a, 'ping -c 2 10.0.0.11')).toContain(', 100% packet loss');
  }, 25000);

  it('sous implicit, le meme trafic passe sans politique', async () => {
    const { a } = await laboratoire(['set intra-switch-policy implicit']);

    expect(await runOn(a, 'ping -c 2 10.0.0.11')).toContain(', 0% packet loss');
  }, 25000);

  it('span recopie vers le port de destination', async () => {
    const labo = await laboratoire([
      'set span enable', 'set span-dest-port "port4"', 'set span-direction both',
    ]);
    const seen = countEchoesOn(labo.spy, '10.0.0.10', '10.0.0.11');
    await runOn(labo.a, 'ping -c 3 10.0.0.11');

    expect(seen()).toBeGreaterThan(0);
  }, 25000);

  it('sans span, le port de destination ne voit rien', async () => {
    const labo = await laboratoire(['set span-dest-port "port4"']);
    const seen = countEchoesOn(labo.spy, '10.0.0.10', '10.0.0.11');
    await runOn(labo.a, 'ping -c 3 10.0.0.11');

    expect(seen()).toBe(0);
  }, 25000);

  it('span-source-port restreint la recopie aux ports nommes', async () => {
    const labo = await laboratoire([
      'set span enable', 'set span-dest-port "port4"', 'set span-direction rx',
      'config span-source-port', 'edit "port3"', 'next', 'end',
    ]);
    const seen = countEchoesOn(labo.spy, '10.0.0.10', '10.0.0.11');
    await runOn(labo.a, 'ping -c 3 10.0.0.11');

    expect(seen()).toBe(0);
  }, 25000);
});
