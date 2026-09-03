/**
 * Le disque de journalisation existe : `execute log roll` roule pour de
 * bon, `execute log list` liste des fichiers, et `execute formatlogdisk`
 * les efface.
 *
 * `get system status` annoncait « Log hard disk: Available » depuis
 * toujours et rien ne se trouvait derriere : ni fichier, ni roulement,
 * ni formatage. Les trois commandes qui gouvernent ce disque etaient
 * absentes — « unknown action » pour `formatlogdisk`, chemin inconnu
 * pour `log roll` et `log list` — alors que le magasin de journaux, lui,
 * mesure deja ce qu'il occupe (`usedBytes`) et date chaque
 * enregistrement.
 *
 * **Le fait qui ne s'invente pas, et qui simplifie** : depuis FortiOS
 * 5.0.7 il n'y a plus que DEUX fichiers, `tlog` pour le trafic ET la
 * securite, `elog` pour les evenements — les anciens `vlog`, `wlog`,
 * `alog` ont ete fondus. Un cas l'epingle en demandant la meme taille
 * par deux categories differentes : `traffic` et `utm-virus` decrivent
 * le MEME fichier. La regle est ecrite une fois (`logFilePrefix`) et
 * `typesOfLogFile` en est l'inverse, donc le roulement et la liste ne
 * peuvent pas se contredire sur ce qu'un fichier contient.
 *
 * La mise en forme vient de la transcription de la reference 6.0.4 —
 * `elog 8704 Fri March 6 14:24:35 2009` puis `501 event log file(s)
 * found.` : mois en toutes lettres, jour non complete, et le compte
 * nomme la CATEGORIE demandee. Les mots de `formatlogdisk` sont ceux de
 * la vraie machine : « This operation will erase all data on the log
 * disk! », puis « Formatting disk, Please wait a few seconds! », et elle
 * redemarre.
 *
 * **Un defaut a ete referme en chemin, avant livraison** : la premiere
 * version datait un fichier avec le DECALAGE COURANT du fuseau
 * (`localNow() - now()`), donc un enregistrement de mars etait rendu a
 * l'heure d'ete de septembre, et deux appels successifs pouvaient
 * differer d'une seconde au passage d'une minute. `Firewall.localTimeOf`
 * applique le fuseau A LA DATE VOULUE, et `localNow()` est desormais
 * ecrit par-dessus lui — une seule regle, deux lecteurs.
 *
 * Discrimine par `git stash push` : 13 des 13 cas tombent. Le cas de la
 * categorie inconnue etait annonce comme non discriminant et la mesure
 * a dit le contraire : avant correctif `log list` tout entier est un
 * chemin inconnu, donc le refus ne porte pas sur la categorie et le
 * texte n'est pas le meme.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { FirewallLogType } from '@/network/devices/firewall/logging/FirewallLogStore';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const MARS = Date.UTC(2026, 2, 6, 14, 24, 35);

function banc() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = new FortiShell(fw);
  sh.execute('config system global');
  sh.execute('set timezone "UTC"');
  sh.execute('end');
  sh.execute('execute log delete-all');
  return { fw, sh };
}

function journaliser(
  fw: FortiGate, type: FirewallLogType, subtype: string, at: number,
): void {
  fw.getLogStore().append({
    at, type, subtype, level: 'notice', id: '0000000013',
    fields: { srcip: '10.0.0.1', action: 'deny' },
  });
}

function taille(ligne: string): number {
  return Number.parseInt(ligne.split(/\s+/)[1], 10);
}

describe('le disque de journalisation', () => {
  it('nomme le fichier courant du trafic `tlog`, avec sa taille et sa date', () => {
    const { fw, sh } = banc();
    journaliser(fw, 'traffic', 'forward', MARS);

    const lignes = sh.execute('execute log list traffic').split('\n');
    expect(lignes[0]).toMatch(/^tlog \d+ Fri March 6 14:24:35 2026$/);
    expect(taille(lignes[0])).toBeGreaterThan(0);
    expect(lignes[1]).toBe('1 traffic log file(s) found.');
  });

  it('range les evenements dans un fichier SEPARE, `elog`', () => {
    const { fw, sh } = banc();
    journaliser(fw, 'event', 'system', MARS);

    expect(sh.execute('execute log list event').split('\n')[0]).toMatch(/^elog /);
    expect(sh.execute('execute log list traffic'))
      .toBe('0 traffic log file(s) found.');
  });

  it('fond le trafic et la securite dans UN SEUL tlog', () => {
    const seul = banc();
    journaliser(seul.fw, 'traffic', 'forward', MARS);
    const traficSeul = seul.sh.execute('execute log list traffic').split('\n')[0];

    const deux = banc();
    journaliser(deux.fw, 'traffic', 'forward', MARS);
    journaliser(deux.fw, 'utm', 'virus', MARS + 5000);
    const parTrafic = deux.sh.execute('execute log list traffic').split('\n')[0];
    const parVirus = deux.sh.execute('execute log list utm-virus').split('\n')[0];

    expect(parTrafic).toBe(parVirus);
    expect(taille(parTrafic)).toBeGreaterThan(taille(traficSeul));
    expect(deux.sh.execute('execute log list utm-virus').split('\n')[1])
      .toBe('1 utm-virus log file(s) found.');
  });

  it('roule : le fichier courant devient `.1` et la file repart vide', () => {
    const { fw, sh } = banc();
    journaliser(fw, 'traffic', 'forward', MARS);
    const avant = taille(sh.execute('execute log list traffic').split('\n')[0]);

    expect(sh.execute('execute log roll')).toBe('');
    const lignes = sh.execute('execute log list traffic').split('\n');
    expect(lignes[0]).toMatch(/^tlog\.1 /);
    expect(taille(lignes[0])).toBe(avant);
    expect(lignes[1]).toBe('1 traffic log file(s) found.');
    expect(sh.execute('execute log display')).toBe('No matching log data.');
  });

  it('un second roulement decale `.1` vers `.2`', () => {
    const { fw, sh } = banc();
    journaliser(fw, 'traffic', 'forward', MARS);
    sh.execute('execute log roll');
    journaliser(fw, 'traffic', 'forward', MARS + 20000);
    sh.execute('execute log roll');

    const lignes = sh.execute('execute log list traffic').split('\n');
    expect(lignes[0]).toMatch(/^tlog\.1 \d+ Fri March 6 14:24:55 2026$/);
    expect(lignes[1]).toMatch(/^tlog\.2 \d+ Fri March 6 14:24:35 2026$/);
    expect(lignes[2]).toBe('2 traffic log file(s) found.');
  });

  it('ne cree pas de fichier pour une categorie qui n\'a rien journalise', () => {
    const { fw, sh } = banc();
    journaliser(fw, 'traffic', 'forward', MARS);
    sh.execute('execute log roll');

    expect(sh.execute('execute log list event')).toBe('0 event log file(s) found.');
  });

  it('un roulement a vide ne cree rien', () => {
    const { sh } = banc();
    sh.execute('execute log roll');
    expect(sh.execute('execute log list traffic'))
      .toBe('0 traffic log file(s) found.');
  });

  it('sans categorie, `log list` annonce les categories', () => {
    expect(banc().sh.execute('execute log list')).toContain('utm-virus');
  });

  it('refuse une categorie inconnue', () => {
    expect(banc().sh.execute('execute log list zorglub'))
      .toContain('value parse error');
  });

  it('annonce `list` et `roll` dans son aide', () => {
    const aide = banc().sh.execute('execute log ?');
    expect(aide).toContain('list');
    expect(aide).toContain('roll');
  });

  it('formatlogdisk previent avec les mots de la vraie machine', () => {
    const sortie = banc().sh.execute('execute formatlogdisk');
    expect(sortie).toContain('This operation will erase all data on the log disk!');
    expect(sortie).toContain('Formatting disk, Please wait a few seconds!');
  });

  it('formatlogdisk efface les fichiers roules ET la file courante', () => {
    const { fw, sh } = banc();
    journaliser(fw, 'traffic', 'forward', MARS);
    sh.execute('execute log roll');
    journaliser(fw, 'event', 'system', MARS + 1000);

    sh.execute('execute formatlogdisk');
    expect(sh.execute('execute log list traffic'))
      .toBe('0 traffic log file(s) found.');
    expect(sh.execute('execute log list event'))
      .toBe('0 event log file(s) found.');
    expect(fw.getLogStore().count()).toBe(0);
  });

  it('formatlogdisk demande confirmation avant de formater', () => {
    const { sh } = banc();
    const plan = sh.interactionPlanFor('execute formatlogdisk');
    expect(plan).not.toBeNull();
    const confirmation = plan!.steps.find(step => step.kind === 'confirmation');
    expect(confirmation).toBeDefined();
  });
});
