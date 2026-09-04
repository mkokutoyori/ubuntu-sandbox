/**
 * `vrf definition` n'est pas `ip vrf`, et une VRF se RELIT entiere.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference :
 * `vrf definition <nom>` est la forme MULTIPROTOCOLE d'IOS et `ip vrf
 * <nom>` la forme heritee ; elles ne sont pas synonymes, et un nom de
 * VRF tient en 32 caracteres. Sous l'une comme sous l'autre,
 * `rd <ASN:nn | A.B.C.D:nn>` et
 * `route-target {import | export | both} <ASN:nn | A.B.C.D:nn>`.
 *
 * Mesure de depart sur un routeur, en relisant la configuration :
 *
 *   vrf definition CLIENT-A          -> rendu `ip vrf CLIENT-A`
 *   route-target export 65000:200    -> ACCEPTE, rendu NULLE PART
 *   route-target import zorglub      -> ACCEPTE
 *   rd zorglub                       -> refuse (donc les deux moities
 *                                       d'une meme syntaxe ne sont pas
 *                                       jugees pareil)
 *   vrf definition <50 caracteres>   -> ACCEPTE
 *
 * et sur un commutateur :
 *
 *   vrf definition CLIENT-A          -> ACCEPTE, `show vrf` la liste,
 *                                       la configuration rend RIEN
 *
 * Deux consequences qui depassent l'affichage, la configuration rendue
 * etant REJOUEE a l'import d'une topologie : la forme multiprotocole
 * revient en forme heritee, et les cibles de routage — c'est-a-dire ce
 * qui fait qu'une VRF echange ses routes avec une autre — disparaissent
 * entierement.
 *
 * Discrimine par `git stash` sur les cinq fichiers cables : 13 des 19
 * cas tombent avant correctif. Les 6 autres sont nommes ici :
 *
 *   - `ip vrf` revient `ip vrf` : c'est le TEMOIN, la forme heritee
 *     etait la SEULE que le rendu savait ecrire, donc elle etait juste
 *     par accident et doit le rester par decision ;
 *   - `rd zorglub` deja refuse, et `both`/`import`/`export` acceptes :
 *     ils bornent le refus ajoute a `route-target`, sans quoi un
 *     analyseur refusant TOUT satisferait la sonde ;
 *   - la forme `A.B.C.D:nn` d'une `route-target`, qui passait parce que
 *     RIEN n'etait juge de ce cote ;
 *   - un nom de 32 caracteres accepte, et `show vrf` qui liste la VRF et
 *     son RD : ce que la famille faisait deja et que ce lot ne doit pas
 *     casser.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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
const commutateur = (n: string) => new CiscoSwitch('switch-cisco', n) as unknown as Dev;

async function conf(d: Dev, ...cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of ['enable', 'configure terminal', ...cmds]) {
    out.push(String(await d.executeCommand(c)));
  }
  return out.slice(2);
}

async function bloc(d: Dev): Promise<string[]> {
  await d.executeCommand('end');
  const cfg = String(await d.executeCommand('show running-config'));
  await d.executeCommand('configure terminal');
  return cfg.split('\n')
    .filter((l) => /^(ip vrf|vrf definition)|^\s+(rd|route-target)/.test(l))
    .map((l) => l.replace(/\s+$/, ''));
}

describe('la forme ecrite est la forme rendue', () => {
  it('`vrf definition` revient `vrf definition`, pas `ip vrf`', async () => {
    const d = routeur('RA');
    await conf(d, 'vrf definition CLIENT-A', 'rd 65000:100', 'exit');
    const lignes = await bloc(d);
    expect(lignes).toContain('vrf definition CLIENT-A');
    expect(lignes).not.toContain('ip vrf CLIENT-A');
  });

  it('et `ip vrf` revient `ip vrf`, pas `vrf definition`', async () => {
    const d = routeur('RB');
    await conf(d, 'ip vrf CLIENT-B', 'rd 65000:200', 'exit');
    const lignes = await bloc(d);
    expect(lignes).toContain('ip vrf CLIENT-B');
    expect(lignes).not.toContain('vrf definition CLIENT-B');
  });

  it('les deux formes coexistent sur la meme machine', async () => {
    const d = routeur('RC');
    await conf(d,
      'vrf definition NEUVE', 'rd 65000:1', 'exit',
      'ip vrf HERITEE', 'rd 65000:2', 'exit');
    const lignes = await bloc(d);
    expect(lignes).toContain('vrf definition NEUVE');
    expect(lignes).toContain('ip vrf HERITEE');
  });
});

describe('`route-target` est retenue, jugee, et RELUE', () => {
  it('elle revient dans la configuration', async () => {
    const d = routeur('TA');
    await conf(d,
      'vrf definition CLIENT-A', 'rd 65000:100',
      'route-target export 65000:100', 'route-target import 65000:200', 'exit');
    const lignes = (await bloc(d)).map((l) => l.trim());
    expect(lignes).toContain('route-target export 65000:100');
    expect(lignes).toContain('route-target import 65000:200');
  });

  it('`both` pose les deux sens, comme sur IOS', async () => {
    const d = routeur('TB');
    await conf(d,
      'vrf definition CLIENT-A', 'rd 65000:100',
      'route-target both 65000:100', 'exit');
    const lignes = (await bloc(d)).map((l) => l.trim());
    expect(lignes).toContain('route-target export 65000:100');
    expect(lignes).toContain('route-target import 65000:100');
  });

  const MAUVAISES = [
    'route-target import zorglub',
    'route-target export 65000',
    'route-target export 65000:zorglub',
    'route-target zorglub 65000:100',
  ];

  it.each(MAUVAISES)('`%s` est refuse, comme `rd zorglub` l est deja', async (cmd) => {
    const d = routeur(`TM${MAUVAISES.indexOf(cmd)}`);
    const [, , out] = await conf(d, 'vrf definition CLIENT-A', 'rd 65000:100', cmd);
    expect(out).toContain('%');
  });

  it('et un refus ne laisse AUCUNE cible dans la configuration', async () => {
    const d = routeur('TR');
    await conf(d, 'vrf definition CLIENT-A', 'rd 65000:100', ...MAUVAISES, 'exit');
    expect((await bloc(d)).join('\n')).not.toContain('route-target');
  });

  it('la forme A.B.C.D:nn reste acceptee', async () => {
    const d = routeur('TI');
    const [, , out] = await conf(d,
      'vrf definition CLIENT-A', 'rd 65000:100', 'route-target export 192.168.1.1:100');
    expect(out).not.toContain('%');
  });
});

describe('`rd` garde son jugement, et la meme syntaxe', () => {
  it('`rd zorglub` reste refuse', async () => {
    const d = routeur('DA');
    const [, out] = await conf(d, 'vrf definition CLIENT-A', 'rd zorglub');
    expect(out).toContain('%');
  });

  it('et les deux formes valides restent acceptees', async () => {
    const d = routeur('DB');
    for (const rd of ['65000:100', '192.168.1.1:100']) {
      const [, out] = await conf(d, `vrf definition V${rd.length}`, `rd ${rd}`);
      expect(out, rd).not.toContain('%');
    }
  });
});

describe('un nom de VRF tient en 32 caracteres', () => {
  it('un nom plus long est refuse', async () => {
    const d = routeur('NA');
    const [out] = await conf(d, `vrf definition ${'A'.repeat(33)}`);
    expect(out).toContain('%');
  });

  it('exactement 32 reste accepte', async () => {
    const d = routeur('NB');
    const [out] = await conf(d, `vrf definition ${'A'.repeat(32)}`);
    expect(out).not.toContain('%');
  });
});

describe('le commutateur RELIT ce qu il accepte', () => {
  it('sa VRF revient dans la configuration', async () => {
    const d = commutateur('SA');
    await conf(d, 'vrf definition CLIENT-A', 'exit');
    expect(await bloc(d)).toContain('vrf definition CLIENT-A');
  });

  it('et il juge le nom comme le routeur', async () => {
    const d = commutateur('SB');
    const [out] = await conf(d, `vrf definition ${'A'.repeat(33)}`);
    expect(out).toContain('%');
  });
});

/*
 * SUITE — la famille est passee au socle, et la migration a trouve trois
 * defauts que cette sonde ne demandait pas. Ils sont ajoutes ICI plutot
 * que dans une seconde sonde : c'est la meme commande.
 *
 * (1) `ip vrf` etait enregistree par la famille NAT, donc ROUTEUR SEUL :
 * la meme frappe etait acceptee sur un routeur et REFUSEE sur un
 * Catalyst, alors que VRF-lite est justement une fonction de
 * commutateur. Cette sonde n'eprouvait le commutateur qu'avec la forme
 * moderne, la seule que la coquille commune portait.
 *
 * (2) `vrf` TOUT COURT etait un noeud GLOUTON qui rangeait la ligne et
 * rendait la main sans un mot : `vrf`, `vrf zorglub` et `vrf forwarding
 * X` en configuration GLOBALE etaient tous acceptes, ranges et rendus
 * dans la configuration — donc rejoues a l'import d'une topologie.
 *
 * (3) `vrf definition NOM zorglub` avalait le mot de trop.
 *
 * Discrimine dans un arbre de travail pose sur l'etat d'AVANT plutot
 * qu'en remisant : 7 des 11 cas ajoutes par ce lot tombent. Les quatre
 * autres sont nommes ici — `ip vrf` seul etait DEJA incomplet ; `ip vrf
 * NOM zorglub` etait DEJA refuse, sa place ayant ete declaree par la
 * famille NAT ; `no ip vrf` sur un commutateur passait A VIDE, la VRF
 * n'ayant pas pu y etre creee, donc le cas ne prouvait rien avant et
 * garde la suppression maintenant ; et « `ip vrf` revient `ip vrf` » sur
 * le routeur est le TEMOIN de l'orthographe, deja juste.
 */
