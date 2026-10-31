/**
 * Les fichiers qu'Oracle pose sur l'hote a son premier usage (`orapw<SID>`, `alert_<SID>.log`) portent l'heure de leur
 * creation. Mesure de depart : initOracleFilesystem les datait de `simulationDate()` (l'heure globale du simulateur), si
 * bien qu'un serveur regle par `date -s` avant son premier `sqlplus` ecrivait l'heure d'origine dans son journal
 * d'alertes, alors que le reste du journal (OracleInstance.logAlert) lit l'horloge de l'hote. Corrige : l'horodatage
 * est celui de l'equipement.
 *
 * Discrimine par `git stash` sur src/terminal : 1 des 2 cas tombe avant (l'en-tete de alert_ORCL.log apres `date -s`).
 * Le TEMOIN (l'en-tete porte un horodatage AAAA-MM-JJ HH:MM:SS) passe des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { initOracleFilesystem, resetAllOracleInstances } from '@/terminal/commands/database';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
  resetAllOracleInstances();
});

async function alertLogHead(setClock: boolean): Promise<string> {
  const server = new LinuxServer('linux-server', 'srv', 0, 0);
  if (setClock) await server.executeCommand('sudo date -s "2027-03-15 09:30:00"');
  initOracleFilesystem(server);
  const found = String(await server.executeCommand('find / -name "alert_*.log" 2>/dev/null | head -1')).trim();
  expect(found, 'alert log not created').not.toBe('');
  return String(await server.executeCommand(`head -1 ${found}`));
}

describe('les fichiers Oracle sont crees a l heure de la machine', () => {
  it('TEMOIN — l en-tete du journal d alertes porte un horodatage', async () => {
    expect(await alertLogHead(false)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/);
  });

  it('apres date -s, l en-tete porte la date posee', async () => {
    expect(await alertLogHead(true)).toMatch(/^2027-03-15 09:30:/);
  });
});
