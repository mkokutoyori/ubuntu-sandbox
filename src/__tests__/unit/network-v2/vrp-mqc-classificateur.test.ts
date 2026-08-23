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

/**
 * Le troisieme volet — `remark dscp` — n'est PAS decoratif, contrairement
 * a ce que le TODO annoncait : `ACLEngine` compare deja le champ DSCP
 * d'un paquet (`(tos >> 2) & 0x3f`), donc une marque posee au niveau du
 * MQC est vue par une liste d'acces posee en aval. La sonde le mesure
 * ainsi plutot que sur la seule vue.
 *
 * Discrimine contre le lot precedent : 3 de ses 5 cas tombent. Les 2 qui
 * passent des deux cotes sont le TEMOIN, dont l'objet est qu'un paquet
 * NON marque ne corresponde pas, et le refus d'une valeur hors bornes,
 * qui avant venait du refus de `remark` tout entier.
 */
describe('le comportement sait MARQUER, et la marque se lit en aval', () => {
  /**
   * La marque est posee par la politique du VLAN, qui s'evalue AVANT
   * celle du port ; le filtre est sur le port. Une seule trame est donc
   * marquee puis filtree, ce qui mesure la marque sur le paquet et non
   * sur la vue.
   */
  async function laboMarque(comportement: readonly string[]): Promise<Labo> {
    const labo = await laboFiltre([]);
    for (const c of ['system-view',
      'traffic classifier tcm', 'if-match any', 'quit',
      'traffic behavior tbm', ...comportement, 'quit',
      'traffic policy tpm', 'classifier tcm behavior tbm', 'quit',
      'vlan 10', 'traffic-policy tpm inbound', 'quit',
      'acl 3900', 'rule 5 permit ip dscp af11', 'quit',
      'traffic classifier tcf', 'if-match acl 3900', 'quit',
      'traffic behavior tbf', 'deny', 'quit',
      'traffic policy tpf', 'classifier tcf behavior tbf', 'quit',
      'interface GigabitEthernet0/0/1', 'traffic-policy tpf inbound', 'quit',
    ]) await labo.sw.executeCommand(c);
    return labo;
  }

  it('`remark dscp` est accepte, rendu, et lu par la vue', async () => {
    const sw = await commutateur([
      'traffic behavior tbr', 'remark dscp af11', 'quit',
    ]);
    expect(await sw.executeCommand('display current-configuration'))
      .toContain(' remark dscp 10');
    expect(await sw.executeCommand('display traffic behavior user-defined'))
      .toContain('remark dscp 10');
  });

  it('`remark 8021p` aussi', async () => {
    const sw = await commutateur(['traffic behavior tbp', 'remark 8021p 5', 'quit']);
    expect(await sw.executeCommand('display current-configuration'))
      .toContain(' remark 8021p 5');
  });

  it('une valeur hors bornes est refusee', async () => {
    const sw = await commutateur(['traffic behavior tbx']);
    expect(await sw.executeCommand('remark dscp 99')).toContain('Error');
    expect(await sw.executeCommand('remark 8021p 9')).toContain('Error');
    expect(await sw.executeCommand('remark zorglub 1')).toContain('Error');
  });

  it('TEMOIN — sans marque, la liste d acces en aval laisse passer', async () => {
    const { a } = await laboMarque(['permit']);
    expect(perdu(await a.executeCommand('ping -c 1 10.0.0.2'))).toBe(false);
  });

  it('marque par le MQC, le paquet est reconnu par la liste d acces en aval', async () => {
    const { a } = await laboMarque(['remark dscp af11']);
    expect(perdu(await a.executeCommand('ping -c 1 10.0.0.2'))).toBe(true);
  });
});

/**
 * Le quatrieme volet — `statistic enable` — mesure ce que la politique a
 * VU passer, et le compteur suit la meme cle que le seau CAR : point
 * d'application, classificateur, comportement. Une politique posee a
 * deux endroits compte deux fois, comme sur une vraie machine.
 *
 * Discrimine contre le lot precedent : les 5 cas tombent, TEMOIN
 * compris — non parce que le comportement differait, mais parce que la
 * vue elle-meme est neuve et qu'aucun de ses cas n'etait atteignable.
 * Ce que le TEMOIN mesure — une vue demandee la ou aucune politique
 * n'est posee doit le DIRE — reste ce qu'il dit.
 */
describe('le comportement sait COMPTER', () => {
  const COMPTE = [
    'traffic classifier tcs', 'if-match any', 'quit',
    'traffic behavior tbs', 'deny', 'statistic enable', 'quit',
    'traffic policy tps', 'classifier tcs behavior tbs', 'quit',
  ];

  it('`statistic enable` est accepte et rendu', async () => {
    const sw = await commutateur(COMPTE);
    expect(await sw.executeCommand('display current-configuration'))
      .toContain(' statistic enable');
    expect(await sw.executeCommand('display traffic behavior user-defined'))
      .toContain('statistic: enable');
  });

  it('le compteur avance avec le trafic REELLEMENT vu', async () => {
    const { sw, a } = await laboFiltre([]);
    for (const c of ['system-view', ...COMPTE,
      'interface GigabitEthernet0/0/1', 'traffic-policy tps inbound', 'quit']) {
      await sw.executeCommand(c);
    }
    await a.executeCommand('ping -c 1 10.0.0.2');

    const vue = await sw.executeCommand(
      'display traffic policy statistics interface GigabitEthernet0/0/1');
    expect(vue).toContain('tcs');
    expect(vue).toMatch(/Matched\s+: [1-9]\d* packets/);
    expect(vue).toMatch(/Dropped\s+: [1-9]\d* packets/);
  });

  it('sans `statistic enable`, la vue le dit au lieu d inventer un zero', async () => {
    const { sw, a } = await laboFiltre([
      'interface GigabitEthernet0/0/1', 'traffic-policy tp1 inbound', 'quit',
    ]);
    await a.executeCommand('ping -c 1 10.0.0.2');
    expect(await sw.executeCommand(
      'display traffic policy statistics interface GigabitEthernet0/0/1'))
      .toContain('statistics not enabled');
  });

  it('TEMOIN — sur un point sans politique, la vue le dit', async () => {
    const { sw } = await laboFiltre([]);
    expect(await sw.executeCommand(
      'display traffic policy statistics interface GigabitEthernet0/0/1'))
      .toContain('not applied');
  });

  it('le meme comportement pose a DEUX endroits compte separement', async () => {
    const { sw, a, b } = await laboFiltre([]);
    for (const c of ['system-view',
      'traffic classifier tcd', 'if-match any', 'quit',
      'traffic behavior tbd', 'permit', 'statistic enable', 'quit',
      'traffic policy tpd', 'classifier tcd behavior tbd', 'quit',
      'interface GigabitEthernet0/0/1', 'traffic-policy tpd inbound', 'quit',
      'interface GigabitEthernet0/0/2', 'traffic-policy tpd inbound', 'quit']) {
      await sw.executeCommand(c);
    }
    await a.executeCommand('ping -c 1 10.0.0.2');
    await b.executeCommand('ping -c 1 10.0.0.1');

    const un = await sw.executeCommand(
      'display traffic policy statistics interface GigabitEthernet0/0/1');
    const deux = await sw.executeCommand(
      'display traffic policy statistics interface GigabitEthernet0/0/2');
    expect(un).toMatch(/Matched\s+: [1-9]\d* packets/);
    expect(deux).toMatch(/Matched\s+: [1-9]\d* packets/);
  });
});
