/**
 * Ce que la page « CLI basics » de FortiOS decrit, la machine le fait.
 *
 * Inventaire de la page, mesure par mesure. Ce qui MARCHAIT deja est
 * garde comme temoin plutot que retire : l'abreviation (`g sy stat`),
 * la pagination (`config system console` / `set output more`), le filtre
 * `| grep` avec `-i`, `-c` et `-f`, la sauvegarde et la restauration par
 * TFTP. Deux points ne marchaient pas.
 *
 * DEFAUT 1 — les VARIABLES D'ENVIRONNEMENT sont rangees telles quelles.
 * La page en decrit trois, sensibles a la casse : `$USERFROM`,
 * `$USERNAME` et `$SerialNum`, et donne l'exemple
 * `config system global / set hostname $SerialNum / end`. Mesure :
 *
 *   set hostname $SerialNum   puis   get system status
 *   -> Hostname: $SerialNum
 *
 * DEFAUT 2 — une valeur ENTRE GUILLEMETS ne peut pas contenir d'espace.
 * La page ecrit qu'un espace dans une chaine demande des guillemets ou
 * une barre oblique inversee. Mesure :
 *
 *   set alias "Lien WAN"   -> value parse error before 'Lien WAN'
 *                             NOTE: expected WORD.
 *   edit "serveur web"     -> `edit` only applies inside a table opened
 *                             with `config`   (alors qu'on y etait)
 *
 * La cause est UNE et elle est ancienne : il y a DEUX decoupages de
 * ligne dans ce depot — `splitTokens` de `FortiShell`, qui respecte les
 * guillemets, et `tokenize` du socle, qui coupe sur tout blanc — et
 * c'est le naif qui est sur le chemin d'execution.
 *
 *   1. `$SerialNum` devient le numero de serie de la machine.
 *   2. `$USERNAME` devient le nom de l'administrateur connecte.
 *   3. `$USERFROM` nomme le type d'acces et l'adresse.
 *   4. La substitution a lieu a l'ECRITURE : la configuration rendue
 *      porte la valeur, pas la variable.
 *   5. Une variable inconnue reste litterale.
 *   6. `set alias "Lien WAN"` est accepte et rendu avec ses guillemets.
 *   7. `edit "serveur web"` cree bien la cle a l'espace.
 *   8. Une barre oblique inversee echappe l'espace.
 *   9. TEMOIN : l'abreviation de la page (`g sy stat`) fonctionne.
 *  10. TEMOIN : `| grep -i` et `| grep -c` fonctionnent.
 *  11. TEMOIN : `| grep -f` rend le bloc entier.
 *  12. TEMOIN : la pagination se configure et se relit.
 *
 * Discrimine par `git stash push -- src/network/ src/cli/` : 7 cas
 * tombent avant correctif — les cinq qui passent des DEUX cotes sont les
 * TEMOINS, nommes ci-dessus, et leur objet est justement de garder ce
 * qui marchait deja.
 *
 * Defaut trouve en chemin et corrige avec : le numero de serie etait
 * DERIVE DU NOM (`serialNumberOf(this.name)`), donc renommer la machine
 * changeait son numero de serie — et `set hostname $SerialNum` posait
 * l'ancien numero puis en fabriquait un nouveau. Sur une vraie machine
 * ce numero est grave et ne bouge jamais ; il est desormais calcule une
 * fois, a la construction.
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
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping https', 'next', 'end');
  return fw;
}

beforeEach(() => { Logger.reset(); });

describe('les variables d\'environnement sont substituees', () => {
  it('`$SerialNum` devient le numero de serie', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    run(sh, 'config system global', 'set hostname $SerialNum', 'end');

    expect(fw.getName()).toBe(fw.serialNumber());
    expect(run(sh, 'get system status | grep Hostname'))
      .toBe(`Hostname: ${fw.serialNumber()}`);
  });

  it('`$USERNAME` devient le nom de l\'administrateur connecte', () => {
    const fw = pareFeu();
    const sh = fw.getShell();
    sh.setAdminIdentity('admin');

    run(sh, 'config system global', 'set alias $USERNAME', 'end');

    expect(run(sh, 'show system global | grep alias')).toContain('set alias "admin"');
  });

  it('`$USERFROM` nomme le type d\'acces et l\'adresse', () => {
    const fw = pareFeu();
    const sh = fw.getShell();
    sh.setAdminIdentity('admin');
    sh.setAdministrativeInterface('ssh(192.168.1.10)');

    run(sh, 'config system global', 'set alias $USERFROM', 'end');

    expect(run(sh, 'show system global | grep alias'))
      .toContain('set alias "ssh(192.168.1.10)"');
  });

  it('la substitution a lieu a l\'ECRITURE', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    run(sh, 'config system global', 'set hostname $SerialNum', 'end');

    expect(run(sh, 'show system global | grep hostname'))
      .toContain(`set hostname "${fw.serialNumber()}"`);
  });

  it('une variable inconnue reste litterale', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    run(sh, 'config system global', 'set alias $Zorglub', 'end');

    expect(run(sh, 'show system global | grep alias')).toContain('set alias "$Zorglub"');
  });
});

describe('un espace dans une valeur demande des guillemets', () => {
  it('`set alias "Lien WAN"` est accepte et rendu', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    const refus = run(sh,
      'config system interface', 'edit "port1"', 'set alias "Lien WAN"');
    run(sh, 'next', 'end');

    expect(refus).toBe('');
    expect(run(sh, 'show system interface | grep alias'))
      .toContain('set alias "Lien WAN"');
  });

  it('`edit "serveur web"` cree la cle a l\'espace', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    run(sh, 'config firewall address', 'edit "serveur web"',
      'set subnet 10.0.0.1 255.255.255.255', 'next', 'end');

    expect(run(sh, 'show firewall address')).toContain('edit "serveur web"');
  });

  it('une barre oblique inversee echappe l\'espace', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    run(sh, 'config system interface', 'edit "port1"', 'set alias Lien\\ WAN');
    run(sh, 'next', 'end');

    expect(run(sh, 'show system interface | grep alias'))
      .toContain('set alias "Lien WAN"');
  });
});

describe('TEMOINS — ce que la page decrit et qui marchait deja', () => {
  it('l\'abreviation `g sy stat` de la page', () => {
    const fw = pareFeu();

    expect(run(fw.getShell(), 'g sy stat')).toContain('Serial-Number:');
  });

  it('`| grep -i` et `| grep -c`', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    expect(run(sh, 'show | grep -i INTERFACE')).toContain('config system interface');
    expect(Number(run(sh, 'show system interface | grep -c set'))).toBeGreaterThan(2);
  });

  it('`| grep -f` rend le bloc entier', () => {
    const fw = pareFeu();

    const bloc = run(fw.getShell(), 'show system interface | grep -f allowaccess');

    expect(bloc).toContain('edit "port1"');
    expect(bloc).toContain('set allowaccess ping https');
  });

  it('la pagination se configure et se relit', () => {
    const fw = pareFeu();
    const sh = fw.getShell();

    run(sh, 'config system console', 'set output more', 'end');

    expect(run(sh, 'show system console')).toContain('set output more');
  });
});
