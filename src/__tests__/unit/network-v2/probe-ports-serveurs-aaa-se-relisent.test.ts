/**
 * Un port de serveur AAA se RELIT, et `zorglub` n'est pas un numero.
 *
 * Sonde ecrite AVANT correction, contre la reference d'IOS :
 *
 *   radius-server auth-port <0-65535>     defaut global, 1645
 *   radius-server acct-port <0-65535>     defaut global, 1646
 *   tacacs-server port <1-65535>          defaut global, 49
 *   radius-server host <ip> [auth-port P] [acct-port P] …
 *   tacacs-server host <ip> [port P] …
 *   aaa session-id { common | unique }
 *
 * Mesure de depart, une commande par machine neuve, la configuration
 * relue apres chaque ligne :
 *
 *   radius-server timeout 10     -> accepte, RENDU        TEMOIN
 *   radius-server retransmit 5   -> accepte, RENDU        TEMOIN
 *   radius-server key secret     -> accepte, RENDU        TEMOIN
 *   radius-server acct-port 1813 -> accepte, RENDU NULLE PART
 *   radius-server auth-port 1812 -> accepte, RENDU NULLE PART
 *   tacacs-server port 49        -> accepte, RENDU NULLE PART
 *   radius-server acct-port zorglub -> ACCEPTE
 *   aaa session-id zorglub       -> accepte, RENDU tel quel
 *   aaa new-model zorglub        -> accepte
 *   aaa local zorglub            -> accepte
 *
 * TROIS TEMOINS DANS LE MEME LABORATOIRE, et c'est ce qui rend le defaut
 * lisible : `timeout`, `retransmit` et `key` — les trois soeurs de la
 * MEME commande — sont retenues, rendues, et servent de defaut aux hotes
 * qui n'en declarent pas (`AaaAuthenticator.syncRadiusServer` lit
 * `defauts.key ?? …`, `defauts.timeoutSec ?? …`). Les trois ports, eux,
 * traversent le gestionnaire sans rien toucher : le magasin
 * `radiusDefaults` ne porte pas de champ pour eux, et le port d'un hote
 * est fige a l'analyse sur un 1645/1646 ECRIT EN DUR.
 *
 * LA CONSEQUENCE N'EST PAS COSMETIQUE, et elle est double.
 * (1) La configuration rendue est REJOUEE a l'import d'une topologie :
 *     un laboratoire qui deplace RADIUS sur les ports modernes
 *     (1812/1813, ceux de la RFC 2865) revient sur 1645/1646 sans qu'un
 *     mot le dise, et l'authentification cesse de fonctionner apres un
 *     simple aller-retour du fichier.
 * (2) Meme SANS import, la commande ne fait rien du tout : elle est
 *     acceptee, l'operateur la croit posee, et le client continue
 *     d'emettre vers 1645.
 *
 * `zorglub` est accepte alors que la meme place refuse `99999` — la
 * PLAGE est declaree par les continuations et appliquee par le trie, la
 * FORME ne l'est pas. Un gestionnaire qui ecarte `NaN` en silence est
 * ce que ce depot corrige a chaque lot : l'operateur croit avoir regle
 * le port.
 *
 * `aaa session-id` n'a que DEUX valeurs, et la troisieme est rendue dans
 * la configuration : une valeur qui n'en est pas une devient une ligne
 * permanente. `aaa new-model` et `aaa local` prennent le mot de trop de
 * la meme facon.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS : que `aaa session-id
 * common` paraisse dans la configuration d'une machine qui ne l'a pas
 * tapee. IOS l'y ecrit par defaut des qu'`aaa new-model` est pose, mais
 * aucune capture n'est atteignable depuis ce reseau pour trancher ce que
 * fait la serie 15 exactement, et l'ajouter changerait la configuration
 * de toutes les machines du depot. Seul le retour de ce qu'on a TAPE est
 * exige.
 *
 * DEUX CHOSES QUE LA MESURE A CORRIGEES EN COURS DE ROUTE, ecrites ici
 * plutot que passees sous silence. La premiere version de cette sonde
 * observait `show radius statistics` : c'est la MAUVAISE vue, elle ne
 * rend que des compteurs. Les ports se lisent dans `show aaa servers`,
 * qui ecrit `RADIUS: id 1, priority 1, host …, auth-port …, acct-port …`
 * comme IOS. Et le port d'un hote cesse d'etre FIGE a l'analyse : il
 * n'est retenu que s'il a ete DECLARE, sans quoi une commande globale
 * tapee apres l'hote ne l'atteindrait jamais — c'est ce que veut dire
 * « defaut ». `radiusAuthPort`, `radiusAcctPort` et `tacacsServerPort`
 * sont les trois seules ecritures de cette resolution, lues par le
 * rendu de la configuration, par `show aaa servers`, par `show tacacs`
 * et par la synchronisation du client.
 *
 * Discrimine par `git stash` sur les trois fichiers cables : 15 des 40
 * cas tombent avant correctif. Les 25 autres sont nommes ici :
 *
 *   - les CINQ temoins (`timeout`, `retransmit`, `key`), qui sont la
 *     PREUVE que le mecanisme existait pour leurs soeurs et non des
 *     temoins au sens ordinaire ;
 *   - les SIX cas « un routeur neuf ne rend rien » et « `no` retire »,
 *     qui passaient parce que RIEN n'etait jamais rendu — leur role est
 *     desormais de garder que le rendu ne s'emballe pas ;
 *   - les DEUX bornes hors plage, deja refusees par le trie, qui
 *     epinglent que la plage n'a pas ete perdue en ajoutant la forme ;
 *   - les DEUX valeurs legitimes de `aaa session-id`, deja acceptees ;
 *   - les DIX cas de non-regression de la famille AAA, sans lesquels un
 *     correctif qui refuserait tout satisferait la sonde.
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
  for (const c of ['enable', 'configure terminal', 'aaa new-model', ...cmds]) {
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

const cle = (s: string) => s.replace(/\W/g, '');

const PORTS: ReadonlyArray<readonly [string, string]> = [
  ['radius-server auth-port', '1812'],
  ['radius-server acct-port', '1813'],
  ['tacacs-server port', '4949'],
];

describe('les TEMOINS de la meme commande sont retenus et rendus', () => {
  it.each(['radius-server timeout 10', 'radius-server retransmit 5',
    'radius-server key secret', 'tacacs-server timeout 10', 'tacacs-server key secret'])(
    '`%s` reste accepte et rendu', async (ligne) => {
      const d = routeur(`T${cle(ligne)}`);
      expect(await conf(d, ligne)).not.toContain('%');
      expect(await config(d)).toContain(ligne);
    });
});

describe('un port global se relit dans la configuration', () => {
  it.each(PORTS)('`%s %s` est rendu tel quel', async (place, valeur) => {
    const d = routeur(`A${cle(place)}`);
    expect(await conf(d, `${place} ${valeur}`)).not.toContain('%');
    expect(await config(d)).toContain(`${place} ${valeur}`);
  });

  it.each(PORTS)('un routeur neuf ne rend aucune ligne `%s`', async (place) => {
    const d = routeur(`B${cle(place)}`);
    await conf(d);
    expect(await config(d)).not.toContain(place);
  });

  it.each(PORTS)('et `no %s` la retire', async (place, valeur) => {
    const d = routeur(`C${cle(place)}`);
    await conf(d, `${place} ${valeur}`, `no ${place}`);
    expect(await config(d)).not.toContain(`${place} ${valeur}`);
  });
});

describe('le defaut global est celui que les hotes prennent', () => {
  it('`radius-server host` sans port prend les ports globaux', async () => {
    const d = routeur('D1');
    await conf(d, 'radius-server auth-port 1812', 'radius-server acct-port 1813',
      'radius-server host 10.0.0.9 key s3cr3t');
    await d.executeCommand('end');
    const vue = String(await d.executeCommand('show aaa servers'));
    expect(vue).toContain('auth-port 1812');
    expect(vue).toContain('acct-port 1813');
  });

  it('et un port declare SUR l hote l emporte sur le global', async () => {
    const d = routeur('D2');
    await conf(d, 'radius-server auth-port 1812',
      'radius-server host 10.0.0.9 auth-port 1645 key s3cr3t');
    await d.executeCommand('end');
    expect(String(await d.executeCommand('show aaa servers')))
      .toContain('auth-port 1645');
  });

  it('sans commande globale, l hote garde les ports historiques d IOS', async () => {
    const d = routeur('D3');
    await conf(d, 'radius-server host 10.0.0.9 key s3cr3t');
    await d.executeCommand('end');
    const vue = String(await d.executeCommand('show aaa servers'));
    expect(vue).toContain('auth-port 1645');
    expect(vue).toContain('acct-port 1646');
  });
});

describe('la forme est jugee comme la plage l est deja', () => {
  it.each(PORTS)('`%s zorglub` est refuse', async (place) => {
    const d = routeur(`E${cle(place)}`);
    expect(await conf(d, `${place} zorglub`)).toContain('% Invalid input');
  });

  it.each(PORTS)('`%s` sans valeur dit INCOMPLET', async (place) => {
    const d = routeur(`F${cle(place)}`);
    expect(await conf(d, place)).toContain('% Incomplete command.');
  });

  it.each([['radius-server auth-port', '65536'], ['tacacs-server port', '0']])(
    '`%s %s` — hors plage — reste refuse', async (place, valeur) => {
      const d = routeur(`G${cle(place + valeur)}`);
      expect(await conf(d, `${place} ${valeur}`)).toContain('% Invalid input');
    });

  it('et un refus ne laisse rien dans la configuration', async () => {
    const d = routeur('GR');
    await conf(d, 'radius-server acct-port zorglub');
    expect(await config(d)).not.toContain('acct-port');
  });
});

describe('`aaa session-id` n a que deux valeurs', () => {
  it.each(['common', 'unique'])('`aaa session-id %s` reste accepte et rendu', async (v) => {
    const d = routeur(`H${v}`);
    expect(await conf(d, `aaa session-id ${v}`)).not.toContain('%');
    expect(await config(d)).toContain(`aaa session-id ${v}`);
  });

  it.each(['zorglub', 'commun'])('`aaa session-id %s` est refuse', async (v) => {
    const d = routeur(`I${v}`);
    expect(await conf(d, `aaa session-id ${v}`)).toContain('% Invalid input');
  });

  it('`aaa session-id` nu dit INCOMPLET', async () => {
    const d = routeur('IN');
    expect(await conf(d, 'aaa session-id')).toContain('% Incomplete command.');
  });

  it('`aaa session-id common zorglub` refuse le mot de trop', async () => {
    const d = routeur('IX');
    expect(await conf(d, 'aaa session-id common zorglub')).toContain('% Invalid input');
  });

  it('et une valeur refusee ne laisse rien dans la configuration', async () => {
    const d = routeur('IR');
    await conf(d, 'aaa session-id zorglub');
    expect(await config(d)).not.toContain('session-id');
  });
});

describe('non-regression — le reste de la famille AAA', () => {
  it('`aaa new-model` reste accepte et rendu', async () => {
    const d = routeur('J1');
    await conf(d);
    expect(await config(d)).toContain('aaa new-model');
  });

  it('`aaa local authentication attempts max-fail 3` reste accepte et rendu', async () => {
    const d = routeur('J2');
    const ligne = 'aaa local authentication attempts max-fail 3';
    expect(await conf(d, ligne)).not.toContain('%');
    expect(await config(d)).toContain(ligne);
  });

  it.each(['aaa authentication login default local',
    'aaa authorization exec default local',
    'aaa accounting exec default start-stop group tacacs+'])(
    '`%s` reste accepte', async (ligne) => {
      const d = routeur(`K${cle(ligne)}`);
      expect(await conf(d, ligne)).not.toContain('%');
    });

  it('`radius-server host 10.0.0.9 auth-port 1812 acct-port 1813 key s` reste accepte',
    async () => {
      const d = routeur('K9');
      expect(await conf(d,
        'radius-server host 10.0.0.9 auth-port 1812 acct-port 1813 key s'))
        .not.toContain('%');
    });

  it('`tacacs-server host 10.0.0.8 port 49 key s` reste accepte', async () => {
    const d = routeur('K8');
    expect(await conf(d, 'tacacs-server host 10.0.0.8 port 49 key s')).not.toContain('%');
  });
});
