/**
 * `execute erase-disk` efface le DISQUE, ce qui est plus que le
 * `formatlogdisk` d'a cote et autre chose que `factoryreset`.
 *
 * La commande repondait « unknown action ». Elle n'a de sens que depuis
 * que le disque existe — le lot precedent lui a donne un profil, une
 * partition et des fichiers roules — et la question qu'il fallait
 * trancher avant d'ecrire une ligne etait : en quoi differe-t-elle des
 * deux commandes destructrices deja presentes ? Sans reponse, ce serait
 * une troisieme porte sur le meme geste, c'est-a-dire un decor.
 *
 * La reference 6.0.4 la donne, et par la NEGATIVE : elle ecrit noir sur
 * blanc que `formatlogdisk` « does not delete information such as
 * configuration files and firmware images because they are not stored
 * on logging disks », tandis qu'`erase-disk` « reformats the boot device
 * or any installed hard disks ». Le peripherique d'amorcage porte donc
 * ce que le disque de journaux ne porte pas, et l'effacer emporte les
 * REVISIONS de configuration — que ni `formatlogdisk` ni `factoryreset`
 * ne touchent. Trois etats mesures sur un meme banc, et les trois
 * different :
 *
 *     depart          revisions=1  journaux=2  hostname=PERSO
 *     formatlogdisk   revisions=1  journaux=0  hostname=PERSO
 *     factoryreset    revisions=1  journaux=2  hostname=FGT
 *     erase-disk      revisions=0  journaux=0  hostname=FGT
 *
 * Le disque a EFFACER est nomme, et `?` le liste : c'est ce que la
 * reference demande (« Use the ? to list the disks that can be
 * erased »), et le nom vient du profil du chassis, pas d'une constante
 * du vocabulaire — un modele sans disque n'en propose aucun et la
 * famille entiere repond « No log disk. ».
 *
 * Un point n'est atteste par aucune source et est ecrit plutot que tu :
 * l'avertissement propre a cette commande. Il est derive de celui de
 * `formatlogdisk`, dont il n'enleve qu'un mot — « all data on the disk »
 * la ou l'autre dit « on the log disk » — plutot que d'en inventer un
 * qui n'aurait aucun rapport.
 *
 * Discrimine par `git stash push` : 7 des 10 cas tombent. Les 3 autres
 * sont nommes ici plutot que laisses a decouvrir, et ce sont les trois
 * TEMOINS qui donnent son sens a la commande : l'etat de depart du banc,
 * et le fait que `formatlogdisk` et `factoryreset` gardent chacun ce que
 * `erase-disk` emporte. Ils passaient deja — c'est justement leur
 * objet — et sans eux la nouvelle commande serait indiscernable d'une
 * troisieme porte sur le meme geste.
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
  const sh = new FortiShell(fw);
  for (const ligne of ['config system global',
    'set revision-backup-on-logout enable', 'set hostname "PERSO"', 'end']) {
    sh.execute(ligne);
  }
  fw.onAdminLogout('admin');
  fw.getLogStore().append({
    at: Date.now(), type: 'event', subtype: 'system', level: 'notice',
    id: '0100032002', fields: { msg: 'trace' },
  });
  return { fw, sh };
}

function nomDHote(sh: FortiShell): string {
  return /Hostname: (\S+)/.exec(sh.execute('get system status'))?.[1] ?? '';
}

describe('execute erase-disk', () => {
  it('TEMOIN : le banc part avec une revision, des journaux et un nom', () => {
    const { fw, sh } = banc();
    expect(fw.getRevisions().list()).toHaveLength(1);
    expect(fw.getLogStore().count()).toBeGreaterThan(0);
    expect(nomDHote(sh)).toBe('PERSO');
  });

  it('efface les journaux, les revisions ET la configuration', () => {
    const { fw, sh } = banc();
    sh.execute('execute erase-disk Internal');

    expect(fw.getLogStore().count()).toBe(0);
    expect(fw.getRevisions().list()).toHaveLength(0);
    expect(nomDHote(sh)).not.toBe('PERSO');
  });

  it('`formatlogdisk` GARDE les revisions et la configuration', () => {
    const { fw, sh } = banc();
    sh.execute('execute formatlogdisk');

    expect(fw.getLogStore().count()).toBe(0);
    expect(fw.getRevisions().list()).toHaveLength(1);
    expect(nomDHote(sh)).toBe('PERSO');
  });

  it('`factoryreset` GARDE les revisions et les journaux', () => {
    const { fw, sh } = banc();
    sh.execute('execute factoryreset');

    expect(fw.getRevisions().list()).toHaveLength(1);
    expect(fw.getLogStore().count()).toBeGreaterThan(0);
    expect(nomDHote(sh)).not.toBe('PERSO');
  });

  it('efface aussi les fichiers roules du disque', () => {
    const { fw, sh } = banc();
    sh.execute('execute log roll');
    expect(sh.execute('execute log list event')).toContain('elog.1');

    sh.execute('execute erase-disk Internal');
    expect(sh.execute('execute log list event'))
      .toBe('0 event log file(s) found.');
  });

  it('reclame le nom du disque', () => {
    expect(banc().sh.execute('execute erase-disk'))
      .toContain('a disk name is missing');
  });

  it('refuse un disque que ce boitier n\'a pas', () => {
    const sortie = banc().sh.execute('execute erase-disk zorglub');
    expect(sortie).toContain('value parse error');
    expect(sortie).toContain('Internal');
  });

  it('`?` liste le disque, comme la reference le demande', () => {
    expect(banc().sh.execute('execute erase-disk ?')).toContain('Internal');
  });

  it('previent avant d\'effacer', () => {
    expect(banc().sh.execute('execute erase-disk Internal'))
      .toContain('This operation will erase all data on the disk!');
  });

  it('demande confirmation, et seulement sur un disque nomme', () => {
    const { sh } = banc();
    const plan = sh.interactionPlanFor('execute erase-disk Internal');
    expect(plan).not.toBeNull();
    expect(plan!.steps.some(step => step.kind === 'confirmation')).toBe(true);
    expect(sh.interactionPlanFor('execute erase-disk')).toBeNull();
  });
});
