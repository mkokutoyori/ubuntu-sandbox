/*
 * NetFlow acceptait EN SILENCE tout ce qu'il ne savait pas lire.
 *
 * Deux gloutons portaient la famille heritee, et tous deux finissaient
 * par un `return ''` que n'importe quelle saisie atteignait :
 *
 *     ip flow-export zorglub        ->  ACCEPTE, rien n'est pose
 *     ip flow-export destination    ->  ACCEPTE, rien n'est pose
 *     ip flow-cache zorglub         ->  ACCEPTE, rien n'est pose
 *     ip flow-cache timeout active  ->  ACCEPTE, rien n'est pose
 *
 * C'est la faute que ce depot nomme « un critere range sans etre
 * evalue », dans sa forme la plus couteuse : l'operateur croit avoir
 * pointe son collecteur, la configuration ne le montre pas, et rien ne
 * lui a dit non. Une commande d'export qui n'exporte pas et ne proteste
 * pas ne se decouvre qu'au moment ou l'on cherche les flux.
 *
 * Les trois PORTES de Flexible NetFlow avaient la faute inverse et plus
 * benigne : elles exigeaient bien leur nom, mais par un `% Incomplete`
 * ecrit a la main dans le gestionnaire, donc `?` n'annoncait pas ce
 * qu'elles attendaient.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. ce que le moteur n'evalue pas est REFUSE, pas ignore ;
 *   2. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   3. l'aide NOMME ce que le moteur juge, et les bornes qu'il applique ;
 *   4. une porte MENE a son sous-mode.
 *
 * Ce que la sonde n'exige PAS : que `ip route-cache flow` fasse quelque
 * chose. Sur un vrai routeur il active NetFlow sur toutes les
 * interfaces ; ici le gestionnaire rend `''` et n'enregistre rien. C'est
 * une limite ASSUMEE — la commande reste acceptee parce qu'un import de
 * configuration la porte, et la declarer ne la rendrait pas vraie. La
 * sonde se borne a verifier qu'elle n'a pas change de reponse.
 *
 * Discriminee contre l'etat d'avant : 13 des 34 cas tombent. Les 21 qui
 * passent des deux cotes sont les TEMOINS, et ils portent le risque de
 * ce lot, qui RESSERRE deux grammaires restees ouvertes : les six formes
 * justes etaient deja posees et deja relues, les trois portes ouvraient
 * deja leur sous-mode et ce qu'on y pose s'y relisait deja, et deux
 * refus tenaient deja — `version 42` et un port hors bornes, les deux
 * seuls endroits ou les gloutons appelaient un lecteur borne. Tout le
 * reste passait en silence.
 *
 * Deux des refus deja acquis meritent d'etre nommes, parce qu'ils
 * disent ou etait la faute : les gloutons SAVAIENT juger un nombre. Ils
 * ne jugeaient pas le MOT qui le precede, si bien que `version 42`
 * etait refuse et `zorglub` accepte — la ou le controle existait il
 * etait juste, et il n'existait qu'au dernier rang.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const MOT = /^\s\s(\S+)/;
const nomsAnnonces = (aide: string): string[] =>
  aide.includes('Invalid input') ? []
    : aide.split('\n').map((l) => MOT.exec(l)?.[1])
      .filter((m): m is string => !!m && m !== '<cr>');
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

async function config(...prelude: string[]): Promise<Cli> {
  const d = new CiscoRouter(`X${serie++}`, 2, 2) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', 'configure terminal', ...prelude]) await d.executeCommand(c);
  return d;
}

describe('ce que le moteur n evalue pas est REFUSE', () => {
  it.each([
    'ip flow-export zorglub',
    'ip flow-cache zorglub',
    'ip flow-cache timeout zorglub',
    'ip flow-export version 42',
    'ip flow-export destination 10.0.0.1 99999',
  ])('`%s`', async (frappe) => {
    const d = await config();
    expect(await d.executeCommand(frappe), frappe).toMatch(/Invalid input/);
  });
});

describe('une frappe incomplete le dit, et son aide aussi', () => {
  it.each([
    'ip flow-export',
    'ip flow-export destination',
    'ip flow-export destination 10.0.0.1',
    'ip flow-export source',
    'ip flow-export version',
    'ip flow-cache',
    'ip flow-cache timeout',
    'ip flow-cache timeout active',
    'flow exporter',
    'flow record',
    'flow monitor',
  ])('`%s ?`', async (frappe) => {
    const d = await config();
    expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`).toBe(false);
    expect(await d.executeCommand(frappe), frappe).toMatch(/Incomplete command/);
  });
});

describe('l aide NOMME ce que le moteur juge', () => {
  it.each([
    ['ip flow-export', ['destination', 'source', 'version']],
    ['ip flow-cache', ['timeout']],
    ['ip flow-cache timeout', ['active', 'inactive']],
  ] as Array<[string, string[]]>)('`%s ?`', async (frappe, attendus) => {
    const d = await config();
    expect(nomsAnnonces(d.cliHelp(`${frappe} `)))
      .toEqual(expect.arrayContaining(attendus));
  });

  it('`ip flow-export version ?` annonce la borne appliquee', async () => {
    const d = await config();
    expect(nomsAnnonces(d.cliHelp('ip flow-export version '))).toContain('<1-9>');
  });

  it.each(['flow exporter', 'flow record', 'flow monitor'])(
    '`%s ?` annonce le nom attendu', async (frappe) => {
      const d = await config();
      expect(nomsAnnonces(d.cliHelp(`${frappe} `))).toContain('WORD');
    });
});

describe('les formes JUSTES sont posees — les TEMOINS', () => {
  it.each([
    'ip flow-export destination 10.0.0.1 2055',
    'ip flow-export source GigabitEthernet0/0',
    'ip flow-export version 9',
    'ip flow-cache timeout active 30',
    'ip flow-cache timeout inactive 15',
    'ip route-cache flow',
  ])('`%s`', async (frappe) => {
    const d = await config();
    expect(await d.executeCommand(frappe), frappe).not.toMatch(/Invalid|Incomplete/);
  });

  it('l export pose se relit dans la configuration', async () => {
    const d = await config(
      'ip flow-export destination 10.0.0.1 2055', 'ip flow-export version 9');
    await d.executeCommand('end');
    const cfg = String(await d.executeCommand('show running-config'));
    expect(cfg, 'la destination ne se relit pas')
      .toMatch(/ip flow-export destination 10\.0\.0\.1 2055/);
    expect(cfg, 'la version ne se relit pas').toMatch(/ip flow-export version 9/);
  });
});

/*
 * La frappe qui PROUVE qu'un sous-mode s'est ouvert doit lui appartenir.
 *
 * Ecrit a l'aveugle, ce bloc essayait `description` dans les trois, par
 * analogie avec les sous-modes de VLAN et d'interface. Aucun des trois
 * ne la porte : un exportateur prend `destination` et `source`, un
 * enregistrement `match` et `collect`, un moniteur `record` et
 * `exporter`. La sonde utilisait donc un mot etranger a la famille pour
 * prouver qu'on y etait entre, ce qui ne prouvait rien.
 */
describe('les trois portes MENENT a leur sous-mode — les TEMOINS', () => {
  it.each([
    ['flow exporter COLLECTEUR', 'destination 10.0.0.1'],
    ['flow record CHAMPS', 'match ipv4 source address'],
    ['flow monitor SURVEILLE', 'record CHAMPS'],
  ] as Array<[string, string]>)('`%s`', async (porte, dansLeSousMode) => {
    const d = await config();
    expect(await d.executeCommand(porte), porte).not.toMatch(/Invalid|Incomplete/);
    expect(await d.executeCommand(dansLeSousMode),
      `${porte} n a pas ouvert son sous-mode`).not.toMatch(/Invalid|Incomplete/);
  });

  it('ce qu on pose dans le sous-mode se relit', async () => {
    const d = await config('flow exporter COLLECTEUR',
      'destination 10.0.0.1', 'transport udp 2055', 'exit');
    await d.executeCommand('end');
    const cfg = String(await d.executeCommand('show running-config'));
    expect(cfg, 'l exportateur ne se relit pas').toMatch(/flow exporter COLLECTEUR/);
    expect(cfg, 'sa destination ne se relit pas').toMatch(/destination 10\.0\.0\.1/);
  });
});
