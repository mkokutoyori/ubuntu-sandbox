/**
 * Une clause de politique VRP porte une valeur, pas un mot.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference :
 *
 *   [route-policy]  apply cost <cout>
 *                   apply preference <preference>
 *                   apply tag <etiquette>
 *                   apply local-preference <preference>
 *                   apply ip-address next-hop <adresse>
 *                   if-match cost <cout> / if-match tag <etiquette>
 *                   if-match acl <numero> / if-match ip-prefix <nom>
 *
 *   [classificateur] if-match dscp <0-63>
 *                    if-match ip-precedence <0-7>
 *                    if-match vlan <1-4094>
 *                    if-match acl <numero>
 *
 *   [comportement]   car cir <debit>
 *                    remark dscp <0-63>
 *
 * Les bornes viennent du PROTOCOLE : DSCP fait six bits (RFC 2474 §3),
 * la precedence IP en fait trois (RFC 791 §3.1), un identifiant de VLAN
 * va de 1 a 4094 (IEEE 802.1Q), et un cout, une etiquette comme une
 * preference locale en font trente-deux.
 *
 * Mesure de depart sur un routeur Huawei, en relisant la configuration :
 * ONZE places ecrivent `NaN` dans une configuration REJOUEE a l'import
 * d'une topologie.
 *
 *   apply cost zorglub            -> ACCEPTE, rendu ` apply cost NaN`
 *   apply preference zorglub      -> ACCEPTE, rendu ` apply preference NaN`
 *   apply tag zorglub             -> ACCEPTE, rendu ` apply tag NaN`
 *   apply local-preference zorglub-> ACCEPTE, rendu `… local-preference NaN`
 *   if-match tag zorglub          -> ACCEPTE, rendu ` if-match tag NaN`
 *   if-match dscp zorglub         -> ACCEPTE, rendu ` if-match dscp NaN`
 *   if-match acl zorglub          -> ACCEPTE, rendu ` if-match acl NaN`
 *   if-match vlan zorglub         -> ACCEPTE, rendu ` if-match vlan NaN`
 *   if-match ip-precedence zorglub-> ACCEPTE, rendu `… ip-precedence NaN`
 *   car cir zorglub               -> ACCEPTE, rendu ` car cir NaN`
 *   remark dscp zorglub           -> ACCEPTE, rendu ` remark dscp NaN`
 *
 * Et QUATRE places sont pires que rangees a tort : elles sont acceptees
 * et JETEES — `apply zorglub 5`, `if-match zorglub 5`, `if-match cost
 * zorglub` et `if-match route-type zorglub` ne laissent aucune trace,
 * donc la machine dit oui a une clause qu'elle n'a pas retenue et la
 * configuration ne reproduit pas ce qui a ete tape.
 *
 * C'est le lot JUMEAU de celui qui vient de fermer les clauses `set` et
 * `match` d'IOS, et il n'en est PAS une copie : le vocabulaire de VRP est
 * le sien (`apply ip-address next-hop`, `apply preference`,
 * `if-match ip-prefix`, `if-match vlan`), et une table Cisco lue par un
 * gestionnaire Huawei accepterait ici des mots que la machine refuse et
 * refuserait ceux qu'elle accepte.
 *
 * TROUVE EN ECRIVANT LA SONDE, et corrige avec : `if-match route-type`
 * etait accepte et JETE alors que le magasin porte le champ ET que
 * `RoutePolicy.matches` le LIT — c'est-a-dire un critere que le moteur
 * evalue vraiment, perdu entre la frappe et le magasin. `if-match cost`
 * n'avait, lui, aucun champ ; il en a un desormais et rejoint la liste
 * des criteres qui font ECHOUER FERME le noeud qui les nomme, la regle
 * que ce fichier applique deja pour `acl`, `community` et `interface` —
 * un critere qu'on ne sait pas evaluer ne doit pas rendre la politique
 * plus permissive.
 *
 * Discrimine par `git stash` sur les trois fichiers cables : 24 des 38
 * cas tombent avant correctif. Les 14 autres sont nommes ici :
 *
 *   - les DOUZE cas de valeur juste — six clauses de route-policy, le
 *     saut suivant, quatre places du classificateur, `if-match any`, et
 *     les deux du comportement : un analyseur qui acceptait TOUT les
 *     acceptait deja. Ce sont les TEMOINS, et ce sont eux qui verifient
 *     que le vocabulaire declare est COMPLET — sans eux, un correctif
 *     qui refuserait tout, ou qui oublierait `acl-ipv6` ou `pbs`,
 *     satisferait la sonde ;
 *   - `if-match ip-prefix PL` et `if-match acl 2000`, meme raison.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS, chacun mesure plutot
 * que suppose :
 *
 *   - une BORNE HAUTE a `apply preference` et a `car cir`. La premiere
 *     est une distance administrative et la seconde un debit en kbit/s,
 *     toutes deux bornees par la PLATEFORME ; la documentation de Huawei
 *     n'est pas atteignable depuis ce reseau, donc seule la certitude
 *     « c'est un nombre » est appliquee. Inscrit au `TODO.md` ;
 *   - l'orthographe `if-match vlan` du classificateur, que ce simulateur
 *     accepte la ou VRP ecrit `if-match vlan-id`. Changer le mot ACCEPTE
 *     sans capture serait remplacer une invention par une autre ; seule
 *     la VALEUR est jugee ici.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
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

const routeur = (n: string) => new HuaweiRouter(n) as unknown as Dev;

async function dansLaVue(d: Dev, vue: string, ...cmds: string[]): Promise<string> {
  let last = '';
  for (const c of ['system-view', vue, ...cmds]) {
    last = String(await d.executeCommand(c));
  }
  return last;
}

async function config(d: Dev): Promise<string> {
  await d.executeCommand('quit');
  await d.executeCommand('quit');
  return String(await d.executeCommand('display current-configuration'));
}

const POLITIQUE = 'route-policy RP permit node 10';
const CLASSIFICATEUR = 'traffic classifier TC';
const COMPORTEMENT = 'traffic behavior TB';
const cle = (s: string) => s.replace(/\W/g, '');

describe('une clause de route-policy porte un nombre', () => {
  const PLACES: ReadonlyArray<readonly [string, string]> = [
    ['apply cost', '100'],
    ['apply preference', '50'],
    ['apply tag', '4242'],
    ['apply local-preference', '200'],
    ['if-match cost', '100'],
    ['if-match tag', '4242'],
  ];

  it.each(PLACES)('`%s zorglub` est refuse', async (clause) => {
    const d = routeur(`P${cle(clause)}`);
    expect(await dansLaVue(d, POLITIQUE, `${clause} zorglub`)).toContain('Error');
  });

  it.each(PLACES)('`%s %s` reste accepte et RELU', async (clause, bon) => {
    const d = routeur(`PO${cle(clause)}`);
    expect(await dansLaVue(d, POLITIQUE, `${clause} ${bon}`)).not.toContain('Error');
    expect(await config(d)).toContain(`${clause} ${bon}`);
  });

  it('et aucun `NaN` n entre dans la configuration', async () => {
    const d = routeur('PN');
    for (const [clause] of PLACES) await dansLaVue(d, POLITIQUE, `${clause} zorglub`);
    const cfg = await config(d);
    expect(cfg).not.toContain('NaN');
    expect(cfg).not.toContain('zorglub');
  });
});

describe('un saut suivant de route-policy est une adresse', () => {
  it.each(['zorglub', '999.1.1.1'])(
    '`apply ip-address next-hop %s` est refuse', async (mot) => {
      const d = routeur(`H${cle(mot)}`);
      expect(await dansLaVue(d, POLITIQUE,
        `apply ip-address next-hop ${mot}`)).toContain('Error');
    });

  it('`apply ip-address next-hop 10.0.0.1` reste accepte et RELU', async () => {
    const d = routeur('HO');
    expect(await dansLaVue(d, POLITIQUE,
      'apply ip-address next-hop 10.0.0.1')).not.toContain('Error');
    expect(await config(d)).toContain('apply ip-address next-hop 10.0.0.1');
  });
});

describe('un genre de clause qui n existe pas est refuse au lieu d etre jete', () => {
  it.each(['apply zorglub 5', 'if-match zorglub 5'])('`%s` est refuse', async (ligne) => {
    const d = routeur(`G${cle(ligne)}`);
    expect(await dansLaVue(d, POLITIQUE, ligne)).toContain('Error');
  });

  it('`if-match ip-prefix PL` et `if-match acl 2000` restent acceptes', async () => {
    const d = routeur('GO');
    expect(await dansLaVue(d, POLITIQUE, 'if-match ip-prefix PL')).not.toContain('Error');
    expect(await dansLaVue(d, POLITIQUE, 'if-match acl 2000')).not.toContain('Error');
  });
});

describe('un classificateur de trafic porte des valeurs bornees par le protocole', () => {
  const PLACES: ReadonlyArray<readonly [string, string, string]> = [
    ['if-match dscp', '46', '64'],
    ['if-match ip-precedence', '6', '8'],
    ['if-match vlan', '10', '4095'],
    ['if-match acl', '3000', ''],
  ];

  it.each(PLACES)('`%s zorglub` est refuse', async (clause) => {
    const d = routeur(`C${cle(clause)}`);
    expect(await dansLaVue(d, CLASSIFICATEUR, `${clause} zorglub`)).toContain('Error');
  });

  it.each(PLACES)('`%s %s` reste accepte et RELU', async (clause, bon) => {
    const d = routeur(`CO${cle(clause)}`);
    expect(await dansLaVue(d, CLASSIFICATEUR, `${clause} ${bon}`)).not.toContain('Error');
    expect(await config(d)).toContain(`${clause} ${bon}`);
  });

  it.each(PLACES.filter((p) => p[2] !== ''))(
    '`%s` au-dela de sa borne est refuse', async (clause, _bon, trop) => {
      const d = routeur(`CB${cle(clause)}`);
      expect(await dansLaVue(d, CLASSIFICATEUR, `${clause} ${trop}`)).toContain('Error');
    });

  it('`if-match any` reste accepte', async () => {
    const d = routeur('CA');
    expect(await dansLaVue(d, CLASSIFICATEUR, 'if-match any')).not.toContain('Error');
  });

  it('et aucun `NaN` n entre dans la configuration', async () => {
    const d = routeur('CN');
    for (const [clause] of PLACES) {
      await dansLaVue(d, CLASSIFICATEUR, `${clause} zorglub`);
    }
    expect(await config(d)).not.toContain('NaN');
  });
});

describe('un comportement de trafic porte un debit et un DSCP', () => {
  it.each(['car cir zorglub', 'remark dscp zorglub'])('`%s` est refuse', async (ligne) => {
    const d = routeur(`B${cle(ligne)}`);
    expect(await dansLaVue(d, COMPORTEMENT, ligne)).toContain('Error');
  });

  it('`remark dscp 64` est refuse', async () => {
    const d = routeur('BD');
    expect(await dansLaVue(d, COMPORTEMENT, 'remark dscp 64')).toContain('Error');
  });

  it.each(['car cir 1000', 'remark dscp 46'])('`%s` reste accepte et RELU', async (ligne) => {
    const d = routeur(`BO${cle(ligne)}`);
    expect(await dansLaVue(d, COMPORTEMENT, ligne)).not.toContain('Error');
    expect(await config(d)).toContain(ligne);
  });

  it('et aucun `NaN` n entre dans la configuration', async () => {
    const d = routeur('BN');
    await dansLaVue(d, COMPORTEMENT, 'car cir zorglub', 'remark dscp zorglub');
    expect(await config(d)).not.toContain('NaN');
  });
});
