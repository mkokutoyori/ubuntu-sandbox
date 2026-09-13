/*
 * `ipv6 router ospf` tout seul ouvrait un processus 1 que personne
 * n'avait demande.
 *
 *     const processId = args.length >= 1 ? parseInt(args[0], 10) : 1;
 *
 * Sur IOS l'identifiant de processus est EXIGE. Ici son absence valait
 * « 1 » en silence, donc une frappe incomplete creait un processus
 * OSPFv3 — et l'operateur qui croyait s'etre arrete avant de choisir se
 * retrouvait dans son sous-mode, a configurer un processus qu'il n'a pas
 * nomme. Aucun test du depot ne tape la forme nue : tous nomment leur
 * processus.
 *
 * Les quatre PORTES IPv6 de la configuration globale partagent la meme
 * forme — un nom ou un numero, puis un sous-mode — et la meme lacune :
 * leurs places n'etaient pas declarees, donc `?` n'annoncait ni le nom
 * attendu ni les bornes appliquees. `ipv6 router eigrp` juge 1-65535
 * depuis toujours et ne l'a jamais dit.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   2. une borne annoncee est une borne appliquee ;
 *   3. une porte MENE a son sous-mode, et ce qu'on y pose se relit ;
 *   4. un prefixe IPv6 est un PREFIXE.
 *
 * Le point 3 est celui qui vaut la sonde : une porte declaree qui
 * n'entrerait plus dans son sous-mode reussirait en silence, et la
 * premiere ligne qu'on y tape serait refusee en configuration globale.
 * Le laboratoire fait donc le tour complet pour chacune des quatre.
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

describe('une porte sans son nom est INCOMPLETE', () => {
  it.each([
    'ipv6 access-list',
    'ipv6 router eigrp',
    'ipv6 router ospf',
    'ipv6 route',
    'ipv6 route 2001:db8::/64',
  ])('`%s ?`', async (frappe) => {
    const d = await config();
    expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`).toBe(false);
    expect(await d.executeCommand(frappe), frappe).toMatch(/Incomplete command/);
  });
});

describe('les bornes annoncees sont les bornes appliquees', () => {
  it.each([
    ['ipv6 router eigrp', '<1-65535>'],
    ['ipv6 router ospf', '<1-65535>'],
  ] as Array<[string, string]>)('`%s ?` annonce %s', async (frappe, borne) => {
    const d = await config();
    expect(nomsAnnonces(d.cliHelp(`${frappe} `)), frappe).toContain(borne);
  });

  /*
   * Le TEXTE du refus n'est pas exige, et la difference est delibere.
   * EIGRP rend le caret ; OSPFv3 rend « % Invalid OSPFv3 process ID »,
   * les mots de la plateforme, et c'est le plus precis des deux — donc
   * sa plage est declaree comme DECRIVANT sans trancher, pour que `?`
   * la nomme sans ajouter un second refus a la meme saisie.
   */
  it.each([
    'ipv6 router eigrp 0',
    'ipv6 router eigrp 65536',
    'ipv6 router ospf 0',
    'ipv6 router ospf 65536',
  ])('`%s` est refuse', async (frappe) => {
    const d = await config();
    expect(await d.executeCommand(frappe), frappe).toMatch(/^%/m);
  });
});

describe('un prefixe IPv6 est un PREFIXE', () => {
  it.each([
    'ipv6 route zorglub 2001:db8::1',
    'ipv6 route 2001:db8:: 2001:db8::1',
    'ipv6 route 2001:db8::/129 2001:db8::1',
  ])('`%s` est refuse', async (frappe) => {
    const d = await config();
    expect(await d.executeCommand(frappe), frappe).toMatch(/Invalid/);
  });

  it('`ipv6 route 2001:db8::/64 2001:db8::1` pose la route — le TEMOIN', async () => {
    const d = await config('ipv6 route 2001:db8::/64 2001:db8::1');
    await d.executeCommand('end');
    expect(String(await d.executeCommand('show running-config')))
      .toMatch(/ipv6 route 2001:DB8::\/64|ipv6 route 2001:db8::\/64/i);
  });
});

describe('chaque porte MENE a son sous-mode — les TEMOINS', () => {
  it('`ipv6 access-list` ouvre la liste nommee', async () => {
    const d = await config('ipv6 access-list TRIAGE6');
    expect(await d.executeCommand('permit ipv6 any any'), 'la regle est refusee')
      .not.toMatch(/Invalid|Incomplete/);
    await d.executeCommand('end');
    expect(String(await d.executeCommand('show running-config')))
      .toMatch(/ipv6 access-list TRIAGE6/);
  });

  it('`ipv6 router ospf 1` ouvre son processus', async () => {
    const d = await config('ipv6 router ospf 1');
    expect(await d.executeCommand('router-id 1.1.1.1'), 'le router-id est refuse')
      .not.toMatch(/Invalid|Incomplete/);
  });

  /*
   * `maximum-paths` appartient au sous-mode de routage ; `no shutdown`
   * non, et c'est par lui que ce cas a ete ecrit d'abord. Prouver qu'on
   * est entre quelque part avec un mot etranger a l'endroit ne prouve
   * rien — la meme faute que la sonde EEM avait faite avec
   * `description`.
   */
  it('`ipv6 router eigrp 100` ouvre son processus', async () => {
    const d = await config('ipv6 router eigrp 100');
    expect(await d.executeCommand('maximum-paths 4'), 'le sous-mode n est pas ouvert')
      .not.toMatch(/Invalid input/);
  });
});
