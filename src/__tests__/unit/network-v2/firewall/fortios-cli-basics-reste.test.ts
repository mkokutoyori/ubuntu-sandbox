/**
 * Le reste de la page « CLI basics », inventorie sur la page elle-meme.
 *
 * Quatre familles restaient non mesurees. Deux marchaient deja, deux
 * n'existaient pas du tout.
 *
 * CE QUI MARCHAIT — les quatre verbes de liste (`set` REMPLACE la liste,
 * `append` ajoute, `select` ne garde que le nomme, `unselect` retire) et
 * la vitesse de console (`set baudrate`, avec refus d'une vitesse hors
 * de la liste attestee 9600|19200|38400|57600|115200).
 *
 * DEFAUT 1 — les CARACTERES RESERVES etaient acceptes. La page ecrit :
 * « The following special characters, also known as reserved characters,
 * are not permitted in most CLI fields: <, >, (, ), #, ', and " ».
 * Mesure : `set alias "a<b"`, `set alias "a#b"` et `edit "web(1)"` sont
 * tous les trois acceptes en silence et ranges tels quels.
 *
 * DEFAUT 2 — `grep` n'etait NI numerote NI une expression reguliere.
 * `| grep -n` rendait le vide (l'option tombait hors de la grammaire des
 * options, donc la ligne entiere devenait le motif), et `matches`
 * comparait par `includes` — un sous-texte, la ou la page dit que grep
 * filtre « based on regular expressions ».
 *
 * Trois decisions, chacune parce que l'inverse etait possible :
 *
 *  - Le refus porte sur les SEPT caracteres attestes et non sur une
 *    liste blanche de ce qu'un nom a le droit de contenir. La liste
 *    blanche (lettres, chiffres, espace, `-`, `_`) vient d'une source
 *    plus faible et casserait des noms legitimes portant un point.
 *  - `set buffer` d'un message de remplacement porte
 *    `allowsReservedCharacters` : c'est la seule des exceptions
 *    attestees par Fortinet (message de remplacement, signature IPS
 *    personnalisee, motif de fichier bloque, mot banni, identifiant
 *    PPPoE) qui existe dans ce schema, et son contenu EST du HTML.
 *  - Un motif qui ne compile pas retombe sur la comparaison litterale
 *    plutot que d'inventer un message d'erreur de grep.
 *
 * TROIS portes creent une cle — `edit`, `rename`, `clone` — et seule la
 * premiere avait ete gardee ; `refusedKey` est la regle unique que les
 * trois lisent.
 *
 * Discrimine par `git stash push -- .../runtime/ .../render/ .../schema/` :
 * 8 cas tombent avant correctif. Les 8 qui passent des DEUX cotes sont
 * nommes ici plutot que laisses a decouvrir — les 4 verbes de liste et
 * les 2 cas de vitesse, dont c'est l'objet de garder ce qui marchait
 * deja, et les 2 TEMOINS (`lien-wan.1` accepte, motif litteral retenu),
 * qui gardent que le correctif n'a pas ferme la porte trop largement.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function pareFeu(): FortiGate {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  run(fw.getShell(),
    'config system interface', 'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping https ssh', 'next', 'end');
  return fw;
}

function acces(fw: FortiGate): string {
  return run(fw.getShell(), 'show system interface | grep allowaccess').trim();
}

beforeEach(() => { Logger.reset(); });

describe('une liste se modifie par append, select et unselect', () => {
  it('`set` REMPLACE la liste entiere', () => {
    const fw = pareFeu();

    run(fw.getShell(),
      'config system interface', 'edit "port1"', 'set allowaccess ping', 'next', 'end');

    expect(acces(fw)).toBe('set allowaccess ping');
  });

  it('`append` ajoute sans perdre ce qui etait la', () => {
    const fw = pareFeu();

    run(fw.getShell(),
      'config system interface', 'edit "port1"', 'append allowaccess snmp', 'next', 'end');

    expect(acces(fw)).toBe('set allowaccess ping https ssh snmp');
  });

  it('`select` ne garde que ce qui est nomme', () => {
    const fw = pareFeu();

    run(fw.getShell(),
      'config system interface', 'edit "port1"', 'select allowaccess ssh', 'next', 'end');

    expect(acces(fw)).toBe('set allowaccess ssh');
  });

  it('`unselect` retire ce qui est nomme et laisse le reste', () => {
    const fw = pareFeu();

    run(fw.getShell(),
      'config system interface', 'edit "port1"', 'unselect allowaccess https', 'next', 'end');

    expect(acces(fw)).toBe('set allowaccess ping ssh');
  });
});

describe('les caracteres reserves sont refuses dans un champ', () => {
  it('un chevron dans une valeur est refuse', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    const refus = run(sh,
      'config system interface', 'edit "port1"', 'set alias "a<b"');
    run(sh, 'next', 'end');

    expect(refus).not.toBe('');
    expect(run(sh, 'show system interface | grep alias')).not.toContain('a<b');
  });

  it('un diese dans une valeur est refuse', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    const refus = run(sh,
      'config system interface', 'edit "port1"', 'set alias "a#b"');
    run(sh, 'next', 'end');

    expect(refus).not.toBe('');
  });

  it('une parenthese dans une CLE est refusee', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    const refus = run(sh, 'config firewall address', 'edit "web(1)"');
    run(sh, 'end');

    expect(refus).not.toBe('');
    expect(run(sh, 'show firewall address')).not.toContain('web(1)');
  });

  it('un caractere reserve ECHAPPE reste refuse', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    const refus = run(sh,
      'config system interface', 'edit "port1"', 'set alias a\\<b');
    run(sh, 'next', 'end');

    expect(refus).not.toBe('');
  });

  it('`rename` vers un nom reserve est refuse', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    run(sh, 'config firewall address', 'edit "web"',
      'set subnet 10.0.0.1 255.255.255.255', 'next');
    const refus = run(sh, 'rename web to "web(1)"');
    run(sh, 'end');

    expect(refus).not.toBe('');
    expect(run(sh, 'show firewall address')).toContain('edit "web"');
  });

  it('`clone` vers un nom reserve est refuse', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    run(sh, 'config firewall address', 'edit "web"',
      'set subnet 10.0.0.1 255.255.255.255', 'next');
    const refus = run(sh, 'clone web to "web#2"');
    run(sh, 'end');

    expect(refus).not.toBe('');
    expect(run(sh, 'show firewall address')).not.toContain('web#2');
  });

  it('TEMOIN : un tiret et un point restent acceptes', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    const refus = run(sh,
      'config system interface', 'edit "port1"', 'set alias "lien-wan.1"');
    run(sh, 'next', 'end');

    expect(refus).toBe('');
    expect(run(sh, 'show system interface | grep alias')).toContain('lien-wan.1');
  });
});

describe('grep numerote et lit une expression reguliere', () => {
  it('`-n` numerote les lignes retenues', () => {
    const fw = pareFeu();

    const vu = run(fw.getShell(), 'show system interface | grep -n allowaccess');

    expect(vu).toMatch(/^\d+:\s*set allowaccess/);
  });

  it('le motif est une expression reguliere', () => {
    const fw = pareFeu();

    const vu = run(fw.getShell(), 'show system interface | grep "set (ip|allowaccess)"');

    expect(vu).toContain('set ip 192.168.1.1 255.255.255.0');
    expect(vu).toContain('set allowaccess ping https ssh');
  });

  it('TEMOIN : un motif litteral marche toujours', () => {
    const fw = pareFeu();

    expect(run(fw.getShell(), 'show system interface | grep allowaccess').trim())
      .toBe('set allowaccess ping https ssh');
  });
});

describe('la vitesse de la console se regle', () => {
  it('`set baudrate 115200` est accepte et relu', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    const refus = run(sh, 'config system console', 'set baudrate 115200');
    run(sh, 'end');

    expect(refus).toBe('');
    expect(run(sh, 'show system console')).toContain('set baudrate 115200');
  });

  it('une vitesse hors de la liste est refusee', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    const refus = run(sh, 'config system console', 'set baudrate 4800');
    run(sh, 'end');

    expect(refus).not.toBe('');
  });
});
