/**
 * `execute log delete <categorie>` ne supprime QUE cette categorie, et
 * `execute policy-packet-capture delete-all` vide les captures de
 * POLITIQUE.
 *
 * Les deux commandes existent dans la reference et n'existaient pas ici,
 * chacune avec son magasin sous la main. `execute log delete-all` etait
 * la seule facon d'effacer, donc un operateur qui voulait purger le seul
 * journal de trafic emportait aussi les evenements systeme — et une
 * commande dont la reference dit qu'elle prend une categorie, tapee avec
 * une categorie, repondait « unknown path ». Cote capture, `PacketCapture`
 * portait `clear()` depuis toujours et personne ne l'appelait.
 *
 * CORRIGE APRES COUP, et dans le TEST plutot que dans le code : ce
 * fichier faisait vider a `policy-packet-capture delete-all` le tampon
 * du RENIFLEUR, et epinglait donc une confusion comme si c'etait un
 * contrat. Sur une vraie machine cette commande efface les captures
 * posees par `set capture-packet enable` sur une politique, et n'a rien
 * a voir avec `diagnose sniffer packet`. Le cas porte desormais sur le
 * magasin par politique, et le renifleur a le sien dans
 * `probe-capture-par-politique.test.ts`.
 *
 * La categorie se resout par le MEME `resolveLogCategory` que
 * `execute log filter category` — nom, forme abregee ou numero — plutot
 * que par une seconde table : deux tables de categories finiraient par
 * accepter d'un cote ce que l'autre refuse. Sans argument ou avec `?`, la
 * liste est rendue, ce que la reference decrit explicitement.
 *
 * Discrimine par `git stash push` : 7 des 8 cas tombent — j'en avais
 * annonce 6, et la mesure corrige : le refus d'une categorie inconnue
 * discrimine lui aussi, l'ancien message etant celui d'une commande
 * entierement absente et non d'une valeur refusee. Le seul cas qui passe
 * des deux cotes est le TEMOIN, `delete-all`, qui existait deja et doit
 * continuer de fonctionner.
 *
 * Trouve en la mesurant : la famille `execute log` n'est PAS declaree
 * dans le vocabulaire des commandes `execute` mais dans le socle, si bien
 * qu'ajouter le gestionnaire seul laissait `execute log delete traffic`
 * repondre « unknown command » — le socle servait la frappe et ne
 * declarait aucun argument. La declaration est donc posee la, et la
 * categorie y REUTILISE la table `LOG_CATEGORIES` que
 * `execute log filter category` lit deja.
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

function laboratoire() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = new FortiShell(fw);
  const store = fw.getLogStore();
  store.append({ at: 1, id: '0000000001', type: 'traffic', subtype: 'forward',
    level: 'notice', fields: { action: 'accept' } });
  store.append({ at: 2, id: '0000000002', type: 'traffic', subtype: 'forward',
    level: 'notice', fields: { action: 'deny' } });
  store.append({ at: 3, id: '0100032001', type: 'event', subtype: 'system',
    level: 'information', fields: { logdesc: 'Configuration changed' } });
  return { fw, sh, store };
}

describe('execute log delete', () => {
  it('ne supprime que la categorie nommee', () => {
    const { sh, store } = laboratoire();

    expect(sh.execute('execute log delete traffic')).toBe('2 log entries deleted');
    expect(store.count()).toBe(1);
    expect(store.all()[0].type).toBe('event');
  });

  it('le numero de categorie designe la meme chose', () => {
    const { sh, store } = laboratoire();

    expect(sh.execute('execute log delete 1')).toBe('1 log entries deleted');
    expect(store.all().every(record => record.type === 'traffic')).toBe(true);
  });

  it('une categorie sans entree supprime zero', () => {
    const { sh, store } = laboratoire();

    expect(sh.execute('execute log delete utm-ips')).toBe('0 log entries deleted');
    expect(store.count()).toBe(3);
  });

  it('sans argument, la liste des categories est rendue', () => {
    const { sh, store } = laboratoire();

    const vue = sh.execute('execute log delete');
    expect(vue).toContain('traffic');
    expect(vue).toContain('utm-webfilter');
    expect(store.count()).toBe(3);
  });

  it('une categorie inconnue est refusee et n\'efface rien', () => {
    const { sh, store } = laboratoire();

    expect(sh.execute('execute log delete zorglub')).toMatch(/known categories/);
    expect(store.count()).toBe(3);
  });

  it('TEMOIN : `delete-all` efface tout', () => {
    const { sh, store } = laboratoire();

    expect(sh.execute('execute log delete-all')).toBe('3 log entries deleted');
    expect(store.count()).toBe(0);
  });
});

describe('execute policy-packet-capture', () => {
  it('`delete-all` vide la capture', () => {
    const { fw, sh } = laboratoire();
    const capture = fw.getPolicyCaptures();
    capture.record('1', { at: 1, iface: 'port1', direction: 'in',
      frame: { srcMAC: MACAddress.broadcast(), dstMAC: MACAddress.broadcast(),
        etherType: 0x0800, payload: undefined } });
    expect(capture.total()).toBe(1);

    expect(sh.execute('execute policy-packet-capture delete-all'))
      .toBe('1 captured packets deleted');
    expect(capture.total()).toBe(0);
  });

  it('une operation inconnue est refusee', () => {
    const { sh } = laboratoire();

    expect(sh.execute('execute policy-packet-capture zorglub'))
      .toContain('unknown action "policy-packet-capture zorglub"');
  });
});
