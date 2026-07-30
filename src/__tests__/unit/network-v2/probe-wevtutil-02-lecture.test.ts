/**
 * Probes — `gl` et `gli` (PRD-Wevtutil.md phase 2).
 *
 * Deux commandes de lecture pure. Ce qu'elles rapportent est corrélé à
 * ce que d'autres surfaces disent du même journal : un nombre
 * d'enregistrements qui ne correspond pas à ce qu'on vient d'écrire
 * serait un chiffre décoratif.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const field = (out: string, name: string): string =>
  out.split('\n').find((l) => l.trim().startsWith(`${name}:`))?.split(':').slice(1).join(':').trim() ?? '';

describe('Scénario 1 — `gli` compte ce qui est réellement là', () => {
  it('le nombre d\'enregistrements suit les écritures', async () => {
    const dc = new WindowsServer('DC01');
    const before = Number(field(
      String(await dc.executeCmdCommand('wevtutil gli Security')), 'numberOfLogRecords'));
    expect(before).toBeGreaterThan(0);

    dc.getProcessManager().spawnProcess('notepad.exe', 100, 'DC01\\Administrator', {});

    const after = Number(field(
      String(await dc.executeCmdCommand('wevtutil gli Security')), 'numberOfLogRecords'));
    expect(
      after,
      'un compteur qui ne bouge pas quand on écrit est un chiffre décoratif',
    ).toBeGreaterThan(before);
  });

  it('il s\'accorde avec ce que compte le fournisseur', async () => {
    const dc = new WindowsServer('DC01');
    const viaWevtutil = Number(field(
      String(await dc.executeCmdCommand('wevtutil gli System')), 'numberOfLogRecords'));
    const direct = (dc.eventLog.getEntriesStructured('System', {}) ?? []).length;
    expect(viaWevtutil).toBe(direct);
  });

  it('`oldestRecordNumber` est le plus petit numéro présent', async () => {
    const dc = new WindowsServer('DC01');
    const oldest = Number(field(
      String(await dc.executeCmdCommand('wevtutil gli System')), 'oldestRecordNumber'));
    const indexes = (dc.eventLog.getEntriesStructured('System', {}) ?? []).map((e) => e.index);
    expect(oldest).toBe(Math.min(...indexes));
  });

  it('un journal vidé tombe à zéro', async () => {
    const dc = new WindowsServer('DC01');
    await dc.executeCmdCommand('wevtutil cl Application');
    expect(field(String(await dc.executeCmdCommand('wevtutil gli Application')),
      'numberOfLogRecords')).toBe('0');
  });

  it('un journal inconnu est refusé', async () => {
    const dc = new WindowsServer('DC01');
    expect(await dc.executeCmdCommand('wevtutil gli Fantome'))
      .toContain('The specified channel could not be found');
  });
});

describe('Scénario 2 — `gl` rend la configuration réelle', () => {
  it('le nom, l\'état et la taille maximale', async () => {
    const dc = new WindowsServer('DC01');
    const out = String(await dc.executeCmdCommand('wevtutil gl Security'));
    expect(field(out, 'name')).toBe('Security');
    expect(field(out, 'enabled')).toBe('true');
    // La configuration se donne en octets, le fournisseur la garde en Ko.
    expect(Number(field(out, 'maxSize'))).toBeGreaterThan(0);
  });

  it('`autoBackup` est faux, et le reste', async () => {
    const dc = new WindowsServer('DC01');
    // Rien n'archive un journal plein dans ce simulateur. Annoncer autre
    // chose serait promettre une sauvegarde qui n'aura pas lieu — et
    // c'est pourquoi `sl /ab:` est refusée plutôt qu'acceptée.
    expect(field(String(await dc.executeCmdCommand('wevtutil gl Security')), 'autoBackup'))
      .toBe('false');
    expect(await dc.executeCmdCommand('wevtutil sl Security /ab:true'))
      .toContain('is not recognized');
  });

  it('le nom de fichier échappe le séparateur de canal', async () => {
    const dc = new WindowsServer('DC01');
    // Windows écrit `Microsoft-Windows-PowerShell%4Operational.evtx` :
    // la barre oblique du nom de canal ne peut pas rester dans un nom de
    // fichier.
    expect(field(String(await dc.executeCmdCommand(
      'wevtutil gl Microsoft-Windows-PowerShell/Operational')), 'logFileName'))
      .toContain('Microsoft-Windows-PowerShell%4Operational.evtx');
  });
});
