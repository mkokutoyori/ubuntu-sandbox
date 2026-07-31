/**
 * PRD-Winlogon.md §2.1 P2/P3 — verrouillage/déverrouillage de poste et
 * écran de veille protégé.
 *
 * `rundll32 user32.dll,LockWorkStation` (et le raccourci `lock`)
 * verrouillent réellement le poste : toute autre commande est refusée
 * tant qu'un `unlock <user> <password>` ne réussit pas. 4800/4801 sont
 * générés pour un verrouillage/déverrouillage manuel, 4802/4803 pour un
 * écran de veille.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function eventIds(pc: WindowsPC): number[] {
  return (pc.eventLog.getEntriesStructured('Security', { newest: 100 }) ?? []).map((e) => e.eventId);
}

/**
 * "Other Logon/Logoff Events" (4800-4803) is not in the default audit
 * baseline — matching real Windows, it's an optional advanced subcategory
 * — so every test here enables it explicitly first. Going through the
 * `auditpol` CLI would require the test's own current user to be an
 * Administrator, which would corrupt the "locked by <user>" assertions
 * below — so this reaches the policy object directly, the same way
 * topology-restore already does (`WindowsPC.ts` `settings.auditPolicy`
 * replay, ~line 1471-1473).
 */
function enableWorkstationLockAuditing(pc: WindowsPC): void {
  pc.auditPolicy.set('Other Logon/Logoff Events', { success: true, failure: true });
}

describe('PRD-Winlogon.md P2/P3 — verrouillage de poste', () => {
  it('rundll32 user32.dll,LockWorkStation verrouille réellement le poste et journalise 4800', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.setCurrentUser('user');
    enableWorkstationLockAuditing(pc);
    expect(pc.isLocked()).toBe(false);

    const out = await pc.executeCmdCommand('rundll32 user32.dll,LockWorkStation');
    expect(out).toBe('');
    expect(pc.isLocked()).toBe(true);
    expect(eventIds(pc)).toContain(4800);
  });

  it('le raccourci "lock" a le même effet observable', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.setCurrentUser('user');
    await pc.executeCmdCommand('lock');
    expect(pc.isLocked()).toBe(true);
  });

  it('verrouiller un poste déjà verrouillé est un no-op silencieux (pas de second 4800)', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.setCurrentUser('user');
    enableWorkstationLockAuditing(pc);
    await pc.executeCmdCommand('lock');
    await pc.executeCmdCommand('lock');
    expect(eventIds(pc).filter((id) => id === 4800)).toHaveLength(1);
  });

  it('toute commande autre qu\'UNLOCK échoue avec le message de verrouillage tant que le poste est verrouillé', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.setCurrentUser('user');
    await pc.executeCmdCommand('lock');

    const out = await pc.executeCmdCommand('echo hello');
    expect(out).toMatch(/This computer is locked/);
    expect(out).toMatch(/user or an administrator can unlock/i);
  });

  it('UNLOCK avec un mot de passe correct déverrouille le poste et journalise 4801, sans générer un nouveau 4624', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.setCurrentUser('user');
    enableWorkstationLockAuditing(pc);
    await pc.executeCmdCommand('lock');
    const before4624 = eventIds(pc).filter((id) => id === 4624).length;

    const out = await pc.executeCmdCommand('unlock user user');
    expect(pc.isLocked()).toBe(false);
    expect(out).toMatch(/unlocked successfully/i);
    expect(eventIds(pc)).toContain(4801);
    const after4624 = eventIds(pc).filter((id) => id === 4624).length;
    expect(after4624).toBe(before4624);
  });

  it('UNLOCK avec un mauvais mot de passe laisse le poste verrouillé et journalise 4625', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.setCurrentUser('user');
    await pc.executeCmdCommand('lock');

    const out = await pc.executeCmdCommand('unlock user wrongpassword');
    expect(pc.isLocked()).toBe(true);
    expect(out).toMatch(/incorrect/i);
    expect(eventIds(pc)).toContain(4625);
  });

  it('après déverrouillage, les commandes normales fonctionnent de nouveau', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.setCurrentUser('user');
    await pc.executeCmdCommand('lock');
    await pc.executeCmdCommand('unlock user user');

    const out = await pc.executeCmdCommand('echo hello');
    expect(out.trim()).toBe('hello');
  });

  it('un déverrouillage réussi via un second "terminal" (même appel device-level) lève le verrou pour tout le monde', async () => {
    // Il n'existe qu'un seul état de verrouillage par WindowsPC (§4.1 du
    // PRD) — pas par session de terminal — donc un déverrouillage
    // depuis n'importe quel appelant lève le verrou globalement.
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.setCurrentUser('user');
    await pc.executeCmdCommand('lock');
    expect(pc.isLocked()).toBe(true);

    pc.unlockWorkstation('user', 'user');
    expect(pc.isLocked()).toBe(false);
    // La commande normale passe désormais sur n'importe quel appelant.
    const out = await pc.executeCmdCommand('echo hello');
    expect(out.trim()).toBe('hello');
  });
});

describe('PRD-Winlogon.md P3 — écran de veille protégé', () => {
  it('invoquer l\'écran de veille verrouille le poste et journalise 4802 (pas 4800)', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.setCurrentUser('user');
    enableWorkstationLockAuditing(pc);

    pc.lockWorkstation('screensaver');
    expect(pc.isLocked()).toBe(true);
    expect(eventIds(pc)).toContain(4802);
    expect(eventIds(pc)).not.toContain(4800);
  });

  it('fermer l\'écran de veille avec le bon mot de passe journalise 4803 (pas 4801)', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.setCurrentUser('user');
    enableWorkstationLockAuditing(pc);

    pc.lockWorkstation('screensaver');
    const result = pc.unlockWorkstation('user', 'user');
    expect(result.ok).toBe(true);
    expect(pc.isLocked()).toBe(false);
    expect(eventIds(pc)).toContain(4803);
    expect(eventIds(pc)).not.toContain(4801);
  });
});
