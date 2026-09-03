/**
 * « Log hard disk: Available » etait le second litteral de la meme vue :
 * la machine affirmait avoir un disque, et aucune commande ne pouvait
 * le decrire.
 *
 * `execute disk list`, `disk format` et `disk scan` repondaient « unknown
 * action » alors que `get system status` annoncait le disque en dur — un
 * boitier sans disque de journalisation aurait annonce le meme mot.
 * Le disque est desormais une propriete du PROFIL, a cote des autres
 * capacites du chassis, et la vue le LIT : sans profil de disque elle
 * repond « Not available » et la famille `execute disk` repond « No log
 * disk. » au lieu de decrire un materiel absent.
 *
 * La mise en forme est celle de la transcription de la reference 6.0.4,
 * jusqu'a sa particularite : `Disk Internal(boot) ref: 14.9GB` fait
 * suivre `ref:` d'une TAILLE et non d'un numero, et l'unite ecrite
 * « GB » est comptee en gibioctets — c'est ce qui fait qu'un disque de
 * 16 Go y parait de 14.9. La deuxieme ligne decrit la partition, et son
 * espace LIBRE est mesure : capacite moins ce que les journaux occupent,
 * courants et roules, en lisant le magasin et le disque de journaux que
 * `execute log list` decrit deja. L'etiquette de partition est DERIVEE du
 * numero de serie, pour que deux boitiers simules n'affichent pas la
 * meme.
 *
 * **`scan` n'est pas `format`, et la premiere version confondait les
 * deux** : elle rendait « Formatting disk, Please wait a few seconds! »
 * apres une demande d'analyse, c'est-a-dire qu'elle effacait les
 * journaux pour une commande qui promet de les REPARER. L'analyse
 * annonce sa demande et redemarre, rien d'autre.
 *
 * Limite mesuree et ecrite plutot que tue : ce simulateur n'a aucun
 * modele de corruption de disque, donc une analyse ne trouve jamais rien
 * a reparer. La reproduire reste honnete parce que la reference montre
 * que la commande ne RAPPORTE aucun verdict — elle demande, previent
 * qu'il faut redemarrer, et redemarre — au contraire d'un `fsck` qui
 * devrait conclure quelque chose.
 *
 * Discrimine par `git stash push` : 10 des 11 cas tombent. Le onzieme
 * est nomme ici : « le disque est annonce disponible » passait deja,
 * puisque c'etait justement le litteral que la vue affichait sans le
 * lire nulle part. Le cas de l'espace libre a du etre RENFORCE pour
 * discriminer : sa premiere version ne comparait que deux nombres, et
 * une commande refusee les rendait nuls tous les deux, donc elle passait
 * a vide.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function banc() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  return { fw, sh: new FortiShell(fw) };
}

describe('execute disk', () => {
  it('le disque est annonce disponible par `get system status`', () => {
    expect(banc().sh.execute('get system status'))
      .toContain('Log hard disk: Available');
  });

  it('decrit le disque et sa partition dans la forme de la reference', () => {
    const lignes = banc().sh.execute('execute disk list').split('\n');
    expect(lignes[0]).toMatch(
      /^Disk Internal\(boot\) ref: \d+\.\dGB type: SSD \[[^\]]+\] dev: \/dev\/sda$/);
    expect(lignes[1]).toMatch(
      /^partition ref: 3 \d+\.\dGB, \d+\.\dGB free mounted: Y label: \w+ dev: \/dev\/sda3$/);
  });

  it('derive l\'etiquette de partition du numero de serie', () => {
    const premier = banc().sh.execute('execute disk list');
    const second = new FortiShell(new FortiGate('firewall-fortinet', 'AUTRE', 0, 0))
      .execute('execute disk list');
    const etiquette = (texte: string) => /label: (\w+)/.exec(texte)?.[1];
    expect(etiquette(premier)).toBeDefined();
    expect(etiquette(premier)).not.toBe(etiquette(second));
  });

  it('mesure l\'espace libre sur ce que les journaux occupent', () => {
    const { fw, sh } = banc();
    const libre = (texte: string) =>
      Number.parseFloat(/, (\d+\.\d)GB free/.exec(texte)?.[1] ?? '0');
    const avant = libre(sh.execute('execute disk list'));
    expect(avant).toBeGreaterThan(0);

    for (let i = 0; i < 200; i++) {
      fw.getLogStore().append({
        at: Date.now(), type: 'traffic', subtype: 'forward', level: 'notice',
        id: '0000000013', fields: { srcip: '10.0.0.1', action: 'deny' },
      });
    }
    expect(libre(sh.execute('execute disk list'))).toBeLessThanOrEqual(avant);
  });

  it('annonce ses trois operations', () => {
    const aide = banc().sh.execute('execute disk ?');
    for (const mot of ['list', 'format', 'scan']) expect(aide).toContain(mot);
  });

  it('reclame une operation quand il n\'y en a pas', () => {
    expect(banc().sh.execute('execute disk')).toContain('command parse error');
  });

  it('reclame une reference de partition', () => {
    expect(banc().sh.execute('execute disk scan'))
      .toContain('a partition reference is missing');
  });

  it('refuse une partition que ce boitier n\'a pas', () => {
    const sortie = banc().sh.execute('execute disk scan 9');
    expect(sortie).toContain('value parse error');
    expect(sortie).toContain('reference 3');
  });

  it('l\'analyse annonce sa demande et le redemarrage, sans formater', () => {
    const { fw, sh } = banc();
    fw.getLogStore().append({
      at: Date.now(), type: 'event', subtype: 'system', level: 'notice',
      id: '0100032002', fields: { msg: 'garde' },
    });
    const avant = fw.getLogStore().count();

    const sortie = sh.execute('execute disk scan 3');
    expect(sortie).toBe(
      'scan requested for: 3/Internal (device=/dev/sda3)\n'
      + 'This action requires the unit to reboot.');
    expect(sortie).not.toContain('Formatting disk');
    expect(fw.getLogStore().count()).toBe(avant);
  });

  it('le formatage efface les journaux et le dit', () => {
    const { fw, sh } = banc();
    fw.getLogStore().append({
      at: Date.now(), type: 'event', subtype: 'system', level: 'notice',
      id: '0100032002', fields: { msg: 'perdu' },
    });

    expect(sh.execute('execute disk format 3'))
      .toContain('Formatting disk, Please wait a few seconds!');
    expect(fw.getLogStore().count()).toBe(0);
  });

  it('demande confirmation pour formater et pour analyser, pas pour lister', () => {
    const { sh } = banc();
    for (const ligne of ['execute disk format 3', 'execute disk scan 3']) {
      const plan = sh.interactionPlanFor(ligne);
      expect(plan, ligne).not.toBeNull();
      expect(plan!.steps.some(step => step.kind === 'confirmation'), ligne).toBe(true);
    }
    expect(sh.interactionPlanFor('execute disk list')).toBeNull();
  });
});
