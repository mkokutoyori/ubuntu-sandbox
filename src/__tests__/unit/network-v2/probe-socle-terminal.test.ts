/*
 * `terminal` reglait la session et son aide n'en decrivait pas les
 * bornes.
 *
 * Un seul glouton portait la famille, avec une liste de suites affichee
 * a cote. Les suites s'affichaient donc, mais le NOEUD n'avait pas de
 * place, donc son arite valait zero a tous les rangs :
 *
 *     terminal length ?       ->  <cr>   puis  % Incomplete command.
 *     terminal width ?        ->  <cr>   puis  % Incomplete command.
 *     terminal no ?           ->  <cr>   puis  % Incomplete command.
 *
 * Et les trois bornes que le gestionnaire APPLIQUE — 0-512 lignes,
 * 40-512 colonnes, 0-256 entrees d'historique — n'etaient annoncees
 * nulle part, alors qu'IOS les annonce et que c'est precisement ce qui
 * dispense d'aller les chercher dans la documentation.
 *
 * Ces trois frappes sont ressorties du balayage de l'aide sur la
 * configuration d'interface d'un Catalyst, sous la forme `do terminal
 * length ?` : `do` donne acces a l'EXEC depuis un mode de configuration,
 * donc un defaut de l'EXEC s'y lit une seconde fois. La sonde mesure les
 * deux portes, parce qu'une correction qui n'en servirait qu'une ferait
 * repondre deux choses a la meme question sur la meme machine.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   2. une borne ANNONCEE est une borne APPLIQUEE, et reciproquement —
 *      le gestionnaire refuse deja 513 lignes et 39 colonnes ;
 *   3. un routeur et un Catalyst repondent pareil ;
 *   4. `do <commande>` repond ce que `<commande>` repond.
 *
 * Ce que la sonde n'exige PAS : `terminal exec`. Le gestionnaire
 * l'accepte et n'en fait rien — c'est une forme qu'un vrai IOS accepte
 * et que ce simulateur ne sait pas honorer. Elle reste acceptee et
 * n'est pas ANNONCEE : annoncer un mot dont l'effet n'existe pas serait
 * le pire des trois etats.
 *
 * Discriminee contre l'etat d'avant : 31 des 51 cas tombent. Les 20 qui
 * passent des deux cotes sont les TEMOINS, dix par plateforme :
 *
 *   - `terminal ?` ne promettait deja pas `<cr>` et nommait deja ses
 *     cinq suites : le glouton portait une liste d'affichage, et c'est
 *     ce qui rendait le defaut invisible au premier rang — l'aide avait
 *     l'air complete. Elle s'arretait au premier mot ;
 *   - `terminal monitor` et `terminal history` gardaient deja leur
 *     `<cr>` et s'executaient : ce sont les deux seules formes de la
 *     famille qui se suffisent sans valeur, donc les deux seules que
 *     l'arite zero du glouton decrivait par accident ;
 *   - les cinq refus (513 lignes, 39 colonnes, 257 entrees, et deux mots
 *     inventes) etaient deja rendus par le gestionnaire. Ils le restent,
 *     et c'est ce qui compte : les bornes passent de la profondeur du
 *     gestionnaire a la DECLARATION, donc `?` les annonce enfin, sans
 *     que la reponse a une saisie hors bornes change ;
 *   - `do terminal length 24` s'executait deja, et `terminal length 0`
 *     passait deja au niveau 1. Les deux bornent la migration par ou
 *     elle aurait pu casser : la porte `do` et le niveau de privilege.
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

type Fabrique = (prelude: readonly string[]) => Promise<Cli>;

const routeur: Fabrique = async (prelude) => {
  const d = new CiscoRouter(`X${serie++}`, 2, 2) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', ...prelude]) await d.executeCommand(c);
  return d;
};

const commutateur: Fabrique = async (prelude) => {
  const d = new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', ...prelude]) await d.executeCommand(c);
  return d;
};

const PLATEFORMES: ReadonlyArray<readonly [string, Fabrique]> = [
  ['routeur', routeur],
  ['commutateur', commutateur],
];

const INCOMPLETES = [
  'terminal',
  'terminal length',
  'terminal width',
  'terminal no',
  'terminal history size',
];

const COMPLETES = [
  'terminal length 24',
  'terminal length 0',
  'terminal width 132',
  'terminal monitor',
  'terminal no monitor',
  'terminal history',
  'terminal history size 50',
];

for (const [plateforme, fabrique] of PLATEFORMES) {
  describe(`\`terminal\`, sur un ${plateforme}`, () => {
    it.each(INCOMPLETES)('`%s ?` ne promet pas `<cr>`', async (frappe) => {
      const d = await fabrique([]);
      expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`).toBe(false);
      expect(await d.executeCommand(frappe), frappe).toMatch(/Incomplete command/);
    });

    it.each(COMPLETES)('`%s` garde son `<cr>` et s execute', async (frappe) => {
      const d = await fabrique([]);
      expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? tait <cr>`).toBe(true);
      expect(await d.executeCommand(frappe), frappe).not.toMatch(/Invalid|Incomplete/);
    });

    it.each([
      ['terminal', ['history', 'length', 'monitor', 'no', 'width']],
      ['terminal no', ['history', 'length', 'monitor', 'width']],
      ['terminal history', ['size']],
    ] as Array<[string, string[]]>)('`%s ?` nomme ses suites', async (frappe, suites) => {
      const d = await fabrique([]);
      expect(nomsAnnonces(d.cliHelp(`${frappe} `)))
        .toEqual(expect.arrayContaining(suites));
    });

    it.each([
      ['terminal length', '<0-512>'],
      ['terminal width', '<40-512>'],
      ['terminal history size', '<0-256>'],
    ] as Array<[string, string]>)('`%s ?` annonce la borne qu il applique',
      async (frappe, borne) => {
        const d = await fabrique([]);
        expect(nomsAnnonces(d.cliHelp(`${frappe} `)), frappe).toContain(borne);
      });

    it.each([
      'terminal length 513',
      'terminal width 39',
      'terminal history size 257',
      'terminal zorglub',
      'terminal no zorglub',
    ])('`%s` est refuse', async (frappe) => {
      const d = await fabrique([]);
      expect(await d.executeCommand(frappe), frappe).toMatch(/Invalid input/);
    });
  });
}

describe('`do terminal` repond ce que `terminal` repond', () => {
  it.each(['terminal length', 'terminal width', 'terminal no'])(
    '`do %s ?` ne promet pas `<cr>`', async (frappe) => {
      const d = await commutateur(['configure terminal', 'interface FastEthernet0/1']);
      expect(annonceCr(d.cliHelp(`do ${frappe} `)), `do ${frappe} ?`).toBe(false);
      expect(await d.executeCommand(`do ${frappe}`), frappe).toMatch(/Incomplete command/);
    });

  it('`do terminal length 24` s execute — le TEMOIN', async () => {
    const d = await commutateur(['configure terminal', 'interface FastEthernet0/1']);
    expect(await d.executeCommand('do terminal length 24')).not.toMatch(/Invalid|Incomplete/);
  });
});

describe('`terminal` reste servi avant `enable` — le TEMOIN', () => {
  it('`terminal length 0` passe au niveau 1', async () => {
    const d = new CiscoRouter(`X${serie++}`, 2, 2) as unknown as Cli;
    d.powerOn();
    expect(await d.executeCommand('terminal length 0')).not.toMatch(/Invalid|Incomplete/);
  });
});
