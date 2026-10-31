/**
 * `dhclient -t N` sans serveur DHCP : le delai que la commande consomme est celui que l'operateur a donne, et
 * 60 s a defaut (le delai par defaut d'ISC dhclient). TODO.md affirmait le contraire (« aucun delai ne le lit ») ; la mesure
 * montre que DHCPClient.requestLease borne ses retransmissions par `options.timeout` et avance PathClock de chaque
 * intervalle, de sorte que l'horloge de la machine avance de N secondes. L'entree etait perimee et est supprimee.
 *
 * Discrimination : AUCUN cas ne tombe avant ce commit, puisqu'il ne change pas le code ; la sonde epingle un comportement
 * existant qu'une entree erronee du registre niait. Le TEMOIN est le cas du delai par defaut.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters(); MACAddress.resetCounter(); resetDeviceCounters(); Logger.reset(); EquipmentRegistry.resetInstance();
});

async function secondsSpent(command: string): Promise<number> {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  await pc.executeCommand('sudo ip link set eth0 up');
  const before = pc.getSystemClockMs();
  await pc.executeCommand(command);
  return Math.round((pc.getSystemClockMs() - before) / 1000);
}

describe('dhclient sans serveur consomme le delai demande', () => {
  it('TEMOIN — a defaut, soixante secondes', async () => {
    expect(await secondsSpent('sudo dhclient eth0')).toBe(60);
  });

  it('-t 1 consomme une seconde', async () => {
    expect(await secondsSpent('sudo dhclient -t 1 eth0')).toBe(1);
  });

  it('-t 20 consomme vingt secondes', async () => {
    expect(await secondsSpent('sudo dhclient -t 20 eth0')).toBe(20);
  });
});
