/**
 * VRP — le MQC filtre pour de bon, et sa configuration survit.
 *
 * Ce que la mesure a trouve, et qui corrige l'entree de TODO que j'avais
 * ecrite : le MQC n'etait PAS un decor. Le classificateur, le
 * comportement, la politique et son evaluation sur le chemin de donnees
 * existaient (`mqcVlanPermits` est appelee dans `handleFrame`). Trois
 * choses manquaient vraiment.
 *
 * 1. Le classificateur ne connaissait QUE `if-match acl` ; `if-match
 *    vlan-id` et `if-match any` etaient refuses, donc un laboratoire
 *    sans liste d'acces ne pouvait rien classer.
 * 2. Les trois vues `display traffic … user-defined` n'existaient pas :
 *    on configurait sans jamais pouvoir relire.
 * 3. Rien de tout cela ne figurait dans `display current-configuration`
 *    — alors que la ligne `traffic-policy … inbound` de l'INTERFACE, si.
 *    Une topologie rechargee referencait donc une politique disparue.
 *
 * Et le quatrieme, le plus vicieux : la ligne de l'interface etait
 * acceptee par le fourre-tout de texte, rendue, et n'evaluait RIEN —
 * seule la liaison au VLAN filtrait. Un port « protege » laissait tout
 * passer.
 *
 * Discrimine par `git stash` de `Switch.ts` et `HuaweiSwitchShell.ts` :
 * 10 des 12 cas tombent. Les 2 qui passent des deux cotes sont nommes
 * ici — le TEMOIN sans politique, dont c'est l'objet, et le refus d'un
 * numero de VLAN hors bornes, qui passait avant pour la mauvaise raison
 * (`if-match vlan-id` etait refuse tout entier).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function commutateur(lignes: readonly string[]): Promise<HuaweiSwitch> {
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 10, 0, 0);
  for (const c of ['system-view', ...lignes]) await sw.executeCommand(c);
  return sw;
}

const BASE = [
  'traffic classifier tc1',
  'if-match vlan-id 10',
  'quit',
  'traffic behavior tb1',
  'deny',
  'quit',
  'traffic policy tp1',
  'classifier tc1 behavior tb1',
  'quit',
];

interface Labo { sw: HuaweiSwitch; a: LinuxPC; b: LinuxPC; }

async function laboFiltre(liaison: readonly string[]): Promise<Labo> {
  const sw = await commutateur([...BASE, 'vlan 10', 'quit', ...liaison]);
  const a = new LinuxPC('linux-pc', 'A', 0, 0);
  const b = new LinuxPC('linux-pc', 'B', 0, 0);
  const masque = new SubnetMask('255.255.255.0');
  new Cable('c1').connect(a.getPorts()[0], sw.getPort('GigabitEthernet0/0/1')!);
  new Cable('c2').connect(b.getPorts()[0], sw.getPort('GigabitEthernet0/0/2')!);
  a.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), masque);
  b.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), masque);
  for (const [port, ligne] of [['GigabitEthernet0/0/1', 1], ['GigabitEthernet0/0/2', 2]] as const) {
    void ligne;
    for (const c of [`interface ${port}`, 'port link-type access', 'port default vlan 10', 'quit']) {
      await sw.executeCommand(c);
    }
  }
  return { sw, a, b };
}

const perdu = (sortie: string) => /100% packet loss/.test(sortie);

describe('le classificateur connait autre chose qu une liste d acces', () => {
  it('`if-match vlan-id` est accepte et rendu', async () => {
    const sw = await commutateur(BASE);
    const vue = await sw.executeCommand('display traffic classifier user-defined');
    expect(vue).toContain('tc1');
    expect(vue).toContain('if-match vlan-id 10');
  });

  it('`if-match any` aussi', async () => {
    const sw = await commutateur(['traffic classifier tout', 'if-match any', 'quit']);
    expect(await sw.executeCommand('display traffic classifier user-defined'))
      .toContain('if-match any');
  });

  it('un numero de VLAN hors bornes est refuse', async () => {
    const sw = await commutateur(['traffic classifier tc9']);
    expect(await sw.executeCommand('if-match vlan-id 9999')).toContain('Error');
  });

  it('les trois vues rendent ce qui est configure', async () => {
    const sw = await commutateur(BASE);
    expect(await sw.executeCommand('display traffic behavior user-defined')).toContain('deny');
    const politique = await sw.executeCommand('display traffic policy user-defined');
    expect(politique).toContain('tp1');
    expect(politique).toContain('tc1');
    expect(politique).toContain('tb1');
  });

  it('TEMOIN — sans rien de configure, les vues le disent', async () => {
    const sw = await commutateur([]);
    expect(await sw.executeCommand('display traffic policy user-defined'))
      .toContain('Total 0 matched');
  });
});

describe('la configuration rendue porte le MQC', () => {
  it('les trois objets y figurent', async () => {
    const sw = await commutateur(BASE);
    const texte = await sw.executeCommand('display current-configuration');
    expect(texte).toContain('traffic classifier tc1');
    expect(texte).toContain(' if-match vlan-id 10');
    expect(texte).toContain('traffic behavior tb1');
    expect(texte).toContain('traffic policy tp1');
    expect(texte).toContain(' classifier tc1 behavior tb1');
  });

  it('la liaison a un VLAN y figure aussi', async () => {
    const sw = await commutateur([...BASE, 'vlan 10', 'traffic-policy tp1 inbound', 'quit']);
    expect(await sw.executeCommand('display current-configuration'))
      .toContain(' traffic-policy tp1 inbound');
  });

  it('`display traffic-policy applied-record` dit OU elle est posee', async () => {
    const sw = await commutateur([...BASE, 'vlan 10', 'traffic-policy tp1 inbound', 'quit']);
    const vue = await sw.executeCommand('display traffic-policy applied-record');
    expect(vue).toContain('tp1');
    expect(vue).toContain('Vlan 10');
  });
});

describe('la politique posee sur un PORT filtre vraiment', () => {
  it('TEMOIN — sans politique, le ping passe', async () => {
    const { a } = await laboFiltre([]);
    expect(perdu(await a.executeCommand('ping -c 1 10.0.0.2'))).toBe(false);
  });

  it('posee sur le port d entree, elle jette le trafic du VLAN', async () => {
    const { a } = await laboFiltre([
      'interface GigabitEthernet0/0/1', 'traffic-policy tp1 inbound', 'quit',
    ]);
    expect(perdu(await a.executeCommand('ping -c 1 10.0.0.2'))).toBe(true);
  });

  it('`undo traffic-policy` la retire, du port et de la configuration', async () => {
    const { sw, a } = await laboFiltre([
      'interface GigabitEthernet0/0/1', 'traffic-policy tp1 inbound', 'quit',
    ]);
    for (const c of ['interface GigabitEthernet0/0/1', 'undo traffic-policy', 'quit']) {
      await sw.executeCommand(c);
    }
    expect(await sw.executeCommand('display current-configuration'))
      .not.toContain('traffic-policy tp1 inbound');
    expect(perdu(await a.executeCommand('ping -c 1 10.0.0.2'))).toBe(false);
  });

  it('une politique qui n existe pas est refusee au lieu d etre rangee', async () => {
    const sw = await commutateur(['interface GigabitEthernet0/0/1']);
    expect(await sw.executeCommand('traffic-policy inconnue inbound')).toContain('Error');
  });
});

/**
 * Le second volet — `car` sous `traffic behavior` — se discrimine contre
 * le lot precedent : 2 de ses 4 cas tombent (la commande etait refusee,
 * et le seau etroit ne jetait rien). Les 2 autres passent des deux cotes
 * et sont nommes ici : le refus d'une valeur malformee, qui avant venait
 * du refus de `car` tout entier, et le seau large, qui est le TEMOIN du
 * cas precedent.
 */
