/*
 * `?` sous `diagnose sys cmdb refcnt show`, `diagnose sys sdwan health-check` et `diagnose firewall iprope list` doit annoncer ce que la
 * commande accepte (chemins de datasource, noms des controles de sante, groupe de politiques) au lieu d'un gabarit, et `iprope list` doit
 * honorer son groupe : un groupe inconnu est refuse.
 * Mesure de depart : les trois queues repondaient un gabarit (`REST`), et `iprope list <n'importe quoi>` affichait la liste ; les 4 cas
 * tombent avant (git stash -- src/network), le temoin (`iprope list` sans groupe) passe des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function neuf(): FortiGate {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); EquipmentRegistry.resetInstance();
  return new FortiGate('firewall-fortinet', 'FGT', 0, 0);
}

const offered = (fw: FortiGate, line: string): string[] =>
  fw.getShell().help(line).map((row) => /^\s*(\S+)/.exec(row)?.[1] ?? '').filter((word) => word !== '' && word !== '<cr>');

describe('les queues de diagnose annoncent leurs valeurs', () => {
  let fw: FortiGate;
  beforeEach(() => { fw = neuf(); });

  it('refcnt show offre les chemins de datasource', () => {
    expect(offered(fw, 'diagnose sys cmdb refcnt show ')).toContain('system.interface');
  });

  it('iprope list offre le groupe de politiques', () => {
    expect(offered(fw, 'diagnose firewall iprope list ')).toContain('00100004');
  });

  it('iprope list refuse un groupe inconnu et accepte le groupe', async () => {
    const shell = fw.getShell();
    const unknown = await shell.execute('diagnose firewall iprope list 99999');
    const known = await shell.execute('diagnose firewall iprope list 00100004');
    expect(unknown).not.toContain('policy group');
    expect(known).toContain('policy group: 00100004');
  });

  it('health-check offre les controles de sante configures', async () => {
    const shell = fw.getShell();
    for (const line of ['config system sdwan', 'config health-check', 'edit hc1', 'set server 8.8.8.8', 'next', 'end', 'end']) await shell.execute(line);
    expect(offered(fw, 'diagnose sys sdwan health-check ')).toContain('hc1');
  });

  it('temoin : iprope list sans groupe', async () => {
    expect(await fw.getShell().execute('diagnose firewall iprope list')).toContain('policy group: 00100004');
  });
});
