/*
 * Deux negations etaient restees sur le trie pendant que leur famille
 * passait au socle. Aucune des deux n'avait pu etre appariee a sa forme
 * positive par `undoFromNegatedPaths` :
 *
 *   `no interface`  est declare dans un constructeur
 *   (`buildConfigCommands`), `interface` dans un autre
 *   (`registerInterfaceEntry`) — l'adaptateur n'apparie que ce qu'il
 *   collecte dans le MEME passage.
 *
 *   `no ip nat inside source static network` est un CHEMIN a lui seul,
 *   tandis que la forme positive n'en est pas un : elle est lue par le
 *   glouton `ip nat inside source static`, qui reconnait `network` dans
 *   sa queue. Il n'y avait donc aucun chemin positif a apparier.
 *
 * Ce que la mesure a trouve, chacun etant un defaut a lui seul.
 *
 * 1. La negation NAT n'analysait RIEN.
 *
 *      no ip nat inside source static network zorglub truc   ->   ""
 *
 *    Le gestionnaire passait ses deux mots directement a
 *    `removeStaticEntry`. Deux mots qui ne sont pas des adresses etaient
 *    acceptes en silence — la forme POSITIVE, elle, les valide depuis
 *    toujours (`% Invalid IP address …`). Les deux moities d'une meme
 *    commande ne jugeaient pas la meme chose.
 *
 * 2. Son aide offrait quatre mots dont trois faux, et un `<cr>` menteur.
 *
 *      no ip nat inside source static network ?
 *        A.B.C.D  Inside local address
 *        WORD     Remove network static NAT
 *        tcp      Translate a TCP port
 *        udp      Translate a UDP port
 *        <cr>
 *
 *    `tcp` et `udp` sont des ALTERNATIVES a `network`, pas des suites :
 *    apres `network` ils n'existent pas. Le `WORD` portait la
 *    description de la COMMANDE. Et le `<cr>` promet une validation que
 *    la frappe refuse — `no ip nat inside source static network` seul
 *    repond `% Incomplete command.`
 *
 * 3. La forme POSITIVE n'annoncait pas `network`, alors qu'elle
 *    l'accepte.
 *
 *      ip nat inside source static ?   ->   A.B.C.D / tcp / udp
 *
 *    La configuration rend pourtant `ip nat inside source static network
 *    10.0.0.0 200.0.0.0 /24`. Le mot etait donc executable, rendu, et
 *    tu — pendant que sa NEGATION l'annoncait. Les deux moities se
 *    contredisaient sur l'existence meme du mot.
 *
 * `no interface` n'avait pas de defaut de comportement : sa place etait
 * deja typee et decrite, ses refus justes. Il est migre parce qu'il
 * reste sur le trie, pas parce qu'il ment — et ses cas ici sont donc des
 * TEMOINS, sauf l'inventaire.
 *
 * Discriminee contre l'etat d'avant (`git stash`) : 10 des 18 cas
 * tombent. Les 8 autres sont nommes :
 *
 *  - TEMOINS de retrait : `no interface Loopback0` et `no interface lo0`
 *    retiraient deja la loopback, et doivent continuer — l'abreviation
 *    comprise, puisque la resolution du nom tape est reprise telle
 *    quelle et non reecrite.
 *  - TEMOINS de refus : le materiel ne part pas
 *    (`no interface GigabitEthernet0/0`), `no interface` nu reste
 *    incomplet, `no interface zorglub` reste refuse. Sans eux, une
 *    migration qui refuserait TOUT passerait pour un succes.
 *  - TEMOIN de pose : `ip nat inside source static network … /24` doit
 *    rester posable et relisible. Il est tombe pendant l'ecriture du
 *    correctif et l'a corrige : declarer `network` comme un chemin a
 *    part coupait la forme POSITIVE, que le glouton lisait jusque-la
 *    dans sa queue. La branche positive a donc ete DEPLACEE du glouton
 *    vers le chemin declare, plutot que dupliquee.
 *  - TEMOIN d'adresse valide : la negation doit encore retirer ce
 *    qu'elle vise quand ses deux adresses sont bonnes.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const MOT = /^\s\s(\S+)/;

const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

const motsDe = (aide: string): string[] =>
  aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);

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

const STATIQUE_RESEAU = 'ip nat inside source static network 10.0.0.0 200.0.0.0 /24';

describe('la negation NAT juge ses adresses comme la pose les juge', () => {
  it.each([
    'no ip nat inside source static network zorglub truc',
    'no ip nat inside source static network 10.0.0.0 truc',
    'no ip nat inside source static network 999.1.1.1 200.0.0.0',
  ])('`%s` est refuse', async (ligne) => {
    const d = await routeur();
    expect(await d.executeCommand(ligne), ligne).toMatch(/Invalid input/);
  });

  it('une adresse VALIDE retire bien la traduction — le TEMOIN', async () => {
    const d = await routeur(STATIQUE_RESEAU);
    expect(await d.executeCommand(
      'no ip nat inside source static network 10.0.0.0 200.0.0.0'))
      .not.toMatch(/Invalid input|Incomplete/);
    expect(await configuration(d), 'la traduction survit a son retrait')
      .not.toMatch(/ip nat inside source static network/);
  });
});

describe('l\'aide de la negation NAT dit ce que la commande attend', () => {
  it('`no ip nat inside source static network ?` ne promet plus `<cr>`', async () => {
    const d = await routeur();
    expect(annonceCr(d.cliHelp('no ip nat inside source static network '))).toBe(false);
  });

  it.each(['tcp', 'udp', 'WORD'])(
    '`no ip nat inside source static network ?` n\'offre plus `%s`', async (mot) => {
      const d = await routeur();
      expect(motsDe(d.cliHelp('no ip nat inside source static network ')))
        .not.toContain(mot);
    });

  it('elle annonce une adresse', async () => {
    const d = await routeur();
    expect(motsDe(d.cliHelp('no ip nat inside source static network ')))
      .toContain('A.B.C.D');
  });
});

describe('la pose annonce `network`, qu\'elle accepte depuis toujours', () => {
  it('`ip nat inside source static ?` offre `network`', async () => {
    const d = await routeur();
    expect(motsDe(d.cliHelp('ip nat inside source static '))).toContain('network');
  });

  it('et la pose marche toujours — le TEMOIN', async () => {
    const d = await routeur(STATIQUE_RESEAU);
    expect(await configuration(d)).toMatch(
      /ip nat inside source static network 10\.0\.0\.0 200\.0\.0\.0 \/24/);
  });
});

describe('`no interface` garde son comportement — les TEMOINS', () => {
  it.each(['no interface Loopback0', 'no interface lo0'])(
    '`%s` retire la loopback', async (ligne) => {
      const d = await routeur('interface Loopback0', 'exit');
      expect(await d.executeCommand(ligne), ligne).not.toMatch(/Invalid input|Incomplete/);
      expect(await configuration(d)).not.toMatch(/interface Loopback0/);
    });

  it('`no interface GigabitEthernet0/0` reste refuse — le materiel reste', async () => {
    const d = await routeur();
    expect(await d.executeCommand('no interface GigabitEthernet0/0'))
      .toMatch(/Invalid input/);
  });

  it('`no interface` nu reste INCOMPLET', async () => {
    const d = await routeur();
    expect(await d.executeCommand('no interface')).toMatch(/Incomplete command/);
  });

  it('`no interface zorglub` reste refuse', async () => {
    const d = await routeur();
    expect(await d.executeCommand('no interface zorglub')).toMatch(/Invalid input/);
  });

  /*
   * L'aide de la negation etait une SECONDE ecriture : le trie la
   * decrivait par `IFACE  Interface to remove`, quand `interface ?`
   * annonce les TYPES. Les deux moities d'une meme commande decrivaient
   * donc leur place differemment. Une seule declaration porte desormais
   * les deux sens, et elles ne peuvent plus diverger — c'est ce que ce
   * cas mesure, a la place de l'ancien `IFACE`.
   */
  it('`no interface ?` annonce les MEMES types que `interface ?`', async () => {
    const d = await routeur();
    const pose = motsDe(d.cliHelp('interface '));
    expect(pose.length, 'la pose n\'annonce aucun type').toBeGreaterThan(0);
    expect(motsDe(d.cliHelp('no interface '))).toEqual(pose);
  });
});

describe('les deux negations quittent le trie', () => {
  it('l\'arbre de configuration ne les garde plus', () => {
    const shell = (new CiscoRouter(`RX${serie++}`, 0, 0) as unknown as {
      shell: { configTrie: { enumerateExecutablePaths(): string[] } };
    }).shell;
    const restants = shell.configTrie.enumerateExecutablePaths()
      .filter((p) => p === 'no interface'
        || p === 'no ip nat inside source static network');
    expect(restants, `le trie garde ${restants.join(', ')}`).toEqual([]);
  });
});
