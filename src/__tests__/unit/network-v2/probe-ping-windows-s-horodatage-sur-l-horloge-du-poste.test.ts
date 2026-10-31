/**
 * `ping -s N` (Windows, option IP Timestamp, RFC 791 §3.1) affiche des horodatages en MILLISECONDES DEPUIS MINUIT UT.
 * Mesure de depart : la valeur affichee etait `simulationNowMs() + i * 10`, c'est-a-dire l'heure du simulateur en
 * millisecondes depuis 1970 (un nombre de treize chiffres, qui n'est pas un horodatage RFC 791 et qui ignorait
 * `Set-Date`) plus un pas invente de 10 ms par saut, sur une route deduite d'un traceroute. Corrige : le poste construit
 * l'option, chaque equipement du trajet y ecrit son adresse et SON heure, et l'affichage relit l'option de la reponse.
 *
 * Discrimine par `git stash` sur src/network : 1 des 2 cas tombe avant (la valeur). Le TEMOIN (la ligne `Timestamp:`
 * existe et porte l'adresse du saut) passe des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function timestampLine(): Promise<string> {
  const pc = new WindowsPC('windows-pc', 'w', 0, 0);
  pc.setCurrentUser('Administrator');
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  await pc.executeCommand(`powershell -c "Set-Date -Date '2027-03-15 09:30:00'"`);
  await srv.executeCommand('sudo date -s "2027-03-15 09:30:00"');
  const out = String(await pc.executeCommand('ping -n 1 -s 1 10.0.0.2'));
  const at = out.split('\n').findIndex((l) => l.startsWith('Timestamp:'));
  expect(at, `no Timestamp block in:\n${out}`).toBeGreaterThanOrEqual(0);
  return out.split('\n')[at + 1];
}

describe('ping -s sur l horloge du poste', () => {
  it('TEMOIN — la ligne porte l adresse du saut', async () => {
    expect(await timestampLine()).toMatch(/^ {4}10\.0\.0\.2 : \d+$/);
  });

  it('la valeur est en millisecondes depuis minuit UT, sur l horloge de la cible reglee a 09:30 UT', async () => {
    const value = Number((await timestampLine()).split(' : ')[1]);
    const expected = (9 * 3600 + 30 * 60) * 1000;
    expect(Math.abs(value - expected)).toBeLessThan(60_000);
  });
});
