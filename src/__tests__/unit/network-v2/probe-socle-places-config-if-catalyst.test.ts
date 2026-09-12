/*
 * Sonde sur les PLACES que la configuration d'interface d'un Catalyst
 * n'avait jamais declarees.
 *
 * Un noeud sans place declaree ment deux fois, et les deux mensonges se
 * lisent a la meme frappe :
 *
 *     duplex ?        ->  <cr>                 puis  % Incomplete command.
 *     duplex full ?   ->  % Invalid input ...  puis  la commande PASSE
 *
 * Le premier promet qu'on peut valider une commande a laquelle il manque
 * son argument. Le second repond « ce mot n'existe pas » a une frappe que
 * la meme machine execute dans la seconde qui suit. Ce sont les deux
 * faces d'un seul defaut : l'arite se DEDUIT des places, et une place non
 * declaree vaut zero place.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   2. une tete NOMME ce qu'elle attend, et `<cr>` n'est pas un nom ;
 *   3. une frappe que la machine EXECUTE n'est pas decrite comme
 *      inexistante par sa propre aide ;
 *   4. une place enumeree annonce ses valeurs et REFUSE les autres ;
 *   5. un routeur et un Catalyst repondent la MEME chose a `duplex ?` et
 *      a `speed ?` — c'est la meme commande, et elle n'a pas deux
 *      grammaires selon le chassis.
 *
 * Le point 5 est celui qui vaut la sonde. `duplex` et `speed` etaient
 * ecrits DEUX FOIS : le routeur les declarait avec une place enumeree, le
 * Catalyst en gardait un glouton a lui. Deux ecritures d'un seul fait, et
 * une seule des deux savait se decrire — l'operateur qui tape `duplex ?`
 * recevait les trois modes sur un routeur et `<cr>` sur un commutateur.
 * La correction n'ajoute pas une seconde declaration au Catalyst : elle
 * lui fait lire CELLE du routeur.
 *
 * Ce que la sonde n'exige PAS, et pourquoi : le domaine de `speed` ne
 * depend pas du port ici. Un vrai Catalyst n'offre pas `1000` sur un port
 * FastEthernet, et le declarer par chassis demanderait la reference, qu'on
 * ne peut pas atteindre depuis ce reseau. La place declare les quatre
 * valeurs que le simulateur honore, sur les deux plateformes, ce qui est
 * l'invariant qu'on sait tenir.
 *
 * Discriminee contre l'etat d'avant : 28 des 46 cas tombent. Les 18 qui
 * passent des deux cotes sont les TEMOINS, et ils portent ici tout le
 * risque : la correction RESSERRE une grammaire, donc une version qui
 * refuserait tout satisferait les 28 autres.
 *
 *   - les huit frappes COMPLETES s'executaient deja et s'executent
 *     encore. C'est la moitie qui compte : `speed` passe d'un glouton
 *     qui acceptait `\d+` a une place de quatre valeurs, et `speed 100`
 *     devait traverser le resserrement ;
 *   - les quatre valeurs HORS domaine — `duplex sideways`, `speed 7`,
 *     `l2protocol-tunnel zorglub`, `mls qos cos 9` — etaient deja
 *     refusees, par le gestionnaire. Elles le restent, par la place :
 *     le refus a change d'endroit, pas de reponse ;
 *   - `shutdown` et `no shutdown` gardent leur `<cr>`, et `channel-group`
 *     garde son `<1-64>` sans `<cr>` — c'est la forme que la correction
 *     recopie, et le temoin qui dit qu'elle n'a pas deborde sur le reste
 *     de la configuration d'interface ;
 *   - le routeur annoncait deja ses trois modes et ses quatre debits, et
 *     les annonce toujours : l'extraction de la declaration partagee
 *     n'a rien change chez celui qui la possedait ;
 *   - `switchport private-vlan mapping ?` NOMMAIT deja quelque chose,
 *     seul des huit : son noeud portait une indication d'argument que
 *     les sept autres n'avaient pas. Ce temoin est STRUCTUREL et il dit
 *     la ou est vraiment le defaut — l'indication ne suffisait pas, la
 *     meme frappe promettait `<cr>` par-dessus, et ce cas-la tombe.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const MOT = /^\s\s(\S+)/;
const mots = (aide: string): string[] =>
  aide.includes('Invalid input') ? []
    : aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);
const nomsAnnonces = (aide: string): string[] =>
  mots(aide).filter((m) => m !== '<cr>');
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

async function commutateur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', ...prelude]) await d.executeCommand(c);
  return d;
}

async function routeur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoRouter(`X${serie++}`, 2, 2) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', ...prelude]) await d.executeCommand(c);
  return d;
}

const PORT = ['configure terminal', 'interface FastEthernet0/1'];
const PRIVE = [
  'configure terminal',
  'vlan 100', 'private-vlan primary', 'exit',
  'vlan 101', 'private-vlan isolated', 'exit',
  'vlan 100', 'private-vlan association 101', 'exit',
  'interface FastEthernet0/1',
];
const SVI = [
  'configure terminal',
  'vlan 100', 'private-vlan primary', 'exit',
  'interface Vlan100',
];
const PORT_ROUTEUR = ['configure terminal', 'interface GigabitEthernet0/0'];

/** La tete sans sa place, la frappe qui la complete, et le mode. */
const CAS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ['duplex', 'duplex full', PORT],
  ['speed', 'speed 100', PORT],
  ['l2protocol-tunnel', 'l2protocol-tunnel cdp', PORT],
  ['mls qos cos', 'mls qos cos 5', PORT],
  ['switchport private-vlan host-association',
    'switchport private-vlan host-association 100 101', PRIVE],
  ['switchport private-vlan mapping',
    'switchport private-vlan mapping 100 101', PRIVE],
  ['switchport vlan mapping', 'switchport vlan mapping 10 20', PORT],
  ['private-vlan mapping', 'private-vlan mapping 101', SVI],
];

