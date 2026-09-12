/*
 * Quatre commandes de la configuration globale de securite passent au
 * socle, et l'une d'elles acceptait n'importe quelle queue.
 *
 * `ip multicast-routing` et sa negation etaient enregistres GLOUTONS
 * alors qu'ils ne lisent aucun argument :
 *
 *     ip multicast-routing zorglub   ->  ACCEPTE, le mot est ignore
 *
 * Un drapeau qui accepte un argument qu'il jette est un critere range
 * sans etre evalue. L'operateur croit avoir restreint quelque chose, et
 * la machine a simplement mis le drapeau a vrai.
 *
 * Les trois autres — `control-plane`, `parameter-map type inspect <nom>`
 * et la negation du multicast — sont un DEPLACEMENT : elles n'avaient
 * pas de defaut, elles etaient encore dans l'ancien moteur.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. ce que le moteur n'evalue pas est REFUSE, pas ignore ;
 *   2. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   3. une porte MENE a son sous-mode ;
 *   4. ce qu'on pose se relit.
 *
 * Discriminee contre l'etat d'avant : 4 des 10 cas tombent — les deux
 * queues ignorees par le multicast, l'arite de `parameter-map`, et
 * l'inventaire. Les 6 temoins disent ce qui ne devait pas bouger : les
 * deux drapeaux gardent le `<cr>` qu'ils TIENNENT, `parameter-map type
 * inspect INSPECTION` passe toujours, `control-plane` ouvre toujours son
 * sous-mode, et le multicast pose se relit toujours dans la
 * configuration avant comme apres sa negation.
 *
 * `control-plane zorglub` etait deja refuse, seul des trois : il est
 * enregistre NON glouton. C'est le temoin qui designe la faute des deux
 * autres — la meme commande ecrite gloutonne accepte ce que la
 * non-gloutonne refuse, sans que rien dans le code ne dise pourquoi.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
  getShell: () => { getActiveTrie(): { enumerateExecutablePaths(): string[] } };
};

const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

async function config(...prelude: string[]): Promise<Cli> {
  const d = new CiscoRouter(`X${serie++}`, 2, 2) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', 'configure terminal', ...prelude]) await d.executeCommand(c);
  return d;
}

describe('un drapeau ne prend pas d argument', () => {
  it.each([
    'ip multicast-routing zorglub',
    'no ip multicast-routing zorglub',
    'control-plane zorglub',
  ])('`%s` est refuse', async (frappe) => {
    const d = await config();
    expect(await d.executeCommand(frappe), frappe).toMatch(/Invalid input/);
  });

  it.each(['ip multicast-routing', 'control-plane'])(
    '`%s ?` promet un `<cr>` qui TIENT — le TEMOIN', async (frappe) => {
      const d = await config();
      expect(annonceCr(d.cliHelp(`${frappe} `)), frappe).toBe(true);
      expect(await d.executeCommand(frappe), frappe).not.toMatch(/Invalid|Incomplete/);
    });
});

describe('`parameter-map type inspect` exige son nom', () => {
  it('la tete est incomplete, et son aide le dit', async () => {
    const d = await config();
    expect(annonceCr(d.cliHelp('parameter-map type inspect '))).toBe(false);
    expect(await d.executeCommand('parameter-map type inspect'))
      .toMatch(/Incomplete command/);
  });

  it('`parameter-map type inspect INSPECTION` passe — le TEMOIN', async () => {
    const d = await config();
    expect(await d.executeCommand('parameter-map type inspect INSPECTION'))
      .not.toMatch(/Invalid|Incomplete/);
  });
});

describe('`control-plane` MENE a son sous-mode — le TEMOIN', () => {
  it('on y entre et on en sort', async () => {
    const d = await config();
    expect(await d.executeCommand('control-plane')).not.toMatch(/Invalid|Incomplete/);
    expect(await d.executeCommand('service-policy input ZORGLUB'),
      'le sous-mode n a pas ete atteint').not.toMatch(/Invalid input detected/);
    expect(await d.executeCommand('exit')).not.toMatch(/Invalid|Incomplete/);
  });
});

describe('le multicast pose se relit — le TEMOIN', () => {
  it('`ip multicast-routing` puis sa negation', async () => {
    const d = await config('ip multicast-routing');
    await d.executeCommand('end');
    expect(String(await d.executeCommand('show running-config')))
      .toMatch(/^ip multicast-routing$/m);
    await d.executeCommand('configure terminal');
    await d.executeCommand('no ip multicast-routing');
    await d.executeCommand('end');
    expect(String(await d.executeCommand('show running-config')),
      'le drapeau survit a son retrait').not.toMatch(/^ip multicast-routing$/m);
  });
});

describe('l arbre ne porte plus ces chemins', () => {
  it('en configuration globale', async () => {
    const d = await config();
    const chemins = d.getShell().getActiveTrie().enumerateExecutablePaths();
    for (const chemin of ['control-plane', 'ip multicast-routing',
      'no ip multicast-routing', 'parameter-map type inspect']) {
      expect(chemins, `${chemin} est encore dans l arbre`).not.toContain(chemin);
    }
  });
});
