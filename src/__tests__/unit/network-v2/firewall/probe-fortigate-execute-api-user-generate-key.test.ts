/*
 * `execute api-user generate-key <name>` (FortiOS CLI Reference 7.4.12 p.3733 : « Generate key for API users », parametre <name> = nom de l'utilisateur API ;
 * 7.6.7 p.3882 ajoute <expiry>, reserve a l'utilisateur « Fortinet Support Tool » ; 6.0.4 : meme commande). Les references ne donnent PAS le texte de
 * sortie : le libelle « New API key: <cle> » vient de la memoire des tutoriels Fortinet, non atteste ici (community.fortinet.com et docs.fortinet.com
 * sont injoignables) -- a verifier des qu'une capture existe. Comportement tenu : la cle est generee par le pare-feu (30 caracteres
 * alphanumeriques), n'est montree qu'une fois (`show` la rend en `ENC`), authentifie l'API REST en `Authorization: Bearer`, survit a la sauvegarde
 * du lab, et regenerer invalide l'ancienne.
 * Mesure de depart : la commande repondait « Unknown action » ; 5 des 8 cas tombent avant ; les 3 autres sont des temoins (l'utilisateur API se cree par `config`, un utilisateur inconnu et un nom manquant sont refuses des deux cotes).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import type { Equipment } from '@/network/equipment/Equipment';

let fw: FortiGate;

beforeEach(async () => {
  EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  for (const line of ['config system api-user', 'edit "rest1"', 'set accprofile "super_admin"', 'next', 'end']) await fw.executeCommand(line);
});

const keyOf = (reply: string): string => /New API key: (\S+)/.exec(reply)?.[1] ?? '';

describe('execute api-user generate-key', () => {
  it('temoin : l utilisateur API existe', async () => {
    expect(await fw.executeCommand('show system api-user')).toContain('rest1');
  });

  it('genere une cle de 30 caracteres alphanumeriques', async () => {
    expect(keyOf(await fw.executeCommand('execute api-user generate-key rest1'))).toMatch(/^[A-Za-z0-9]{30}$/);
  });

  it('la cle est rangee et show la masque', async () => {
    const key = keyOf(await fw.executeCommand('execute api-user generate-key rest1'));
    const shown = await fw.executeCommand('show system api-user rest1');
    expect(shown).toContain('set api-key ENC');
    expect(shown).not.toContain(key);
  });

  it('la cle authentifie l API et regenerer invalide l ancienne', async () => {
    const first = keyOf(await fw.executeCommand('execute api-user generate-key rest1'));
    expect(fw.authenticateApiKey(first, '10.0.0.9')?.name).toBe('rest1');
    const second = keyOf(await fw.executeCommand('execute api-user generate-key rest1'));
    expect(second).not.toBe(first);
    expect(fw.authenticateApiKey(first, '10.0.0.9')).toBeNull();
    expect(fw.authenticateApiKey(second, '10.0.0.9')?.name).toBe('rest1');
  });

  it('un utilisateur inconnu est refuse', async () => {
    expect(keyOf(await fw.executeCommand('execute api-user generate-key ghost'))).toBe('');
  });

  it('le nom est requis', async () => {
    expect(await fw.executeCommand('execute api-user generate-key')).toMatch(/missing|incomplete|Command fail/i);
  });

  it('? sous execute api-user annonce generate-key', () => {
    expect(fw.getShell().help('execute api-user ').join('\n')).toContain('generate-key');
  });

  it('la cle survit a la sauvegarde du lab', async () => {
    const key = keyOf(await fw.executeCommand('execute api-user generate-key rest1'));
    const saved = JSON.parse(JSON.stringify(exportTopology('lab', new Map<string, Equipment>([[fw.getId(), fw as Equipment]]), [])));
    EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    const back = await importTopology(saved);
    const reopened = [...back.deviceInstances.values()][0] as FortiGate;
    expect(reopened.authenticateApiKey(key, '10.0.0.9')?.name).toBe('rest1');
  });
});
