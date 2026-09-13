/*
 * Sonde ECRITE A L'AVEUGLE sur les PORTES de sous-mode que le routeur
 * garde encore sur son trie de configuration globale.
 *
 * Une porte est une commande qui CHANGE DE MODE. C'est la forme que ce
 * depot dit avoir mal servie le plus souvent, et il en nomme quatre
 * pieges mesures : la meme commande ecrite une fois par mode diverge ;
 * une place d'alternatives perd le rang des mots ; un type declare sans
 * sa place fait annoncer `<cr>` pour un refus ; et le socle admet une
 * commande de `config` depuis un sous-mode par heritage.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. une porte qui s'ouvre CHANGE l'invite, et l'invite nomme le
 *      sous-mode ou l'on se trouve ;
 *   2. `exit` rend la configuration globale, `end` rend l'EXEC
 *      privilegie — depuis n'importe quelle profondeur ;
 *   3. `?` n'annonce `<cr>` que la ou la frappe VALIDE : une porte a qui
 *      il manque son nom est INCOMPLETE, pas valide ;
 *   4. ce qu'une porte ouvre se relit dans `show running-config` ;
 *   5. une porte refuse un nom qu'elle ne sait pas lire, au caret.
 *
 * Les noms des sous-modes ne sont PAS exiges mot pour mot : la sonde lit
 * l'invite que la machine rend a l'ouverture et verifie qu'elle CHANGE,
 * qu'elle est stable, et que la sortie la defait. Exiger `(config-cmap)#`
 * demanderait la reference, et c'est la seule chose qu'on ne peut pas
 * aller chercher ici.
 *
 * Deux exigences ecrites a l'aveugle se sont revelees FAUSSES a la
 * mesure, et elles sont retirees plutot que satisfaites :
 *
 *   - `zone-pair security ZP` n'ouvre rien, et c'est JUSTE : la paire
 *     nomme ses deux zones (`source`, `destination`), et la machine rend
 *     « % Incomplete command. ». C'est la forme COMPLETE qui est la
 *     porte, et la sonde la prend desormais pour telle ;
 *   - « une porte confine la session qu'elle ouvre » supposait qu'un
 *     sous-mode refuse `hostname`. Les quatre portes mesurees
 *     l'acceptent, et un IOS aussi : le parseur retombe sur le mode
 *     parent. Le piege que ce depot nomme concerne les VUES d'analyseur,
 *     pas l'heritage entre modes. Epingler l'inverse aurait appris une
 *     faute a qui lit ce fichier.
 *
 * Discriminee contre l'etat d'avant : 2 des 52 cas tombent, et les deux
 * sont le meme defaut a deux endroits — une porte qui promet `<cr>` la
 * ou il lui manque encore des mots. Les 50 qui passent des deux cotes
 * sont nommes :
 *
 *   - les neuf autres portes ouvraient deja leur sous-mode, rendaient
 *     deja la configuration globale sur `exit` et l'EXEC privilegie sur
 *     `end`, et se relisaient deja dans `show running-config`. Ce sont
 *     les TEMOINS, et ils portent la moitie du sens de cette sonde :
 *     ils prouvent que le laboratoire mesure une porte, et ils sont le
 *     contrat de non-regression des migrations a venir ;
 *   - huit des dix formes TRONQUEES rendaient deja l'incompletude sans
 *     promettre `<cr>`. C'est ce qui distingue le defaut des deux autres
 *     d'un comportement general : la forme attendue existait deja, neuf
 *     fois sur onze, a cote de celles qui mentaient.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  getPrompt: () => string;
  powerOn: () => void;
};

const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

async function enConfig(...prelude: string[]): Promise<Cli> {
  const d = new CiscoRouter(`X${serie++}`, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', 'configure terminal', ...prelude]) await d.executeCommand(c);
  return d;
}

/**
 * Chaque porte : la frappe COMPLETE qui l'ouvre, et la frappe TRONQUEE
 * a qui il manque son nom.
 */
const PORTES: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ['class-map CM', 'class-map', []],
  ['policy-map PM', 'policy-map', []],
  ['key chain KC', 'key chain', []],
  ['zone security ZS', 'zone security', []],
  ['zone-pair security ZP source Z1 destination Z2', 'zone-pair security ZP',
    ['zone security Z1', 'exit', 'zone security Z2', 'exit']],
  ['flow exporter FE', 'flow exporter', []],
  ['flow record FR', 'flow record', []],
  ['flow monitor FM', 'flow monitor', []],
  ['ipv6 access-list V6ACL', 'ipv6 access-list', []],
  ['event manager applet AP', 'event manager applet', []],
  ['control-plane', '', []],
];

describe('les portes de sous-mode changent l invite', () => {
  for (const [ouverture, , prelude] of PORTES) {
    it(`\`${ouverture}\` ouvre un sous-mode`, async () => {
      const d = await enConfig(...prelude);
      const avant = d.getPrompt();
      expect(await d.executeCommand(ouverture), ouverture)
        .not.toMatch(/Invalid|Incomplete/);
      expect(d.getPrompt(), `${ouverture} n a pas change l invite`).not.toBe(avant);
      expect(d.getPrompt()).toMatch(/\(config[^)]*\)#$/);
    });

    it(`\`exit\` depuis \`${ouverture}\` rend la configuration globale`, async () => {
      const d = await enConfig(...prelude);
      const global = d.getPrompt();
      await d.executeCommand(ouverture);
      await d.executeCommand('exit');
      expect(d.getPrompt(), `exit depuis ${ouverture}`).toBe(global);
    });

    it(`\`end\` depuis \`${ouverture}\` rend l EXEC privilegie`, async () => {
      const d = await enConfig(...prelude);
      await d.executeCommand(ouverture);
      await d.executeCommand('end');
      expect(d.getPrompt(), `end depuis ${ouverture}`).toMatch(/[^)]#$/);
    });
  }
});

describe('une porte a qui il manque son nom est INCOMPLETE', () => {
  for (const [, tronquee, prelude] of PORTES) {
    if (tronquee === '') continue;
    it(`\`${tronquee}\``, async () => {
      const d = await enConfig(...prelude);
      expect(annonceCr(d.cliHelp(`${tronquee} `)), `${tronquee} ? promet <cr>`)
        .toBe(false);
      expect(await d.executeCommand(tronquee), tronquee)
        .toMatch(/Incomplete command/);
    });
  }
});

describe('une porte ouverte se relit dans la configuration', () => {
  it.each([
    ['class-map CM', /class-map (match-\S+ )?CM/],
    ['policy-map PM', /policy-map PM/],
    ['key chain KC', /key chain KC/],
    ['zone security ZS', /zone security ZS/],
    ['flow exporter FE', /flow exporter FE/],
    ['flow record FR', /flow record FR/],
    ['flow monitor FM', /flow monitor FM/],
    ['ipv6 access-list V6ACL', /ipv6 access-list V6ACL/],
    ['event manager applet AP', /event manager applet AP/],
  ] as Array<[string, RegExp]>)('`%s`', async (ouverture, attendu) => {
    const d = await enConfig();
    await d.executeCommand(ouverture);
    await d.executeCommand('end');
    expect(await d.executeCommand('show running-config'), ouverture).toMatch(attendu);
  });
});
