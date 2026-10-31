/**
 * `vmstat -t` / `--timestamp` : procps-ng src/vmstat.c (gitlab.com/procps-ng/procps, `new_header` et `output_line`)
 * ajoute ` -----timestamp-----` a la premiere ligne d'en-tete, le nom du fuseau cadre a droite sur 19 colonnes a la
 * seconde, et ` %Y-%m-%d %H:%M:%S` (heure locale) a chaque ligne. Mesure de depart : l'option etait acceptee puis
 * ignoree (`-t` figurait parmi les options « acceptees mais non implementees »), donc la sortie n'avait aucune colonne
 * d'horodatage, et rien ne la datait apres `date -s`.
 * Le releve en continu (`vmstat -t 1 N`) passe par le meme formatage dans LinuxStreamPlans ; sa sortie ne se lit que dans le terminal, hors de cette sonde.
 * Les largeurs des colonnes du simulateur (procps 3.3.17 d'Ubuntu 22.04) ne changent pas : seule la colonne
 * s'ajoute, comme dans la source (la fin d'en-tete `-----timestamp-----` est identique entre 3.3.17 et master).
 *
 * Discrimine par `git stash` sur src/network et src/terminal : 2 des 3 cas tombent avant. Le TEMOIN (`vmstat` sans -t
 * ne porte aucune colonne d'horodatage) passe des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
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

async function pc(): Promise<LinuxPC> {
  const machine = new LinuxPC('linux-pc', 'pc', 0, 0);
  await machine.executeCommand('sudo date -s "2027-03-15 09:30:00"');
  return machine;
}

describe('vmstat -t', () => {
  it('TEMOIN — sans -t, aucune colonne d horodatage', async () => {
    const out = String(await (await pc()).executeCommand('vmstat'));
    expect(out).not.toContain('timestamp');
    expect(out).not.toContain('2027');
  });

  it('ajoute le titre de colonne et le fuseau a l en-tete', async () => {
    const lines = String(await (await pc()).executeCommand('vmstat -t')).split('\n');
    expect(lines[0]).toMatch(/ -----timestamp-----$/);
    expect(lines[1]).toMatch(/ st {17}UTC$/);
  });

  it('date la ligne sur l horloge du poste', async () => {
    const lines = String(await (await pc()).executeCommand('vmstat -t')).split('\n');
    expect(lines[2]).toMatch(/ 2027-03-15 09:30:\d\d$/);
  });
});