describe('le comportement sait aussi POLICER', () => {
  const CAR = [
    'traffic classifier tc2',
    'if-match any',
    'quit',
    'traffic behavior tb2',
    'car cir 1',
    'quit',
    'traffic policy tp2',
    'classifier tc2 behavior tb2',
    'quit',
  ];

  it('`car cir` est accepte, rendu, et lu par la vue', async () => {
    const sw = await commutateur(CAR);
    expect(await sw.executeCommand('display current-configuration'))
      .toContain(' car cir 1');
    expect(await sw.executeCommand('display traffic behavior user-defined'))
      .toContain('CIR 1 (Kbps)');
  });

  it('une valeur malformee est REFUSEE plutot que rangee', async () => {
    const sw = await commutateur(['traffic behavior tb3']);
    expect(await sw.executeCommand('car zorglub')).toContain('Error');
    expect(await sw.executeCommand('display current-configuration'))
      .not.toContain('car zorglub');
  });

  it('un seau plus petit qu une trame jette VRAIMENT le trafic', async () => {
    const { sw, a } = await laboFiltre([]);
    for (const c of ['system-view', ...CAR,
      'interface GigabitEthernet0/0/1', 'traffic-policy tp2 inbound', 'quit']) {
      await sw.executeCommand(c);
    }
    expect(perdu(await a.executeCommand('ping -c 1 10.0.0.2'))).toBe(true);
  });

  it('un seau large laisse passer — TEMOIN de la mesure precedente', async () => {
    const { sw, a } = await laboFiltre([]);
    for (const c of ['system-view',
      'traffic classifier tc3', 'if-match any', 'quit',
      'traffic behavior tb4', 'car cir 100000', 'quit',
      'traffic policy tp3', 'classifier tc3 behavior tb4', 'quit',
      'interface GigabitEthernet0/0/1', 'traffic-policy tp3 inbound', 'quit']) {
      await sw.executeCommand(c);
    }
    expect(perdu(await a.executeCommand('ping -c 1 10.0.0.2'))).toBe(false);
  });
});
