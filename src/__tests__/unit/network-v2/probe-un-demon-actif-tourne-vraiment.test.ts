/**
 * Une unite qu'un `systemctl` dit ACTIVE a un demon qui tourne.
 *
 * Ecrit A L'AVEUGLE. Mesure de depart sur un poste Linux ordinaire,
 * sans rien avoir tape avant :
 *
 * ```
 * systemctl is-active chrony   active
 * timedatectl                  NTP service: inactive
 * timedatectl show             NTP=no
 * ```
 *
 * Deux vues de la MEME machine, au MEME instant, se contredisent sur
 * l'etat du meme demon. La cause n'est pas dans `timedatectl`, qui lit
 * bien le service : `LinuxServiceManager` demarre les unites activees a
 * la CONSTRUCTION de l'executeur, alors que `LinuxMachine.initChrony()`
 * n'enregistre le controle de configuration de chrony que plus tard.
 * Au moment ou systemd marque l'unite active, le demon n'a donc jamais
 * ete demarre — et il ne le sera jamais.
 *
 * Ce n'est pas un defaut de chrony : NEUF demons enregistrent leur
 * controle apres l'amorcage (`named`, `isc-dhcp-server`, `nginx`,
 * `rsyslog`, `chrony`, `apache2`, `ssh`, `auditd`, `freeradius`). Tous
 * ceux qui sont actives par defaut portent le meme trou. La correction
 * va donc dans le gestionnaire, une fois, et non dans chaque demon.
 *
 * La consequence est double. Un laboratoire NTP part d'une machine dont
 * le demon dort ; et un depannage qui compare `systemctl` a la vue
 * metier ne peut rien conclure, puisque les deux ne parlent pas du meme
 * etat.
 *
 * ── Discrimination (`git stash push -- src/network`) ───────────────
 *
 * Mesuree : 4 cas sur 6 tombent contre l'etat d'avant. Les DEUX autres
 * sont les TEMOINS, et c'est leur role :
 *
 *  - « un arret explicite reste visible des deux cotes » — il marchait
 *    deja, parce que `systemctl stop` passe par le cycle de vie ; il
 *    prouve qu'en reconciliant l'amorcage on n'a pas rendu l'arret
 *    inoperant.
 *  - « un demon actif sans source joignable ne synchronise pas
 *    l'horloge » — c'est precisement le cas qu'un depannage cherche, et
 *    faire passer `NTP service` a `active` ne doit surtout pas faire
 *    passer l'horloge pour synchrone.
 *
 * Un cas ecrit a l'aveugle a d'abord passe POUR RIEN :
 * `toContain('NTP=yes')` etait satisfait par la ligne `CanNTP=yes`. Il
 * est ancre (`/^NTP=yes$/m`), et il tombe alors comme les autres.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Cmd { executeCommand(cmd: string): Promise<string> }

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

function poste(): Cmd {
  return createDevice('linux-pc', 0, 0) as unknown as Cmd;
}

describe('systemctl et la vue metier decrivent le meme demon', () => {
  it('chrony actif pour systemd est actif pour timedatectl', async () => {
    const pc = poste();

    expect((await pc.executeCommand('systemctl is-active chrony')).trim()).toBe('active');
    expect(await pc.executeCommand('timedatectl')).toContain('NTP service: active');
  });

  it('timedatectl show le dit aussi', async () => {
    const pc = poste();

    expect(await pc.executeCommand('timedatectl show')).toMatch(/^NTP=yes$/m);
  });

  it('chronyc parle a un demon qui tourne', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('chronyc tracking');

    expect(sortie).not.toMatch(/501|Cannot talk to daemon|not running/i);
    expect(sortie).toContain('Reference ID');
  });

  it('le demon a lu son fichier de configuration', async () => {
    const pc = poste();

    const sources = await pc.executeCommand('chronyc sources');

    expect(sources).toContain('MS Name/IP address');
  });
});

describe('TEMOINS', () => {
  it('un arret explicite reste visible des deux cotes', async () => {
    const pc = poste();

    await pc.executeCommand('systemctl stop chrony');

    expect((await pc.executeCommand('systemctl is-active chrony')).trim()).toBe('inactive');
    expect(await pc.executeCommand('timedatectl')).toContain('NTP service: inactive');
  });

  it('un demon actif sans source joignable ne synchronise pas l horloge', async () => {
    const pc = poste();

    expect(await pc.executeCommand('timedatectl')).toContain('System clock synchronized: no');
  });
});
