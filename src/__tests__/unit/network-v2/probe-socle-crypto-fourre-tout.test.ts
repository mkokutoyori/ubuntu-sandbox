/*
 * Le dernier chemin du trie etait le fourre-tout `crypto`. Il est
 * DELIBERE : une ligne `crypto` que ce simulateur ne sait pas honorer
 * est RETENUE telle quelle plutot que refusee, pour qu'un import de
 * topologie ne perde pas ce que la machine reelle garde. Ce lot ne
 * change pas ce choix — il le declare sur le socle, et ferme les trois
 * ecarts que la mesure a trouves AUTOUR de lui.
 *
 * 1. Sur le ROUTEUR, l'aide proposait des mots la ou ils ne veulent
 *    plus rien dire.
 *
 *      crypto zorglub ?  ->  gdoi / ikev2 / ipsec / isakmp / pki / <cr>
 *
 *    Une fois `zorglub` tape, la ligne est deja une ligne inconnue que
 *    le fourre-tout retiendra en entier. Proposer `ipsec` a cette place
 *    laisse croire a une suite qui existerait ; `crypto zorglub ipsec`
 *    est simplement range tel quel. Ce sont les mots-cles de completion
 *    du glouton, qui fuient vers un noeud ou ils n'ont pas de sens.
 *
 * 2. Les deux plateformes ne disaient pas la meme chose de `crypto ?`.
 *
 *      Routeur  : dynamic-map / gdoi / ikev2 / ipsec / isakmp / key /
 *                 keyring / map / pki
 *      Catalyst : WORD  Encryption module
 *                 key
 *
 *    Le Catalyst annoncait une place LIBRE portant la description de la
 *    COMMANDE, la ou le routeur n'annonce que ses vraies sous-commandes.
 *    Or aucune machine Cisco n'annonce un mot libre derriere `crypto` :
 *    le fourre-tout est un filet, pas une syntaxe. Il se declare donc
 *    CACHE — il retient toujours, il ne s'annonce plus.
 *
 * 3. Le cas particulier `crypto key` disparait de lui-meme.
 *
 *    Le gestionnaire portait un test ecrit a la main — « si le premier
 *    mot est `key`, refuser au caret » — parce que le socle porte
 *    ENTIEREMENT `crypto key generate`/`zeroize` et qu'y retenir une
 *    forme inconnue rejouerait a l'import une ligne que la meme machine
 *    refuse. Sur le socle ce test n'a plus lieu d'etre : un mot-cle
 *    DECLARE l'emporte sur la place libre, donc `crypto key zorglub`
 *    descend dans le sous-arbre `crypto key` et s'y fait refuser sans
 *    que personne ait a l'ecrire.
 *
 * Ce que ce lot NE change pas, et pourquoi. `crypto ipsec zorglub` est
 * refuse au caret sur le ROUTEUR et retenu sur le CATALYST : le routeur
 * declare un sous-arbre `crypto ipsec`, le Catalyst n'en a pas. C'est
 * une difference de PLATEFORME, pas d'engin — un Catalyst n'a pas
 * d'IPSec — et la corriger demanderait de decider si un Catalyst doit
 * refuser `crypto ipsec` au caret comme le ferait la vraie machine, ou
 * le retenir comme le filet le veut. Les deux se defendent, la source
 * qui trancherait n'est pas atteignable depuis ce reseau, et le lot ne
 * tranche donc pas.
 *
 * Discriminee contre l'etat d'avant (`git stash`) : 4 des 23 cas
 * tombent — la place libre annoncee par le Catalyst, la fuite des mots
 * du second rang sur le routeur, et les deux inventaires. Les 19 autres
 * sont ce qui empeche de confondre « declarer le filet » avec
 * « supprimer le filet » :
 *
 *  - TEMOINS du filet : trois lignes inconnues doivent RESTER retenues
 *    dans la configuration, sur les DEUX plateformes. C'est la raison
 *    d'etre du fourre-tout, et le cas qui tombe si on le remplace par un
 *    refus.
 *  - TEMOINS du cas particulier : `crypto key zorglub` doit rester
 *    refuse et `crypto key` nu rester incomplet, alors meme que le test
 *    ecrit a la main qui les produisait a DISPARU. S'ils tombaient, le
 *    filet aurait avale une forme que le socle refuse, et l'import
 *    rejouerait une ligne que la machine refuse.
 *  - TEMOINS de ce qui est declare : `crypto key ?` garde ses deux
 *    formes, `crypto ?` garde les sous-commandes du routeur,
 *    `crypto key generate rsa` reclame toujours son nom de domaine, et
 *    `crypto map …` se pose et se relit.
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

const motsDe = (aide: string): string[] =>
  aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);

let serie = 0;

type Fabrique = () => Cli;

const PLATEFORMES: ReadonlyArray<readonly [string, Fabrique]> = [
  ['routeur', () => new CiscoRouter(`R${serie++}`, 0, 0) as unknown as Cli],
  ['catalyst', () => new CiscoSwitch('switch-cisco', `S${serie++}`, 8) as unknown as Cli],
];

async function config(faire: Fabrique, ...prelude: string[]): Promise<Cli> {
  const d = faire();
  d.powerOn();
  for (const c of ['enable', 'configure terminal', ...prelude]) await d.executeCommand(c);
  return d;
}

async function configuration(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return String(await d.executeCommand('show running-config'));
}

describe('le filet retient toujours — les TEMOINS', () => {
  describe.each(PLATEFORMES)('sur le %s', (_nom, faire) => {
    it.each(['crypto zorglub', 'crypto zorglub truc machin', 'crypto engine zorglub'])(
      '`%s` est retenu dans la configuration', async (ligne) => {
        const d = await config(faire, ligne);
        expect(await configuration(d), ligne).toContain(ligne);
      });

    it('`crypto` nu reste INCOMPLET', async () => {
      const d = await config(faire);
      expect(await d.executeCommand('crypto')).toMatch(/Incomplete command/);
    });

    it('`crypto key zorglub` reste refuse au caret', async () => {
      const d = await config(faire);
      expect(await d.executeCommand('crypto key zorglub')).toMatch(/Invalid input/);
    });

    it('`crypto key` nu reste INCOMPLET', async () => {
      const d = await config(faire);
      expect(await d.executeCommand('crypto key')).toMatch(/Incomplete command/);
    });

    it('`crypto key ?` annonce toujours ses deux formes', async () => {
      const d = await config(faire);
      expect(motsDe(d.cliHelp('crypto key ')))
        .toEqual(expect.arrayContaining(['generate', 'zeroize']));
    });
  });
});

describe('le filet ne s\'annonce plus comme une syntaxe', () => {
  it('`crypto ?` n\'offre plus de mot LIBRE sur le catalyst', async () => {
    const d = await config(PLATEFORMES[1][1]);
    expect(motsDe(d.cliHelp('crypto '))).not.toContain('WORD');
  });

  it('et garde ce qu\'il declare vraiment', async () => {
    const d = await config(PLATEFORMES[1][1]);
    expect(motsDe(d.cliHelp('crypto '))).toContain('key');
  });

  it('`crypto ?` garde ses sous-commandes sur le routeur — le TEMOIN', async () => {
    const d = await config(PLATEFORMES[0][1]);
    expect(motsDe(d.cliHelp('crypto ')))
      .toEqual(expect.arrayContaining(['ipsec', 'isakmp', 'key', 'map', 'pki']));
  });

  it('`crypto zorglub ?` n\'offre plus les mots du second rang', async () => {
    const d = await config(PLATEFORMES[0][1]);
    const mots = motsDe(d.cliHelp('crypto zorglub '));
    for (const fuite of ['gdoi', 'ikev2', 'ipsec', 'isakmp', 'pki']) {
      expect(mots, `crypto zorglub ? propose ${fuite}`).not.toContain(fuite);
    }
  });
});

describe('les formes declarees passent toujours — les TEMOINS', () => {
  it('`crypto key generate rsa` reclame toujours le nom de domaine', async () => {
    const d = await config(PLATEFORMES[0][1]);
    expect(await d.executeCommand('crypto key generate rsa'))
      .toMatch(/define a domain-name first/);
  });

  it('`crypto map ZORG 10 ipsec-isakmp` reste accepte et relu', async () => {
    const d = await config(PLATEFORMES[0][1], 'crypto map ZORG 10 ipsec-isakmp');
    expect(await configuration(d)).toMatch(/crypto map ZORG 10 ipsec-isakmp/);
  });

  it('`crypto ipsec zorglub` reste refuse sur le routeur', async () => {
    const d = await config(PLATEFORMES[0][1]);
    expect(await d.executeCommand('crypto ipsec zorglub')).toMatch(/Invalid input/);
  });
});

describe('le trie est VIDE', () => {
  it.each(PLATEFORMES)('sur le %s, plus un seul chemin', (_nom, faire) => {
    const shell = (faire() as unknown as {
      shell: Record<string, { enumerateExecutablePaths(): string[] } | undefined>;
    }).shell;
    const restants: string[] = [];
    for (const cle of Object.keys(shell)) {
      const arbre = shell[cle];
      if (!arbre || typeof arbre.enumerateExecutablePaths !== 'function') continue;
      for (const chemin of arbre.enumerateExecutablePaths()) restants.push(`${cle}:${chemin}`);
    }
    expect(restants, `il reste ${restants.join(', ')}`).toEqual([]);
  });
});