describe('les deux orthographes existent sur les DEUX plateformes', () => {
  it('`ip vrf` est acceptee par un commutateur aussi', async () => {
    const d = commutateur('SC');
    const [out] = await conf(d, 'ip vrf CLIENT-A');
    expect(out, out).not.toContain('%');
  });

  it('et elle y revient `ip vrf`, pas `vrf definition`', async () => {
    const d = commutateur('SD');
    await conf(d, 'ip vrf CLIENT-A', 'exit');
    const lignes = await bloc(d);
    expect(lignes).toContain('ip vrf CLIENT-A');
    expect(lignes).not.toContain('vrf definition CLIENT-A');
  });

  it('`no ip vrf` y retire aussi', async () => {
    const d = commutateur('SE');
    await conf(d, 'ip vrf CLIENT-A', 'exit', 'no ip vrf CLIENT-A');
    expect((await bloc(d)).join('\n')).not.toContain('CLIENT-A');
  });
});

describe('`vrf` seul ne range rien', () => {
  it.each(['vrf', 'ip vrf'])('`%s` est INCOMPLETE', async (cmd) => {
    const d = routeur(`VI${cmd.length}`);
    const [out] = await conf(d, cmd);
    expect(out, out).toContain('% Incomplete');
  });

  it.each(['vrf zorglub', 'vrf forwarding CLIENT-A',
    'vrf definition CLIENT-A zorglub', 'ip vrf CLIENT-A zorglub'])(
    '`%s` est REFUSE', async (cmd) => {
      const d = routeur(`VR${cmd.length}${cmd.slice(-3)}`);
      const [out] = await conf(d, cmd);
      expect(out, out).toContain('% Invalid');
    });

  it('et aucun de ces refus ne laisse de ligne dans la configuration', async () => {
    const d = routeur('VZ');
    await conf(d, 'vrf', 'vrf zorglub', 'vrf forwarding CLIENT-A',
      'vrf definition CLIENT-A zorglub');
    await d.executeCommand('end');
    const cfg = String(await d.executeCommand('show running-config'));
    expect(cfg).not.toContain('zorglub');
    expect(cfg).not.toContain('vrf forwarding');
  });
});

describe('non-regression — ce que la famille faisait deja', () => {
  it('`show vrf` liste toujours la VRF et son RD', async () => {
    const d = routeur('XA');
    await conf(d, 'vrf definition CLIENT-A', 'rd 65000:100', 'exit');
    await d.executeCommand('end');
    const vue = String(await d.executeCommand('show vrf'));
    expect(vue).toContain('CLIENT-A');
    expect(vue).toContain('65000:100');
  });

  it('`no vrf definition` retire toujours', async () => {
    const d = routeur('XB');
    await conf(d, 'vrf definition CLIENT-A', 'rd 65000:100', 'exit',
      'no vrf definition CLIENT-A');
    expect((await bloc(d)).join('\n')).not.toContain('CLIENT-A');
  });
});
