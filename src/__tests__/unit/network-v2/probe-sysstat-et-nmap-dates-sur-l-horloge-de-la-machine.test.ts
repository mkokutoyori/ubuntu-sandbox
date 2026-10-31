/**
 * Apres `date -s` sur un poste Linux, tout ce qui imprime l'heure doit la lire sur l'horloge de CE poste. Mesure de
 * depart (poste regle au 2027-03-15 09:30, `date` le confirme) :
 *  - `mpstat`, `pidstat` et `iostat -t` imprimaient la date du jour du simulateur (10/31/2026 07:25:10 AM) dans la
 *    banniere, l'en-tete et chaque ligne, en continu (`mpstat 1 1`) comme en une fois (`cmdMpstat`) ;
 *  - `nmap` ouvrait son rapport par « Starting Nmap 7.94 at 2026-10-31 07:25 UTC ».
 * Corrige : les contextes de ces commandes portent `now()` (l'horloge de la machine), les plans de flux la lisent par
 * `LinuxMachine.machineDate()`, et le moteur de balayage lit `HostProbes.nowMs`.
 *
 * Discrimine par `git stash` sur src/network et src/terminal : 4 des 5 cas tombent avant (mpstat, pidstat, iostat -t,
 * nmap). Le TEMOIN (`date` rend bien la date posee) passe des deux cotes : c'est lui qui prouve que le laboratoire a
 * pose l'horloge.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
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

async function lab(): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  await pc.executeCommand('sudo date -s "2027-03-15 09:30:00"');
  return pc;
}

describe('les outils qui impriment l heure lisent l horloge du poste', () => {
  it('TEMOIN — date rend la date posee', async () => {
    const pc = await lab();
    expect(await pc.executeCommand('date')).toContain('Mon Mar 15 09:30');
  });

  it('mpstat date sa banniere et ses lignes', async () => {
    const out = String(await (await lab()).executeCommand('mpstat 1 1'));
    expect(out).toContain('03/15/2027');
    expect(out).toMatch(/09:30:\d\d AM\s+all/);
    expect(out).not.toContain('2026');
  });

  it('pidstat date sa banniere et ses lignes', async () => {
    const out = String(await (await lab()).executeCommand('pidstat 1 1'));
    expect(out).toContain('03/15/2027');
    expect(out).toMatch(/09:30:\d\d AM\s+0\s+1\s/);
  });

  it('iostat -t date son rapport', async () => {
    const out = String(await (await lab()).executeCommand('iostat -t 1 1'));
    expect(out).toContain('03/15/2027 09:30');
    expect(out).not.toContain('2026');
  });

  it('nmap ouvre son rapport a la date du poste', async () => {
    const out = String(await (await lab()).executeCommand('nmap -p 22 10.0.0.2'));
    expect(out).toContain('at 2027-03-15 09:30 UTC');
  });
});
