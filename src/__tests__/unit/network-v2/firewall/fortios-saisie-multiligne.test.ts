/**
 * Une ligne terminee par `\` continue sur la suivante.
 *
 * La page « CLI basics » de FortiOS l'ecrit : « For each line that you
 * want to continue in a multiline command, terminate it with a backslash
 * ( \ ). To complete the command, enter a space instead of a backslash,
 * and then press Enter. » La section « Command syntax » y renvoie :
 * « Exceptions include multiline command lines, which can be entered
 * using an escape sequence. »
 *
 * MESURE DE DEPART : le mecanisme n'existe pas.
 *
 *   config system \      -> unknown configuration path "system \"
 *   interface            -> unknown command "interface"
 *
 * et toute la suite du bloc s'effondre, faute d'etre entree dans la
 * table. Le depot porte pourtant DEJA une continuation — celle du
 * guillemet ouvert — qui, elle, fonctionne et se rejoue : remesuree
 * avant d'accuser, `set alias "deux` puis `mots"` rend bien
 * `set alias "deux\nmots"`, et un second pare-feu qui rejoue cette
 * configuration porte la meme valeur. Elle reste donc comme TEMOIN.
 *
 *   1. Une commande coupee par `\` s'execute comme une seule.
 *   2. La coupure peut tomber au milieu d'une liste de valeurs.
 *   3. Plusieurs coupures d'affilee tiennent.
 *   4. Tant que la ligne continue, la machine ne rend RIEN.
 *   5. Une espace a la place de la barre TERMINE la commande.
 *   6. Echap ABANDONNE la saisie en cours.
 *   7. Une barre au milieu d'une ligne n'est pas une continuation.
 *   8. La continuation par guillemet et celle par barre se combinent.
 *   9. TEMOIN : la continuation par guillemet ouvert marchait deja.
 *  10. TEMOIN : une barre suivie d'une espace reste un espace echappe.
 *
 * Discrimine par `git stash push -- src/network/ src/terminal/` : 7 cas
 * tombent avant correctif. Les 3 qui passent des DEUX cotes sont les
 * deux TEMOINS — dont c'est l'objet — et « une barre au MILIEU d'une
 * ligne n'est pas une continuation », qui passait parce que la ligne
 * entiere etait refusee de toute facon.
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
  return new FortiGate('firewall-fortinet', 'FGT', 0, 0);
}

beforeEach(() => { Logger.reset(); });

describe('une ligne terminee par une barre oblique inversee continue', () => {
  it('une commande coupee s\'execute comme une seule', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    run(sh, 'config system \\', 'interface');

    expect(fw.getPrompt()).toBe('FGT (interface) # ');
  });

  it('la coupure peut tomber au milieu d\'une liste de valeurs', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    run(sh, 'config system interface', 'edit "port1"',
      'set allowaccess ping \\', 'https ssh', 'next', 'end');

    expect(run(sh, 'show system interface | grep allowaccess'))
      .toContain('set allowaccess ping https ssh');
  });

  it('plusieurs coupures d\'affilee tiennent', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    run(sh, 'config system interface', 'edit "port1"',
      'set \\', 'allowaccess \\', 'ping \\', 'https', 'next', 'end');

    expect(run(sh, 'show system interface | grep allowaccess'))
      .toContain('set allowaccess ping https');
  });

  it('tant que la ligne continue, la machine ne rend rien', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    expect(sh.execute('config system \\')).toBe('');
    expect(sh.execute('interface \\')).toBe('');
    expect(sh.execute('')).toBe('');
  });

  it('une espace a la place de la barre termine la commande', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    run(sh, 'config system \\', 'global ');

    expect(fw.getPrompt()).toBe('FGT (global) # ');
  });

  it('Echap abandonne la saisie en cours', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    sh.execute('config system \\');
    sh.abortContinuation();

    expect(sh.execute('get system status')).toContain('Serial-Number:');
    expect(fw.getPrompt()).toBe('FGT # ');
  });

  it('une barre au milieu d\'une ligne n\'est pas une continuation', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    const refus = sh.execute('config \\ system');

    expect(refus).not.toBe('');
    expect(fw.getPrompt()).toBe('FGT # ');
  });

  it('guillemet et barre se combinent', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    run(sh, 'config system \\', 'global', 'set alias "deux', 'mots"', 'end');

    expect(run(sh, 'show system global')).toContain('set alias "deux\nmots"');
  });
});

describe('TEMOINS', () => {
  it('la continuation par guillemet ouvert marchait deja', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    run(sh, 'config system global', 'set alias "deux', 'mots"', 'end');

    expect(run(sh, 'show system global')).toContain('set alias "deux\nmots"');
  });

  it('une barre suivie d\'une espace reste un espace echappe', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    run(sh, 'config system interface', 'edit "port1"',
      'set alias Lien\\ WAN', 'next', 'end');

    expect(run(sh, 'show system interface | grep alias'))
      .toContain('set alias "Lien WAN"');
  });
});
