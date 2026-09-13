/*
 * `no errdisable recovery cause psecure-violation` etait REFUSE, et la
 * famille etait migree a moitie.
 *
 * Trois de ses quatre chemins passaient par l'adaptateur du trie
 * (`DAI_CHEMINS`) et vivaient donc au socle ; le quatrieme,
 * `psecure-violation`, etait enregistre a part sur `configTrie` et n'y
 * figurait pas. Une famille a moitie migree oblige a se demander, pour
 * chaque frappe, quel moteur repond — la meme situation que `key chain`,
 * la porte EEM et `clock` plus tot dans cette campagne.
 *
 * Ce qui a ete mesure, avant correctif :
 *
 *   errdisable recovery cause psecure-violation        ->  (accepte)
 *   no errdisable recovery cause psecure-violation     ->  ^ % Invalid input
 *   no errdisable recovery cause bpduguard             ->  ^ % Invalid input
 *   no errdisable recovery cause arp-inspection        ->  ^ % Invalid input
 *
 * Le caret tombe sous `no` : la negation n'existe pour AUCUNE des quatre
 * causes. Or IOS la documente — c'est la facon de rendre une cause a son
 * etat par defaut — et ce moteur sait deja la porter : chaque cause a son
 * compteur de secondes (`_setPsecRecoverySec`, `_setArpRecoverySec`,
 * `_setBpduGuardRecoverySec`), la pose l'amene a 30, et
 * `show running-config` n'ecrit la ligne que s'il est strictement
 * positif. Le remettre a zero EST la negation, et rien ne manquait pour
 * l'ecrire.
 *
 * Un troisieme defaut, dans l'aide, et il est d'une autre nature :
 *
 *   errdisable ?                  recovery  Auto-recover DAI err-disabled ports
 *   errdisable recovery cause ?   cause     Auto-recover DAI err-disabled ports
 *
 * « DAI » est la description de la cause `arp-inspection`, la PREMIERE
 * declaree. Un noeud intermediaire qui n'est pas lui-meme une commande
 * herite de la description de son premier descendant, donc le nom de
 * TOUTES les branches devenait celui d'UNE d'entre elles. C'est le
 * defaut que les legendes du socle existent pour refermer, et deux
 * legendes le referment ici.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau, donc la sonde n'exige aucun libelle precis pour ces deux
 * noeuds : elle exige seulement qu'ils ne portent PAS la description
 * d'une de leurs branches, ce qui se verifie sans citation.
 *
 * Discriminee contre l'etat d'avant (`git stash`) : 6 des 14 cas
 * tombent — les quatre negations (trois causes, plus la verification
 * qu'elle retire bien la ligne de la configuration), et les deux
 * legendes, chacune comptee sur son noeud. Les 8 autres sont des
 * NON-REGRESSIONS et des TEMOINS : les trois causes se posent et se
 * relisent, la cause inconnue est refusee au caret, `cause` nu est
 * incomplete, la borne de l'intervalle est appliquee, et l'intervalle
 * pose se relit. Sans ces derniers, retirer une declaration du trie
 * pour la remettre au socle pourrait perdre la commande sans que la
 * sonde en sache rien.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const MOT = /^\s\s(\S+)/;
const descriptionDe = (aide: string, mot: string): string | undefined => {
  for (const ligne of aide.split('\n')) {
    const m = MOT.exec(ligne);
    if (m?.[1] === mot) return ligne.trim().split(/\s{2,}/)[1];
  }
  return undefined;
};

let serie = 0;

async function config(...prelude: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `S${serie++}`, 8) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', 'configure terminal', ...prelude]) await d.executeCommand(c);
  return d;
}

async function runningConfig(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return String(await d.executeCommand('show running-config'));
}

const CAUSES = ['arp-inspection', 'bpduguard', 'psecure-violation'];

describe('`errdisable recovery` est declaree UNE fois, negation comprise', () => {
  describe('les quatre chemins se posent et se relisent', () => {
    it.each(CAUSES)('`errdisable recovery cause %s`', async (cause) => {
      const d = await config(`errdisable recovery cause ${cause}`);
      expect(await runningConfig(d)).toMatch(
        new RegExp(`errdisable recovery cause ${cause}`));
    });

    it('`errdisable recovery interval 90` se relit', async () => {
      const d = await config('errdisable recovery cause bpduguard',
        'errdisable recovery interval 90');
      expect(await runningConfig(d)).toMatch(/errdisable recovery interval 90/);
    });
  });

  describe('la negation retire la cause', () => {
    it.each(CAUSES)('`no errdisable recovery cause %s` est accepte', async (cause) => {
      const d = await config(`errdisable recovery cause ${cause}`);
      expect(await d.executeCommand(`no errdisable recovery cause ${cause}`), cause)
        .not.toMatch(/Invalid input|Incomplete/);
    });

    it('la ligne disparait de la configuration', async () => {
      const d = await config('errdisable recovery cause psecure-violation',
        'no errdisable recovery cause psecure-violation');
      expect(await runningConfig(d), 'la cause survit a son retrait')
        .not.toMatch(/errdisable recovery cause psecure-violation/);
    });
  });

  describe('l aide ne prend pas une branche pour le tronc', () => {
    it('`errdisable ?` ne decrit pas `recovery` par une de ses causes', async () => {
      const d = await config();
      expect(descriptionDe(d.cliHelp('errdisable '), 'recovery'))
        .not.toMatch(/DAI|arp/i);
    });

    it('`errdisable recovery ?` ne decrit pas `cause` par une de ses causes', async () => {
      const d = await config();
      expect(descriptionDe(d.cliHelp('errdisable recovery '), 'cause'))
        .not.toMatch(/DAI|arp/i);
    });

    it('chaque cause garde SA description — les TEMOINS', async () => {
      const d = await config();
      const aide = d.cliHelp('errdisable recovery cause ');
      expect(descriptionDe(aide, 'arp-inspection')).toMatch(/DAI/);
      expect(descriptionDe(aide, 'bpduguard')).toMatch(/BPDU/);
      expect(descriptionDe(aide, 'psecure-violation')).toMatch(/port-security/);
    });
  });

  describe('ce que le moteur n evalue pas est refuse', () => {
    it('une cause inconnue est refusee au caret', async () => {
      const d = await config();
      expect(await d.executeCommand('errdisable recovery cause zorglub'))
        .toMatch(/Invalid input/);
    });

    it('`errdisable recovery cause` nu est incomplete', async () => {
      const d = await config();
      expect(await d.executeCommand('errdisable recovery cause'))
        .toMatch(/Incomplete command/);
    });

    it('la borne annoncee de l\'intervalle est appliquee', async () => {
      const d = await config();
      expect(await d.executeCommand('errdisable recovery interval 5'))
        .toMatch(/Invalid input/);
    });
  });
});
