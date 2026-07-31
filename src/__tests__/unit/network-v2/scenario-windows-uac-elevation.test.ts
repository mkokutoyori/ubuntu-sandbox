/**
 * PRD-Winlogon.md §2.1 P5 — modèle d'élévation UAC réel : `%%1938` (jeton
 * filtré — un membre d'Administrators qui n'a PAS élevé), `%%1937`
 * toujours honoré pour une vraie élévation `runas`, et 4648 régénéré
 * dynamiquement (au lieu de l'unique entrée statique de démonstration)
 * avec le vrai couple appelant/cible.
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

function events(pc: WindowsServer) {
  return pc.eventLog.getEntriesStructured('Security', { newest: 100 }) ?? [];
}

describe('PRD-Winlogon.md P5 — modèle d\'élévation UAC réel', () => {
  it('un membre d\'Administrators qui exécute SANS élever obtient %%1938 (jeton filtré), pas %%1937', async () => {
    const dc = new WindowsServer('DC01');
    dc.setCurrentUser('Administrator');
    // `net localgroup` exige l'admin appelant — 'alice' est un des
    // comptes standard pré-amorcés (mot de passe = nom d'utilisateur).
    const addOut = await dc.executeCmdCommand('net localgroup Administrators alice /add');
    expect(addOut).toMatch(/completed successfully/i);

    dc.setCurrentUser('alice');
    expect(dc.getUserManager().isCurrentUserAdmin()).toBe(true);

    await dc.executeCmdCommand('start notepad.exe');

    const proc4688 = events(dc).find((e) => e.eventId === 4688 && e.data?.SubjectUserName === 'alice');
    expect(proc4688?.data?.TokenElevationType).toBe('%%1938');
    expect(proc4688?.data?.MandatoryLabel).toBe('S-1-16-8192');
  });

  it('runas /user:Administrator conserve %%1937 pour un processus lancé pendant l\'élévation', async () => {
    const dc = new WindowsServer('DC01');
    dc.setCurrentUser('bob');
    expect(dc.getUserManager().isCurrentUserAdmin()).toBe(false);

    const out = await dc.executeCmdCommand('runas /user:Administrator "start notepad.exe"');
    expect(out).not.toMatch(/ERROR/i);

    const proc4688 = events(dc).find((e) => e.eventId === 4688 && e.data?.SubjectUserName === 'Administrator');
    expect(proc4688?.data?.TokenElevationType).toBe('%%1937');
    expect(proc4688?.data?.MandatoryLabel).toBe('S-1-16-12288');

    // L'élévation ne doit pas fuiter après le retour de runas.
    expect(dc.getCurrentUser()).toBe('bob');
  });

  it('runas journalise dynamiquement 4648 avec le vrai appelant (Subject) et la vraie cible (TargetUserName)', async () => {
    const dc = new WindowsServer('DC01');
    dc.setCurrentUser('bob');

    await dc.executeCmdCommand('runas /user:Administrator "echo hello"');

    const explicit = events(dc).find((e) => e.eventId === 4648 && e.data?.TargetUserName === 'Administrator');
    expect(explicit).toBeDefined();
    expect(explicit?.data?.SubjectUserName).toBe('bob');
  });

  it('un utilisateur non-administrateur ordinaire reste %%1936 (comportement historique inchangé)', async () => {
    const dc = new WindowsServer('DC01');
    dc.setCurrentUser('bob');
    expect(dc.getUserManager().isCurrentUserAdmin()).toBe(false);

    await dc.executeCmdCommand('start notepad.exe');

    const proc4688 = events(dc).find((e) => e.eventId === 4688 && e.data?.SubjectUserName === 'bob');
    expect(proc4688?.data?.TokenElevationType).toBe('%%1936');
  });
});
