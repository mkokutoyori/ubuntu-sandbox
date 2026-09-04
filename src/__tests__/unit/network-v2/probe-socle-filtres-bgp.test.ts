/**
 * Un filtre BGP qui ne dit ni `permit` ni `deny` ne filtre rien.
 *
 * Sonde ecrite contre la reference IOS, avant lecture des gestionnaires :
 *
 *   ip as-path access-list <1-500> { permit | deny } <expression>
 *   ip community-list { standard | expanded } <nom> { permit | deny } <valeur>
 *   ip community-list <1-500> { permit | deny } <valeur>
 *
 * POURQUOI CETTE FAMILLE. Ce sont les deux dernieres tetes de la
 * configuration COMMUNE aux deux plateformes Cisco qui portent une
 * grammaire — un numero borne, une action, une expression — plutot qu'un
 * simple mot-cle, et c'est donc la que le trie a le plus de chances
 * d'accepter ce qu'il ne lit pas. Les listes de PREFIXES, migrees dans
 * le meme lot, ont deja leur sonde
 * (`probe-socle-prefix-list-route-map.test.ts`) : la seule forme qui leur
 * manquait — `description` — y est ajoutee plutot que redite ici, deux
 * sondes a tenir d'accord sur un meme fait etant le defaut que ce
 * chantier passe son temps a refermer.
 *
 * CE QUE LA MESURE A TROUVE — un seul defaut, ecrit deux fois :
 *
 *   ip as-path access-list 1 zorglub ^$   -> ACCEPTE
 *   ip community-list 1 zorglub 100:1     -> ACCEPTE
 *
 * Les deux gestionnaires recopiaient TOUT ce qui suit le numero comme
 * « regle » (`args.slice(1).join(' ')`), donc le mot qui dit permit ou
 * deny n'etait lu par personne. La consequence n'est pas cosmetique :
 * `show ip as-path-access-list` reaffiche la regle telle qu'elle a ete
 * tapee, faute comprise, donc rien dans la vue ne revele qu'une liste
 * censee refuser laisse passer — et la ligne est rendue dans la
 * configuration, donc rejouee a l'import d'une topologie.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS : que l'expression
 * reguliere soit une expression reguliere valide. Une AS-path regexp
 * accepte `^$`, `_65001_`, `.*` — c'est-a-dire a peu pres n'importe quel
 * texte — et la juger demanderait un analyseur d'expressions que ce
 * simulateur n'a pas ; l'accepter telle quelle est ce que fait la
 * machine reelle jusqu'a l'evaluation.
 *
 * Discrimine par `git stash` sur `src/` : 3 des 26 cas tombent avant
 * migration — les deux ci-dessus, plus la ligne qu'ils laissaient dans
 * la configuration. Les 23 autres passent des deux cotes et le DOIVENT :
 * ce sont les huit formes attestees, les refus de numero hors plage —
 * que le trie appliquait deja par un controle ecrit a la main dans son
 * gestionnaire (`exigerNumeroDeListe`) — la relecture, et l'accord des
 * deux plateformes, qui portaient deja ces commandes toutes les deux.
 * Sans eux, une migration qui perdrait une forme, cesserait de borner le
 * numero ou ne donnerait la famille qu'a une machine satisferait la
 * sonde. `ip community-list zorglub …` en fait partie : `zorglub` n'est
 * ni `standard`, ni `expanded`, ni un numero, donc il etait deja refuse.
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

type Dev = {
  executeCommand(c: string): Promise<string>;
  cliHelp(s: string): string;
};

async function routeur(n: string): Promise<Dev> {
  const d = new CiscoRouter(n) as unknown as Dev;
  for (const c of ['enable', 'configure terminal']) await d.executeCommand(c);
  return d;
}

async function config(d: Dev): Promise<string> {
  await d.executeCommand('end');
  const cfg = String(await d.executeCommand('show running-config'));
  await d.executeCommand('configure terminal');
  return cfg;
}

const cle = (s: string) => s.replace(/\W/g, '');

describe('les formes attestees restent acceptees', () => {
  it.each([
    'ip as-path access-list 1 permit ^$',
    'ip as-path access-list 500 deny _65001_',
    'ip as-path access-list 10 permit .*',
    'ip community-list standard MACOMM permit 100:1',
    'ip community-list standard MACOMM deny 200:2',
    'ip community-list expanded MACOMM permit _100_',
    'ip community-list 1 permit 100:1',
    'ip community-list 500 deny no-export',
  ])('`%s` est accepte', async (ligne) => {
    const d = await routeur(`A${cle(ligne)}`);
    expect(String(await d.executeCommand(ligne))).not.toContain('% Invalid');
  });
});

describe('un numero hors plage est refuse', () => {
  it.each(['ip as-path access-list 0 permit ^$',
    'ip as-path access-list 501 permit ^$',
    'ip as-path access-list zorglub permit ^$',
    'ip community-list 0 permit 100:1',
    'ip community-list 501 permit 100:1'])(
    '`%s` est refuse', async (ligne) => {
      const d = await routeur(`B${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('% Invalid');
    });

  it.each(['ip as-path access-list ', 'ip community-list '])(
    '`%s?` annonce la plage', async (ligne) => {
      const d = await routeur(`C${cle(ligne)}`);
      expect(d.cliHelp(ligne)).toContain('<1-500>');
    });
});

describe('l ACTION est jugee, pas recopiee', () => {
  it.each(['ip as-path access-list 1 zorglub ^$',
    'ip community-list 1 zorglub 100:1',
    'ip community-list zorglub MACOMM permit 100:1'])(
    '`%s` est refuse', async (ligne) => {
      const d = await routeur(`D${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('% Invalid');
    });

  it('et une action refusee ne laisse rien dans la configuration', async () => {
    const d = await routeur('D2');
    await d.executeCommand('ip as-path access-list 1 zorglub ^$');
    expect(await config(d)).not.toContain('zorglub');
  });
});

describe('ce qui est POSE se relit', () => {
  it.each([
    ['ip as-path access-list 1 permit ^$', 'ip as-path access-list 1 permit ^$'],
    ['ip community-list standard MACOMM permit 100:1',
      'ip community-list standard MACOMM permit 100:1'],
    ['ip community-list 1 permit 100:1', 'ip community-list 1 permit 100:1'],
  ])('`%s` est rendu `%s`', async (ligne, attendu) => {
    const d = await routeur(`E${cle(ligne)}`);
    await d.executeCommand(ligne);
    expect(await config(d)).toContain(attendu);
  });

  it('et la vue nomme la sorte de la liste', async () => {
    const d = await routeur('E2');
    await d.executeCommand('ip community-list standard MACOMM permit 100:1');
    await d.executeCommand('end');
    expect(String(await d.executeCommand('show ip community-list')))
      .toContain('Community standard list MACOMM');
  });
});

describe('les DEUX plateformes repondent pareil', () => {
  /*
   * Ces deux commandes etaient enregistrees par la coquille COMMUNE,
   * donc le routeur et le Catalyst les portaient deja tous les deux ;
   * ce cas garde que la migration ne les donne pas a une seule des deux
   * — c'est exactement le lieu ou une divergence ne se verrait pas.
   */
  it.each(['ip as-path access-list 1 permit ^$',
    'ip community-list 1 permit 100:1',
    'ip as-path access-list 1 zorglub ^$'])('`%s`', async (ligne) => {
      const r = await routeur(`F${cle(ligne)}`);
      const s = new CiscoSwitch('switch-cisco', `G${cle(ligne)}`) as unknown as Dev;
      for (const c of ['enable', 'configure terminal']) await s.executeCommand(c);
      const surRouteur = String(await r.executeCommand(ligne)).trim();
      const surCommutateur = String(await s.executeCommand(ligne)).trim();
      expect(surCommutateur, `routeur=${JSON.stringify(surRouteur)}`)
        .toBe(surRouteur);
    });
});
