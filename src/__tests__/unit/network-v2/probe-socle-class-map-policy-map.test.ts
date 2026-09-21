/*
 * `class-map` et `policy-map` etaient deux gloutons qui relisaient leur
 * ligne a la main. Quatre defauts mesures, de trois familles.
 *
 * 1. `inspect` etait annonce EN TETE, ou il ne veut rien dire.
 *
 *      class-map ?   ->  inspect / match-all / match-any / type
 *
 *    `inspect` n'existe qu'APRES `type`. Tape en tete il n'est pas un
 *    mot-cle du tout : `class-map inspect` cree une classe NOMMEE
 *    « inspect », et `class-map inspect NOM` est refuse au caret. Le mot
 *    etait donc offert a une place ou il change de sens.
 *
 * 2. La place du NOM n'etait PAS annoncee.
 *
 *    `class-map ?` n'offrait aucun `WORD`, alors que le nom est le seul
 *    argument OBLIGATOIRE de la commande — celui sans lequel elle repond
 *    `% Incomplete command.` L'aide listait les options et taisait
 *    l'essentiel.
 *
 * 3. `class-map type ?` annoncait un `WORD` que la commande REFUSE.
 *
 *      class-map type ?      ->  WORD  Define class map
 *      class-map type INSP   ->  % Invalid input detected at '^' marker.
 *
 *    Apres `type`, la seule suite que ce moteur accepte est `inspect`.
 *    Annoncer `WORD` promet un mot libre la ou un seul est admis — et la
 *    description affichee etait celle de la COMMANDE, pas celle de la
 *    place.
 *
 * 4. `no class-map NOM` et `no policy-map NOM` n'existaient pas.
 *
 *    Les deux sont refuses au caret, alors qu'IOS les porte et que c'est
 *    la seule facon de defaire ce que la commande pose. La configuration
 *    rendait bien `class-map match-any VOICE`, donc un rejeu la
 *    recreait ; un operateur, lui, ne pouvait pas la retirer.
 *
 * Ce que ce lot NE touche pas : les descriptions « Match all criteria »
 * et « Match any criterion » restent celles du depot. La documentation
 * atteignable confirme la SEMANTIQUE (match-all est un ET logique,
 * match-any un OU, et match-all est le defaut) mais pas le libelle exact
 * qu'IOS affiche ; cisco.com est bloque au telechargement par le
 * mandataire de sortie de ce reseau. Les reecrire de memoire serait
 * inventer.
 *
 * `type` n'admet qu'`inspect` parce que c'est la seule sorte que ce
 * moteur sache porter. Les autres sortes d'IOS ne sont pas declarees :
 * un critere que le moteur n'evalue pas ne se declare pas.
 *
 * Discriminee contre l'etat d'avant (`git stash`).
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
  getPrompt: () => string;
};

const MOT = /^\s\s(\S+)/;

const motsDe = (aide: string): string[] =>
  aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);

const descriptionDe = (aide: string, mot: string): string | undefined => {
  for (const ligne of aide.split('\n')) {
    if (MOT.exec(ligne)?.[1] === mot) return ligne.trim().split(/\s{2,}/)[1];
  }
  return undefined;
};

let serie = 0;

async function routeur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoRouter(`R${serie++}`, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', 'configure terminal', ...prelude]) await d.executeCommand(c);
  return d;
}

async function configuration(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return String(await d.executeCommand('show running-config'));
}

const FAMILLES = ['class-map', 'policy-map'] as const;

describe('`inspect` n\'est plus annonce la ou il change de sens', () => {
  it.each(FAMILLES)('`%s ?` n\'offre plus `inspect`', async (famille) => {
    const d = await routeur();
    expect(motsDe(d.cliHelp(`${famille} `)), `${famille} ?`).not.toContain('inspect');
  });

  it.each(FAMILLES)('`%s type ?` l\'offre, lui', async (famille) => {
    const d = await routeur();
    expect(motsDe(d.cliHelp(`${famille} type `)), `${famille} type ?`).toContain('inspect');
  });

  it.each(FAMILLES)('`%s type ?` ne promet plus un WORD libre', async (famille) => {
    const d = await routeur();
    expect(motsDe(d.cliHelp(`${famille} type `)), `${famille} type ?`).not.toContain('WORD');
  });
});

describe('la place du NOM est annoncee', () => {
  it.each(FAMILLES)('`%s ?` annonce une place', async (famille) => {
    const d = await routeur();
    expect(motsDe(d.cliHelp(`${famille} `)), `${famille} ?`).toContain('WORD');
  });

  it.each(FAMILLES)('`%s ?` la decrit comme un NOM, pas comme la commande',
    async (famille) => {
      const d = await routeur();
      const description = descriptionDe(d.cliHelp(`${famille} `), 'WORD');
      expect(description, `${famille} ?`).toBeTruthy();
      expect(description).not.toMatch(/Define (class|policy) map/);
    });
});

describe('la negation defait ce que la pose a mis', () => {
  it('`no class-map VOICE` retire la classe', async () => {
    const d = await routeur('class-map match-any VOICE', 'exit');
    expect(await d.executeCommand('no class-map VOICE'))
      .not.toMatch(/Invalid input|Incomplete/);
    expect(await configuration(d), 'la classe survit a son retrait')
      .not.toMatch(/class-map .*VOICE/);
  });

  it('`no policy-map POL` retire la politique', async () => {
    const d = await routeur('policy-map POL', 'exit');
    expect(await d.executeCommand('no policy-map POL'))
      .not.toMatch(/Invalid input|Incomplete/);
    expect(await configuration(d), 'la politique survit a son retrait')
      .not.toMatch(/policy-map POL/);
  });

  it.each(FAMILLES)('`no %s` nu reste INCOMPLET', async (famille) => {
    const d = await routeur();
    expect(await d.executeCommand(`no ${famille}`)).toMatch(/Incomplete command/);
  });

  it('retirer une classe ABSENTE ne fait pas de degat', async () => {
    const d = await routeur();
    expect(await d.executeCommand('no class-map ABSENTE'))
      .not.toMatch(/Invalid input|Incomplete/);
  });
});

describe('ce qui marchait marche encore — les TEMOINS', () => {
  it.each([
    ['class-map VOICE', 'config-cmap'],
    ['class-map match-all VOICE', 'config-cmap'],
    ['class-map match-any VOICE', 'config-cmap'],
    ['class-map type inspect INSP', 'config-cmap'],
    ['policy-map POL', 'config-pmap'],
    ['policy-map type inspect POL', 'config-pmap'],
  ] as Array<[string, string]>)('`%s` entre en `%s`', async (ligne, mode) => {
    const d = await routeur();
    expect(await d.executeCommand(ligne), ligne).not.toMatch(/Invalid input|Incomplete/);
    expect(d.getPrompt()).toContain(mode);
  });

  it.each([
    'class-map type zorglub NOM',
    'class-map VOICE zorglub',
    'policy-map match-all POL',
    'policy-map POL zorglub',
  ])('`%s` reste refuse au caret', async (ligne) => {
    const d = await routeur();
    expect(await d.executeCommand(ligne), ligne).toMatch(/Invalid input/);
  });

  it.each([
    'class-map',
    'class-map type',
    'class-map match-all',
    'policy-map',
    'policy-map type',
  ])('`%s` reste INCOMPLET', async (ligne) => {
    const d = await routeur();
    expect(await d.executeCommand(ligne), ligne).toMatch(/Incomplete command/);
  });

  it('la configuration rend toujours la classe et la politique', async () => {
    const d = await routeur('class-map match-any VOICE', 'exit', 'policy-map POL', 'exit');
    const vue = await configuration(d);
    expect(vue).toMatch(/class-map match-any VOICE/);
    expect(vue).toMatch(/policy-map POL/);
  });

  it.each(FAMILLES)('`%s ?` garde `match-*`/`type` selon la famille', async (famille) => {
    const d = await routeur();
    const mots = motsDe(d.cliHelp(`${famille} `));
    expect(mots).toContain('type');
    if (famille === 'class-map') {
      expect(mots).toEqual(expect.arrayContaining(['match-all', 'match-any']));
    } else {
      expect(mots).not.toContain('match-all');
    }
  });
});

describe('l\'abreviation est celle d\'IOS, plus une egalite de chaines', () => {
  it.each(['class-map type insp VOICE', 'class-map type INSP VOICE', 'class-map ty insp VOICE'])(
    '`%s` pose bien une classe d\'inspection', async (ligne) => {
      const d = await routeur(ligne);
      expect(await configuration(d), ligne).toMatch(/class-map type inspect .*VOICE/);
    });

  it('`class-map type INSP` sans nom est INCOMPLET, pas invalide', async () => {
    const d = await routeur();
    expect(await d.executeCommand('class-map type INSP')).toMatch(/Incomplete command/);
  });
});

describe('les deux commandes quittent le trie', () => {
  it('l\'arbre de configuration ne les garde plus', () => {
    const shell = (new CiscoRouter(`RX${serie++}`, 0, 0) as unknown as {
      shell: { configTrie: { enumerateExecutablePaths(): string[] } };
    }).shell;
    const restants = shell.configTrie.enumerateExecutablePaths()
      .filter((p) => /^(no )?(class-map|policy-map)\b/.test(p));
    expect(restants, `le trie garde ${restants.join(', ')}`).toEqual([]);
  });
});
