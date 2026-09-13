/*
 * Sonde sur une place `REST` qui n'a jamais REFUSE personne.
 *
 * Une place `REST` prend toute la fin de la ligne. Le socle la resolvait
 * sans lui demander si elle ACCEPTE ce qu'on lui donne : n'importe quel
 * mot y entrait, la commande passait pour complete, et `?` annoncait
 * `<cr>`. Deux familles en vivaient :
 *
 *     interface zorglub ?   ->  <cr>   puis  % Invalid interface name
 *     arp zorglub ?         ->  <cr>   puis  % Incomplete command.
 *
 * C'est le contraire de ce qu'une place sert a faire. La regle de ce
 * depot dit qu'on parse A LA FRONTIERE, pour que le refus arrive au rang
 * ou l'operateur s'est trompe plutot qu'au fond du gestionnaire ; une
 * place qui accepte tout ne parse rien, et le caret ne peut plus dire ou.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   2. une forme que la machine ACCEPTE garde son `<cr>` — corriger une
 *      place en refusant ce qui marchait serait un echange, pas une
 *      correction ;
 *   3. un routeur et un Catalyst repondent pareil a la meme frappe.
 *
 * Ce qui est mesure ici n'est PAS l'existence du port. `interface
 * Loopback0` sur un Catalyst annonce `<cr>` et le gestionnaire refuse
 * ensuite : la FORME est bonne, l'instance n'existe pas. Une place
 * decrit une forme ; savoir si le chassis porte ce port n'est pas de son
 * ressort, et le lui demander reviendrait a declarer le materiel dans la
 * grammaire.
 *
 * Le TEXTE du refus n'est pas exige non plus, et c'est delibere : un
 * routeur rend le caret, un Catalyst rend « % Invalid interface name
 * "zorglub" ». Les deux REFUSENT, ce qui est l'invariant mesure ici ;
 * savoir lequel des deux mots IOS emploie sur un Catalyst demanderait la
 * reference, qu'on ne peut pas atteindre depuis ce reseau. La regle de ce
 * depot est alors de ne pas trancher plutot que de deviner, et cette
 * sonde s'y tient — elle exige un refus, pas une formulation.
 *
 * Ce qu'une place `REST` ne sait TOUJOURS pas faire, et que la sonde
 * n'exige donc pas : se renommer au fil des mots. `arp <adresse> ?`
 * annonce encore `A.B.C.D` la ou IOS annoncerait l'adresse materielle,
 * parce qu'une seule place porte toute la fin de la ligne. Declarer deux
 * places typees a la place a ete essaye et RETIRE : la negation d'IOS,
 * `no arp <adresse>`, se passe de l'adresse materielle, et l'adaptateur
 * replie la forme niee sur la positive — deux places exigees cassaient
 * donc `no arp`, ce que la suite `arp-slice` a dit tout de suite. La
 * place declare desormais COMBIEN de mots elle attend, ce qui suffit a
 * rendre son `<cr>` honnete sans toucher a la negation.
 *
 * Discriminee contre l'etat d'avant : 8 des 16 cas tombent. Les 8 qui
 * passent des deux cotes sont nommes :
 *
 *   - `interface Fa0/1` sur un Catalyst, `interface GigabitEthernet0/1`
 *     et `interface Loopback0` sur un routeur, `interface range
 *     FastEthernet0/1 - 2` sur un Catalyst et `arp 10.0.0.1
 *     0011.2233.4455 arpa` sur les deux gardaient deja leur `<cr>` et
 *     s'executaient. Ce sont les TEMOINS, et ils sont la moitie qui
 *     compte : la place devait apprendre a refuser SANS rien perdre de
 *     ce qu'elle acceptait, et `interface range` a failli y passer — le
 *     mot `range` etait annonce comme une FORME du nom d'interface au
 *     lieu d'etre un mot-cle, si bien que le premier resserrement le
 *     refusait avec le reste.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

async function routeur(): Promise<Cli> {
  const d = new CiscoRouter(`X${serie++}`, 2, 2) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', 'configure terminal']) await d.executeCommand(c);
  return d;
}

async function commutateur(): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', 'configure terminal']) await d.executeCommand(c);
  return d;
}

const PLATEFORMES: ReadonlyArray<readonly [string, () => Promise<Cli>]> = [
  ['routeur', routeur],
  ['commutateur', commutateur],
];

for (const [plateforme, fabrique] of PLATEFORMES) {
  describe(`une place qui refuse ne promet pas \`<cr>\`, sur un ${plateforme}`, () => {
    it.each([
      'interface zorglub',
      'arp zorglub',
      'arp 10.0.0.1',
      'interface range',
    ])('`%s ?`', async (frappe) => {
      const d = await fabrique();
      expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`).toBe(false);
      expect(await d.executeCommand(frappe), frappe).toMatch(/Invalid|Incomplete/);
    });

    it('`arp 10.0.0.1 0011.2233.4455 arpa` garde son `<cr>` — le TEMOIN', async () => {
      const d = await fabrique();
      expect(annonceCr(d.cliHelp('arp 10.0.0.1 0011.2233.4455 arpa '))).toBe(true);
      expect(await d.executeCommand('arp 10.0.0.1 0011.2233.4455 arpa'))
        .not.toMatch(/Invalid|Incomplete/);
    });

    it('`arp ?` annonce une ADRESSE', async () => {
      const d = await fabrique();
      expect(d.cliHelp('arp ')).toMatch(/A\.B\.C\.D/);
    });
  });
}

describe('les formes que la machine accepte gardent leur `<cr>` — les TEMOINS', () => {
  it.each([
    ['interface GigabitEthernet0/1', routeur],
    ['interface Loopback0', routeur],
  ] as Array<[string, () => Promise<Cli>]>)('`%s`', async (frappe, fabrique) => {
    const d = await fabrique();
    expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? tait <cr>`).toBe(true);
    expect(await d.executeCommand(frappe), frappe).not.toMatch(/Invalid|Incomplete/);
  });

  it.each([
    'interface FastEthernet0/1',
    'interface range FastEthernet0/1 - 2',
  ])('`%s`, sur un Catalyst', async (frappe) => {
    const d = await commutateur();
    expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? tait <cr>`).toBe(true);
    expect(await d.executeCommand(frappe), frappe).not.toMatch(/Invalid|Incomplete/);
  });
});
