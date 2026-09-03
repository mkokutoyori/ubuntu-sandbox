/**
 * Un identifiant de routeur BGP est un quadruplet, et un sac de texte
 * n'est pas une excuse pour ne rien juger.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference :
 *
 *   router bgp <asn>
 *     bgp router-id <A.B.C.D>
 *     bgp timers <keepalive> <holdtime>
 *   router eigrp <n>
 *     redistribute ospf <identifiant de processus>
 *   router rip
 *     offset-list <liste> {in | out} <decalage> [<interface>]
 *
 * L'identifiant BGP fait QUATRE octets (RFC 4271 §4.2, « BGP
 * Identifier ») et s'ecrit en quadruplet pointe — fait de protocole. Les
 * minuteurs, le decalage et l'identifiant de processus sont des nombres,
 * et la direction d'une `offset-list` est `in` ou `out`.
 *
 * Mesure de depart sur un routeur, en relisant la configuration :
 *
 *   bgp router-id zorglub     -> ACCEPTE, pose comme IDENTIFIANT, rendu
 *   bgp timers zorglub 180    -> ACCEPTE, rendu tel quel
 *   redistribute ospf zorglub -> ACCEPTE, rendu tel quel
 *   offset-list 1 in zorglub  -> ACCEPTE, rendu tel quel
 *   offset-list 1 zorglub 5   -> ACCEPTE, rendu tel quel
 *
 * `bgp router-id` est le cas le plus net : la commande NUE `router-id`,
 * dans le meme fichier, juge son argument par `isValidIPv4` — c'est le
 * MEME fait ecrit deux fois, et c'est la seconde ecriture, celle prefixee
 * de `bgp`, qui ne juge rien. L'identifiant est ce qui distingue deux
 * routeurs dans une session BGP.
 *
 * La consequence depasse l'affichage : la configuration rendue est
 * REJOUEE a l'import d'une topologie.
 *
 * UN PIEGE DE LA SONDE ELLE-MEME, ecrit ici parce qu'il a failli la
 * rendre vacue : chercher `%` dans la reponse NE SUFFIT PAS pour
 * `redistribute`, qui rend deja `% Warning: Redistributing without
 * default metric` — un avertissement legitime d'IOS, pas un refus. La
 * premiere version de ce cas passait sur l'avertissement et ne prouvait
 * rien ; il exige `% Invalid`. C'est la meme forme que le
 * `/0% packet loss/` du lot NAT, qui correspondait aussi a
 * `100% packet loss`.
 *
 * Ce que la sonde ne demande PAS : que `bgp <option>` inconnue soit
 * refusee. Le sac de texte est une decision ECRITE dans le gestionnaire
 * — une option de durcissement que le simulateur ne modelise pas doit
 * survivre au rechargement plutot que disparaitre —, la meme que pour
 * `ip ssh server algorithm`. Ce lot juge les options dont la GRAMMAIRE
 * est connue, et laisse le sac faire son travail pour les autres.
 *
 * Discrimine par `git stash` sur le SEUL fichier cable : 13 des 23 cas
 * tombent avant correctif. Les 10 autres sont nommes ici :
 *
 *   - `router-id zorglub` sous sa forme NUE : elle etait DEJA refusee, et
 *     c'est tout le propos — le meme fait etait ecrit deux fois, et seule
 *     la copie prefixee de `bgp` ne jugeait rien. Ce cas est le TEMOIN
 *     qui montre que le refus existait a cote ;
 *   - les quatre valeurs justes (`router-id 1.1.1.1`, `timers 60 180`,
 *     `redistribute ospf 1 metric …`, `offset-list 1 in 5`) : elles
 *     bornent le refus ajoute — sans elles, refuser TOUT satisferait la
 *     sonde ;
 *   - `redistribute static` sans identifiant : la regle ajoutee ne vaut
 *     que pour les protocoles qui EN PRENNENT un, et ce cas le verifie ;
 *   - les trois cas du sac de texte (`log-neighbor-changes`,
 *     `deterministic-med`, le processus complet) : ils gardent la
 *     decision de NE PAS refuser ce dont la grammaire est inconnue.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Dev = { executeCommand(c: string): Promise<string> };

const routeur = (n: string) => new CiscoRouter(n) as unknown as Dev;

async function conf(d: Dev, ...cmds: string[]): Promise<string> {
  let last = '';
  for (const c of ['enable', 'configure terminal', ...cmds]) {
    last = String(await d.executeCommand(c));
  }
  return last;
}

async function config(d: Dev): Promise<string> {
  await d.executeCommand('end');
  const cfg = String(await d.executeCommand('show running-config'));
  await d.executeCommand('configure terminal');
  return cfg;
}

describe('un identifiant de routeur BGP est un quadruplet', () => {
  const IMPOSSIBLES = ['zorglub', '1.1.1', '256.1.1.1', '1.1.1.1.1'];

  it.each(IMPOSSIBLES)('`bgp router-id %s` est refuse', async (id) => {
    const d = routeur(`R${IMPOSSIBLES.indexOf(id)}`);
    expect(await conf(d, 'router bgp 65000', `bgp router-id ${id}`)).toContain('%');
  });

  it('et rien n en reste dans la configuration', async () => {
    const d = routeur('RR');
    await conf(d, 'router bgp 65000', ...IMPOSSIBLES.map((i) => `bgp router-id ${i}`));
    expect(await config(d)).not.toContain('zorglub');
  });

  it('`bgp router-id 1.1.1.1` reste accepte et RELU', async () => {
    const d = routeur('RO');
    expect(await conf(d, 'router bgp 65000', 'bgp router-id 1.1.1.1')).not.toContain('%');
    expect(await config(d)).toContain('bgp router-id 1.1.1.1');
  });

  it('et la forme NUE juge pareil', async () => {
    const d = routeur('RN');
    expect(await conf(d, 'router bgp 65000', 'router-id zorglub')).toContain('%');
  });
});

describe('les minuteurs BGP sont des nombres', () => {
  const MAUVAISES = [
    'bgp timers zorglub 180',
    'bgp timers 60 zorglub',
    'bgp timers 60',
  ];

  it.each(MAUVAISES)('`%s` est refuse', async (cmd) => {
    const d = routeur(`T${MAUVAISES.indexOf(cmd)}`);
    expect(await conf(d, 'router bgp 65000', cmd)).toContain('%');
  });

  it('`bgp timers 60 180` reste accepte et RELU', async () => {
    const d = routeur('TO');
    expect(await conf(d, 'router bgp 65000', 'bgp timers 60 180')).not.toContain('%');
    expect(await config(d)).toContain('bgp timers 60 180');
  });
});

describe('un identifiant de processus redistribue est un nombre', () => {
  it('`redistribute ospf zorglub` est refuse', async () => {
    const d = routeur('D1');
    expect(await conf(d, 'router eigrp 1', 'redistribute ospf zorglub'))
      .toContain('% Invalid');
  });

  it('et rien n en reste dans la configuration', async () => {
    const d = routeur('D2');
    await conf(d, 'router eigrp 1', 'redistribute ospf zorglub');
    expect(await config(d)).not.toContain('zorglub');
  });

  it('`redistribute ospf 1 metric 1 1 1 1 1` reste accepte et RELU', async () => {
    const d = routeur('D3');
    await conf(d, 'router eigrp 1', 'redistribute ospf 1 metric 1 1 1 1 1');
    expect(await config(d)).toContain('redistribute ospf 1');
  });

  it('`redistribute static` sans identifiant reste accepte', async () => {
    const d = routeur('D4');
    const out = await conf(d, 'router eigrp 1', 'redistribute static');
    expect(out).not.toContain('% Invalid');
  });
});

describe('une offset-list a une direction et un decalage', () => {
  const MAUVAISES = [
    'offset-list 1 in zorglub',
    'offset-list 1 zorglub 5',
    'offset-list 1 in',
  ];

  it.each(MAUVAISES)('`%s` est refuse', async (cmd) => {
    const d = routeur(`F${MAUVAISES.indexOf(cmd)}`);
    expect(await conf(d, 'router rip', cmd)).toContain('%');
  });

  it('et rien n en reste dans la configuration', async () => {
    const d = routeur('FR');
    await conf(d, 'router rip', ...MAUVAISES);
    expect(await config(d)).not.toContain('zorglub');
  });

  it('`offset-list 1 in 5` reste accepte et RELU', async () => {
    const d = routeur('FO');
    expect(await conf(d, 'router rip', 'offset-list 1 in 5')).not.toContain('%');
    expect(await config(d)).toContain('offset-list 1 in 5');
  });
});

describe('non-regression — le sac de texte reste un sac', () => {
  it('`bgp log-neighbor-changes` est accepte et RELU', async () => {
    const d = routeur('SA');
    expect(await conf(d, 'router bgp 65000', 'bgp log-neighbor-changes')).not.toContain('%');
    expect(await config(d)).toContain('bgp log-neighbor-changes');
  });

  it('`bgp deterministic-med` aussi', async () => {
    const d = routeur('SB');
    expect(await conf(d, 'router bgp 65000', 'bgp deterministic-med')).not.toContain('%');
    expect(await config(d)).toContain('bgp deterministic-med');
  });

  it('et un processus BGP complet se relit toujours', async () => {
    const d = routeur('SC');
    await conf(d, 'router bgp 65000', 'bgp router-id 1.1.1.1',
      'neighbor 10.0.0.1 remote-as 65001', 'network 172.16.0.0 mask 255.255.0.0');
    const cfg = await config(d);
    expect(cfg).toContain('router bgp 65000');
    expect(cfg).toContain('neighbor 10.0.0.1 remote-as 65001');
  });
});
