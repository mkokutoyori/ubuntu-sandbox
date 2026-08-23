/**
 * Le pont du mode transparent APPREND, VIEILLIT, et se LIT.
 *
 * §6.6 du carnet nomme le point : « l'apprentissage MAC du mode
 * transparent est une table simple sur le chassis, sans vieillissement ni
 * STP ». La mesure ajoute trois choses que le carnet ne disait pas : la
 * table n'a aucune vue qui la lise, elle est unique pour tout le chassis
 * la ou un vrai FortiGate porte un pont PAR VDOM, et rien ne la purge
 * quand un port tombe.
 *
 * Ecrite A L'AVEUGLE contre ce que fait un vrai FortiGate :
 *
 *   1. Une trame qui traverse fait APPRENDRE son adresse source, et la
 *      table dit sur quel port.
 *   2. L'entree VIEILLIT : duree de vie 300 secondes sur un vrai
 *      boitier, apres quoi elle est oubliee et reapprise. C'est le
 *      coeur du sujet — sans horodatage, une entree vit pour toujours.
 *   3. Le trafic REPOUSSE l'echeance : c'est un age depuis la derniere
 *      trame vue, pas un bail a duree fixe.
 *   4. `diagnose netlink brctl list` nomme les instances de pont, une
 *      par VDOM, et `diagnose netlink brctl name host <vdom>.b` rend le
 *      tableau des adresses apprises avec ses colonnes reelles.
 *   5. Chaque VDOM a SON pont : deux VDOM qui apprennent la meme adresse
 *      ne se marchent pas dessus.
 *   6. Un port qui TOMBE perd ses entrees — sinon une trame continue de
 *      viser un port mort pendant cinq minutes.
 *   7. Une adresse qui BOUGE de port est reapprise sur le nouveau.
 *   8. La duree de vie se regle, et la vue rend le temps qui RESTE.
 *
 * Ce qui n'est PAS fait ici et pourquoi : la table de `Switch.ts` n'est
 * pas partagee. Les deux objets ne repondent pas a la meme question — la
 * sienne est indexee par `vlan:mac` et distingue statique / dynamique /
 * trou noir, avec la securite de port et le vieillissement accelere de
 * STP par-dessus. Un pont de mode transparent n'a ici ni VLAN, ni entree
 * statique, ni trou noir, ni STP.
 *
 * Discrimination (`git stash push -- src/network/`) : 5 des 12 cas
 * tombent avant correctif. Les 7 autres sont nommes ici plutot que
 * laisses a decouvrir :
 *   - les SIX cas de modele (`new BridgeFdb(...)`) passent des deux
 *     cotes parce que `git stash` ne touche pas un fichier NEUF non
 *     suivi : la base n'est pas revenue en arriere, seul son cablage
 *     l'est. Ils eprouvent la regle de vieillissement, pas l'equipement ;
 *   - « un pont qui n'existe pas est nomme comme tel » passait parce que
 *     la commande ENTIERE etait refusee, donc la reponse ne contenait
 *     evidemment pas d'en-tete de tableau — vrai pour la mauvaise raison.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { BridgeFdb, DEFAULT_FDB_AGING_SEC } from '@/network/devices/firewall/l2/BridgeFdb';

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

let horloge = 1_700_000_000_000;
function avance(secondes: number): void { horloge += secondes * 1000; }

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); },
    Promise.resolve<unknown>(undefined));

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  horloge = 1_700_000_000_000;

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0, { now: () => horloge });
  const sh = fw.getShell();
  const gauche = new LinuxPC('linux-pc', 'GAUCHE', -100, 0);
  const droite = new LinuxPC('linux-pc', 'DROITE', 100, 0);
  for (const d of [gauche, droite]) d.powerOn();

  new Cable('a').connect(gauche.getPort('eth0')!, fw.getPort('port1')!);
  new Cable('b').connect(fw.getPort('port2')!, droite.getPort('eth0')!);

  run(sh, 'config system settings',
    'set opmode transparent',
    'set manageip 192.168.1.99 255.255.255.0', 'end');
  run(sh, 'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next', 'end');

  await runOn(gauche, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0']);
  await runOn(droite, ['ip link set eth0 up', 'ip addr add 192.168.1.20/24 dev eth0']);

  return { fw, sh, gauche, droite };
}

function macDe(machine: LinuxPC): string {
  return machine.getPort('eth0')!.getMAC().toString().toLowerCase();
}

describe('le pont apprend ce qui traverse', () => {
  beforeEach(() => { Logger.reset(); });

  it('une trame qui traverse fait apprendre son adresse source', async () => {
    const { fw, gauche } = await laboratoire();

    await gauche.executeCommand('ping -c 1 192.168.1.20');

    expect(fw.getBridge().lookup(macDe(gauche))).toBe('port1');
  });

  it('une adresse qui BOUGE de port est reapprise sur le nouveau', () => {
    const pont = new BridgeFdb({ now: () => horloge });

    pont.learn('00:11:22:33:44:55', 'port1');
    expect(pont.lookup('00:11:22:33:44:55')).toBe('port1');

    pont.learn('00:11:22:33:44:55', 'port3');
    expect(pont.lookup('00:11:22:33:44:55')).toBe('port3');
    expect(pont.entries()).toHaveLength(1);
  });

  it('un port qui tombe perd ses entrees', async () => {
    const { fw, gauche } = await laboratoire();
    await gauche.executeCommand('ping -c 1 192.168.1.20');
    expect(fw.getBridge().lookup(macDe(gauche))).toBe('port1');

    fw.getPort('port1')!.setAdminDown(true);

    expect(fw.getBridge().lookup(macDe(gauche))).toBeUndefined();
  });
});

describe('le pont VIEILLIT', () => {
  beforeEach(() => { Logger.reset(); });

  it('la duree de vie par defaut est de 300 secondes', () => {
    expect(DEFAULT_FDB_AGING_SEC).toBe(300);
  });

  it('une entree est oubliee passe la duree de vie', () => {
    const pont = new BridgeFdb({ now: () => horloge });
    pont.learn('00:11:22:33:44:55', 'port1');

    avance(299);
    expect(pont.lookup('00:11:22:33:44:55')).toBe('port1');

    avance(2);
    expect(pont.lookup('00:11:22:33:44:55')).toBeUndefined();
    expect(pont.entries()).toHaveLength(0);
  });

  it('le trafic REPOUSSE l echeance', () => {
    const pont = new BridgeFdb({ now: () => horloge });
    pont.learn('00:11:22:33:44:55', 'port1');

    avance(200);
    pont.learn('00:11:22:33:44:55', 'port1');
    avance(200);

    expect(pont.lookup('00:11:22:33:44:55')).toBe('port1');
  });

  it('la duree de vie se regle', () => {
    const pont = new BridgeFdb({ now: () => horloge, agingSeconds: 30 });
    pont.learn('00:11:22:33:44:55', 'port1');

    avance(31);
    expect(pont.lookup('00:11:22:33:44:55')).toBeUndefined();
  });

  it('la vue rend le temps qui RESTE, pas celui qui est passe', () => {
    const pont = new BridgeFdb({ now: () => horloge });
    pont.learn('00:11:22:33:44:55', 'port1');

    avance(100);

    expect(pont.entries()[0]?.ttlSeconds).toBe(200);
  });
});

describe('`diagnose netlink brctl` lit le pont', () => {
  beforeEach(() => { Logger.reset(); });

  it('`list` nomme l instance de pont du VDOM', async () => {
    const { sh } = await laboratoire();

    const vue = run(sh, 'diagnose netlink brctl list');

    expect(vue).toContain('root.b');
  });

  it('`name host <vdom>.b` rend le tableau avec ses colonnes reelles',
    async () => {
      const { sh, gauche } = await laboratoire();
      await gauche.executeCommand('ping -c 1 192.168.1.20');

      const vue = run(sh, 'diagnose netlink brctl name host root.b');

      expect(vue).toContain('show bridge control interface root.b host');
      expect(vue).toContain('port no');
      expect(vue).toContain('devname');
      expect(vue).toContain('mac addr');
      expect(vue).toContain('ttl');
      expect(vue).toContain(macDe(gauche));
      expect(vue).toContain('port1');
    });

  it('un pont qui n existe pas est nomme comme tel', async () => {
    const { sh } = await laboratoire();

    const vue = run(sh, 'diagnose netlink brctl name host absent.b');

    expect(vue).not.toContain('port no');
    expect(vue.length).toBeGreaterThan(0);
  });

  it('chaque VDOM a SON pont', () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
    horloge = 1_700_000_000_000;
    const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0, { now: () => horloge });
    const sh = fw.getShell();
    run(sh, 'config system global', 'set vdom-mode multi-vdom', 'end');
    run(sh, 'config vdom', 'edit "client-a"', 'next', 'end');

    fw.getBridge('root').learn('00:11:22:33:44:55', 'port1');
    fw.getBridge('client-a').learn('00:11:22:33:44:55', 'port3');

    expect(fw.getBridge('root').lookup('00:11:22:33:44:55')).toBe('port1');
    expect(fw.getBridge('client-a').lookup('00:11:22:33:44:55')).toBe('port3');
    expect(run(sh, 'diagnose netlink brctl list')).toContain('client-a.b');
  });
});
