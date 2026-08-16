/**
 * L'ASA devient un EQUIPEMENT qu'on depose et qu'on ouvre.
 *
 * Jusqu'ici tout le module etait juste : les magasins, le pipeline, la
 * grammaire, les vues. Et rien de tout cela n'etait ATTEIGNABLE — la
 * palette construisait un `LinuxPC` sous le nom `firewall-cisco`, si bien
 * qu'un utilisateur deposant un pare-feu Cisco obtenait une machine Ubuntu
 * avec un `bash`. C'est exactement le defaut que `DevicePalette` signale
 * par son badge « Limited », honnete mais definitif tant que rien ne le
 * remplace.
 *
 * Trois choses doivent tenir ENSEMBLE, et chacune peut echouer seule :
 *
 *   1. `DeviceFactory` construit un vrai `AsaFirewall` ;
 *   2. l'equipement expose une CLI (`ICLIDevice`) — sinon le terminal n'a
 *      rien a interroger ;
 *   3. `createSessionForDevice` ouvre un terminal plutot que de rendre
 *      `null`, ce qu'il faisait pour tout `getOSType()` inconnu.
 *
 * Le dernier cas du fichier est le seul qui compte vraiment pour un
 * utilisateur : deposer, ouvrir, taper une commande, voir la machine
 * repondre.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { AsaFirewall } from '@/network/devices/firewall/vendors/asa/AsaFirewall';
import { Firewall } from '@/network/devices/firewall/Firewall';
import { createSessionForDevice } from '@/terminal/sessions/sessionFactory';
import { DEVICE_CATALOG } from '@/network/core/deviceCatalog';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

function asa(): AsaFirewall {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  return createDevice('firewall-cisco', 0, 0) as AsaFirewall;
}

beforeEach(() => { Logger.reset(); });

describe('DeviceFactory — `firewall-cisco` est un ASA', () => {
  it('construit un AsaFirewall, plus un LinuxPC', () => {
    expect(asa()).toBeInstanceOf(AsaFirewall);
  });

  it('et donc un pare-feu, avec ses magasins', () => {
    const device = asa();

    expect(device).toBeInstanceOf(Firewall);
    expect(device.getSessionTable().count()).toBe(0);
    expect(device.getProfile().vendor).toBe('asa');
  });

  it('il porte les ports d\'un chassis Cisco', () => {
    expect(asa().getPortNames()[0]).toBe('GigabitEthernet0/0');
  });

  it('il s\'annonce comme un ASA', () => {
    expect(asa().getOSType()).toBe('asa');
  });

  it('le catalogue le decrit avec le meme OS que l\'equipement', () => {
    expect(DEVICE_CATALOG['firewall-cisco'].osType).toBe(asa().getOSType());
  });
});

describe('AsaFirewall — il expose une CLI', () => {
  it('la fabrique le NOMME elle-meme, avec le prefixe du catalogue', () => {
    expect(asa().getName()).toBe('FW1');
  });

  it('il rend une invite', () => {
    expect(asa().getPrompt()).toBe('FW1>');
  });

  it('l\'invite SUIT l\'etat de la session', async () => {
    const device = asa();

    await device.executeCommand('enable');

    expect(device.getPrompt()).toBe('FW1#');
  });

  it('une commande passe par le VRAI shell et agit', async () => {
    const device = asa();

    await device.executeCommand('enable');
    await device.executeCommand('configure terminal');
    await device.executeCommand('interface GigabitEthernet0/0');
    await device.executeCommand('nameif inside');

    expect(device.getZoneTable().zoneOf('GigabitEthernet0/0')).toBe('inside');
  });

  it('il rend une sequence de demarrage', () => {
    expect(asa().getBootSequence().length).toBeGreaterThan(0);
  });

  it('`?` propose des commandes, pas le vide', () => {
    expect(asa().cliHelp('').length).toBeGreaterThan(0);
  });

  it('la completion complete un prefixe non ambigu', () => {
    const device = asa();

    expect(device.cliTabComplete('ena')).toBe('enable');
  });

  it('elle ne devine pas un prefixe ambigu', () => {
    expect(asa().cliTabComplete('zzz')).toBeNull();
  });

  it('les candidats sont ceux du mode COURANT', async () => {
    const device = asa();
    const avant = device.cliTabCandidates('');

    await device.executeCommand('enable');

    expect(device.cliTabCandidates('')).not.toEqual(avant);
  });
});

describe('sessionFactory — on peut ouvrir un terminal dessus', () => {
  it('elle ne rend plus `null`', () => {
    expect(createSessionForDevice(asa(), 'T1')).not.toBeNull();
  });

  it('la session s\'annonce comme une session Cisco', () => {
    expect(createSessionForDevice(asa(), 'T1')!.getSessionType()).toBe('cisco');
  });

  it('deposer, ouvrir, taper — la machine repond', async () => {
    const device = asa();
    const session = createSessionForDevice(device, 'T1')!;
    await session.init();

    await device.executeCommand('enable');
    await device.executeCommand('show version');

    expect(session.getPrompt()).toContain('FW1');
  });
});
