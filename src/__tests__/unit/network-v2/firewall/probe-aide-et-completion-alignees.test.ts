/**
 * Sur un FortiGate, `?` et la tabulation repondent a la MEME question.
 *
 * Mesure de depart : elles etaient deja construites sur un seul moteur
 * (`socle.suggestions`), ce qui est la bonne architecture -- mais la
 * tabulation ajoutait une SECONDE source que l'aide ne consultait pas,
 * `viewPathCompletions`, qui marche l'arbre de configuration. Passe le
 * premier niveau, l'aide mourait donc :
 *
 *   show system ?            -> « <cr> » et rien d'autre
 *   show system <Tab>        -> 18 tables
 *   get system ?             -> « <cr> »        / <Tab> -> 22
 *   show firewall ?          -> « <cr> »        / <Tab> -> 14
 *   show system interface ?  -> RIEN DU TOUT    / <Tab> -> 10 interfaces
 *
 * `show`/`get` sont declares au socle avec un unique argument `REST`
 * dont les alternatives ne portent que le PREMIER mot de chaque chemin ;
 * au-dela, le socle n'a plus rien a offrir et seule la tabulation
 * compensait. La meme machine, a la meme position, donnait donc deux
 * reponses.
 *
 * Le correctif suit la regle du depot plutot que de recopier la marche
 * d'arbre dans l'aide : UNE methode, `candidates(input, trigger)`,
 * calcule l'ensemble des propositions ; la tabulation les complete et
 * `?` les decrit. Les deux ne peuvent plus diverger par construction.
 * Les descriptions de l'arbre reutilisent les conventions qui existaient
 * deja (`Existing entry <clef>.`, `Configure <mot>.`), extraites en
 * `existingEntryHelp` et `branchHelp` et lues par leurs DEUX appelants,
 * plutot qu'une seconde ecriture qui aurait fini par diverger.
 *
 * SECOND DEFAUT, trouve par le balayage et corrige dans le socle CLI
 * PARTAGE : `argumentCompletableValues` filtrait les candidats par
 * `/^[A-Za-z0-9][A-Za-z0-9:._-]*$/`, classe qui ne contient pas `+`.
 * Or FortiOS s'en sert : `TACACS+` est un service predefini et `tacacs+`
 * une valeur de `set type` sous `config user local`. La consequence est
 * exacte et mesuree : `set type tacacs+` est ACCEPTE par la machine,
 * ANNONCE par `?`, et la tabulation ne le completait jamais -- ni sur
 * une place vide, ni sur `set type ta<Tab>`. Le role de ce filtre est
 * d'ecarter les GABARITS (`WORD`, `LINE`, `<1-10>`, `A.B.C.D`), que les
 * deux filtres precedents nomment deja et dont aucun ne contient `+`,
 * donc l'elargir ne laisse rentrer aucun gabarit.
 *
 * Le garde-fou est le livrable : il parcourt les prefixes atteignables
 * dans trois contextes et echoue en NOMMANT tout endroit ou les deux
 * listes different. Sa liste ne peut que decroitre.
 *
 * Ce que le garde-fou ne demande deliberement PAS : qu'un GABARIT soit
 * completable. `?` decrit `LINE  Command to execute.` la ou la
 * tabulation n'ecrit rien, et c'est juste -- on ne complete pas un texte
 * libre. Les deux repondent bien la meme chose, elles la rendent
 * differemment ; le balayage retire donc les gabarits avant de comparer.
 *
 * Discrimine par `git stash` sur les trois fichiers cables : 6 cas
 * tombent. Les 2 qui passent des deux cotes sont nommes ici :
 *  - le TEMOIN du premier niveau (`show ?`), qui a toujours fonctionne
 *    et prouve que le laboratoire mesure bien quelque chose ;
 *  - « toute proposition porte une description », qui etait deja vrai --
 *    il garde que les descriptions ajoutees a l'arbre n'ont pas ouvert
 *    de trou.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

const GABARIT = /^(<.*>|[A-Z]\.[A-Z]\.[A-Z]\.[A-Z].*|WORD|LINE|STRING|NAME)$/;

const mot = (ligne: string) => ligne.trim().split(/\s{2,}/)[0];
const description = (ligne: string) => (ligne.trim().split(/\s{2,}/)[1] ?? '').trim();

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); });

function coquille(): FortiShell {
  return new FortiShell(new FortiGate('firewall-fortinet', 'FGT', 0, 0));
}

const proposeParAide = (sh: FortiShell, ligne: string) =>
  sh.help(ligne).map(mot).filter(w => w !== '<cr>' && !GABARIT.test(w));

const proposeParTabulation = (sh: FortiShell, ligne: string) =>
  sh.completions(ligne).map(s => s.split(/\s+/).pop() ?? '');

interface Balayage {
  readonly visites: number;
  readonly divergents: readonly string[];
  readonly sansDescription: readonly string[];
}

function balaye(sh: FortiShell, profondeur = 3): Balayage {
  const divergents: string[] = [];
  const sansDescription: string[] = [];
  let visites = 0;

  const marche = (prefixe: string, restant: number) => {
    if (restant === 0) return;
    visites++;
    const aide = proposeParAide(sh, prefixe);
    const tabulation = proposeParTabulation(sh, prefixe);
    if (JSON.stringify(aide) !== JSON.stringify(tabulation)) {
      divergents.push(`« ${prefixe} » : ?=${JSON.stringify(
        aide.filter(w => !tabulation.includes(w)))} Tab=${JSON.stringify(
        tabulation.filter(w => !aide.includes(w)))}`);
    }
    for (const ligne of sh.help(prefixe)) {
      if (mot(ligne) !== '<cr>' && description(ligne) === '') {
        sansDescription.push(`« ${prefixe} » -> ${mot(ligne)}`);
      }
    }
    for (const suite of aide.slice(0, 6)) marche(`${prefixe}${suite} `, restant - 1);
  };

  marche('', profondeur);
  return { visites, divergents, sansDescription };
}

describe('FortiGate : l aide et la completion sont alignees', () => {
  it('TEMOIN : au premier niveau, les deux ont toujours repondu', () => {
    const sh = coquille();
    expect(proposeParAide(sh, 'show ').length).toBeGreaterThan(0);
    expect(proposeParAide(sh, 'show ')).toEqual(proposeParTabulation(sh, 'show '));
  });

  it('`?` marche l arbre de configuration comme la tabulation', () => {
    const sh = coquille();
    for (const ligne of ['show system ', 'get system ', 'show firewall ']) {
      const aide = proposeParAide(sh, ligne);
      expect(aide.length).toBeGreaterThan(5);
      expect(aide).toEqual(proposeParTabulation(sh, ligne));
    }
  });

  it('`?` nomme les entrees existantes d une table', () => {
    const sh = coquille();
    const aide = sh.help('show system interface ');
    expect(aide.map(mot)).toContain('port1');
    expect(aide.find(l => mot(l) === 'port1')).toContain('Existing entry port1.');
    expect(proposeParAide(sh, 'show system interface '))
      .toEqual(proposeParTabulation(sh, 'show system interface '));
  });

  it('les branches de l arbre portent leur propre description', () => {
    const sh = coquille();
    const ligne = sh.help('show system ').find(l => mot(l) === 'interface');
    expect(ligne).toBeDefined();
    expect(description(ligne!)).toBe('Configure interfaces.');
  });

  it('une valeur portant un `+` se complete', () => {
    const sh = coquille();
    sh.execute('config user local');
    sh.execute('edit "zoe"');
    expect(sh.help('set type ').map(mot)).toContain('tacacs+');
    expect(sh.completions('set type ')).toContain('set type tacacs+');
    expect(sh.completions('set type ta')).toEqual(['set type tacacs+']);
    expect(sh.execute('set type tacacs+')).toBe('');
  });

  it('un service predefini portant un `+` se complete aussi', () => {
    const sh = coquille();
    sh.execute('config firewall policy');
    sh.execute('edit 1');
    expect(sh.completions('set service TA')).toEqual(['set service TACACS+']);
  });

  it('GARDE-FOU : aucun prefixe atteignable ne fait diverger les deux', () => {
    const sh = coquille();
    const racine = balaye(sh);
    expect(racine.visites).toBeGreaterThan(20);
    expect(racine.divergents).toEqual([]);

    sh.execute('config firewall policy');
    sh.execute('edit 1');
    const objet = balaye(sh);
    expect(objet.visites).toBeGreaterThan(20);
    expect(objet.divergents).toEqual([]);
    sh.execute('end');

    sh.execute('config system interface');
    const table = balaye(sh);
    expect(table.visites).toBeGreaterThan(20);
    expect(table.divergents).toEqual([]);
  });

  it('GARDE-FOU : toute proposition porte une description', () => {
    const sh = coquille();
    expect(balaye(sh).sansDescription).toEqual([]);
    sh.execute('config firewall policy');
    sh.execute('edit 1');
    expect(balaye(sh).sansDescription).toEqual([]);
  });
});