describe('une tete sans argument ne promet pas `<cr>`', () => {
  for (const [tete, , mode] of CAS) {
    it(`\`${tete} ?\``, async () => {
      const d = await commutateur(...mode);
      expect(annonceCr(d.cliHelp(`${tete} `)), `${tete} ? promet <cr>`).toBe(false);
      expect(await d.executeCommand(tete), tete).toMatch(/Incomplete command/);
    });
  }
});

describe('une tete NOMME ce qu elle attend', () => {
  for (const [tete, , mode] of CAS) {
    it(`\`${tete} ?\``, async () => {
      const d = await commutateur(...mode);
      const aide = d.cliHelp(`${tete} `);
      expect(aide, `${tete} ? repond au caret`).not.toMatch(/Invalid input/);
      expect(nomsAnnonces(aide), `${tete} ? n annonce que <cr>`).not.toEqual([]);
    });
  }
});

describe('la frappe COMPLETE s execute — les TEMOINS', () => {
  for (const [tete, complete, mode] of CAS) {
    it(`\`${complete}\``, async () => {
      const d = await commutateur(...mode);
      expect(await d.executeCommand(complete), `${tete} complete`)
        .not.toMatch(/Invalid input|Incomplete command/);
    });
  }
});

describe('et son aide ne la declare pas inexistante', () => {
  for (const [, complete, mode] of CAS) {
    it(`\`${complete} ?\``, async () => {
      const d = await commutateur(...mode);
      const aide = d.cliHelp(`${complete} `);
      expect(aide, `${complete} ? repond au caret`).not.toMatch(/Invalid input/);
      expect(annonceCr(aide), `${complete} ? tait <cr>`).toBe(true);
    });
  }
});

describe('une place enumeree annonce ses valeurs', () => {
  it.each([
    ['duplex', ['auto', 'full', 'half']],
    ['l2protocol-tunnel', ['cdp', 'lldp', 'stp', 'vtp']],
    ['speed', ['10', '100', '1000', 'auto']],
  ] as Array<[string, string[]]>)('`%s ?`', async (tete, valeurs) => {
    const d = await commutateur(...PORT);
    expect(nomsAnnonces(d.cliHelp(`${tete} `))).toEqual(expect.arrayContaining(valeurs));
  });

  it.each(['duplex sideways', 'speed 7', 'l2protocol-tunnel zorglub', 'mls qos cos 9'])(
    '`%s` reste refuse — le TEMOIN', async (frappe) => {
      const d = await commutateur(...PORT);
      expect(await d.executeCommand(frappe), frappe).toMatch(/Invalid input/);
    });
});

describe('le reste de la configuration d interface ne bouge pas — les TEMOINS', () => {
  it.each(['shutdown', 'no shutdown'])('`%s ?` garde son `<cr>`', async (frappe) => {
    const d = await commutateur(...PORT);
    expect(annonceCr(d.cliHelp(`${frappe} `)), frappe).toBe(true);
    expect(await d.executeCommand(frappe), frappe).not.toMatch(/Invalid|Incomplete/);
  });

  it('`channel-group ?` annonce son rang sans `<cr>`', async () => {
    const d = await commutateur(...PORT);
    const aide = d.cliHelp('channel-group ');
    expect(nomsAnnonces(aide)).toContain('<1-64>');
    expect(annonceCr(aide)).toBe(false);
  });
});

describe('`duplex` et `speed` repondent PAREIL sur les deux plateformes', () => {
  it.each(['duplex ', 'speed '])('`%s?` rend le meme texte', async (tete) => {
    const c = await commutateur(...PORT);
    const r = await routeur(...PORT_ROUTEUR);
    expect(c.cliHelp(tete)).toBe(r.cliHelp(tete));
  });

  it.each([
    ['duplex', ['auto', 'full', 'half']],
    ['speed', ['10', '100', '1000', 'auto']],
  ] as Array<[string, string[]]>)(
    '`%s ?` annonce deja ses valeurs sur un routeur — le TEMOIN',
    async (tete, valeurs) => {
      const r = await routeur(...PORT_ROUTEUR);
      expect(nomsAnnonces(r.cliHelp(`${tete} `))).toEqual(valeurs);
    });
});
