/**
 * Les comptes d'un poste Windows se jugent sur l'horloge du POSTE. `WindowsUserManager` lisait `simulationNowMs()` /
 * `simulationDate()` partout (expiration du compte, verrouillage, horaires de connexion, date du dernier changement de
 * mot de passe) : `net user bob /expires:...` posait une echeance que `Set-Date` / un saut d'horloge ne depassait jamais, donc un
 * compte expire ouvrait toujours une session (console, SSH par cle via S4U, `runas`). Corrige : le gestionnaire lit
 * `WindowsUserMachine.nowMs`, fournie par WindowsPC (`simulatedDate()`), comme `LinuxUserManager.setClock` cote Linux.
 *
 * Discrimine par `git stash` sur src/network : 2 des 3 cas tombent avant (expiration du compte, date de changement du mot de
 * passe). Le TEMOIN (avant l'echeance, la connexion n'est pas refusee) passe des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const DAY = 24 * 3600 * 1000;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Accounts {
  logonRefusal(name: string): string | null;
  isAccountExpired(name: string): boolean;
  getUser(name: string): { passwordLastSet: Date } | undefined;
}

const accountsOf = (pc: WindowsPC): Accounts => (pc as unknown as { userMgr: Accounts }).userMgr;

async function lab(): Promise<WindowsPC> {
  const pc = new WindowsPC('windows-pc', 'WIN1');
  pc.setCurrentUser('Administrator');
  await pc.executeCommand('net user bob P@ssw0rd1 /add');
  const expires = new Date(pc.getSystemClockMs() + 30 * DAY);
  const text = `${String(expires.getUTCMonth() + 1).padStart(2, '0')}/${String(expires.getUTCDate()).padStart(2, '0')}/${expires.getUTCFullYear()}`;
  await pc.executeCommand(`net user bob /expires:${text}`);
  return pc;
}

describe('un compte Windows se juge sur l horloge du poste', () => {
  it('TEMOIN — avant l echeance, le compte n est pas refuse', async () => {
    const pc = await lab();
    expect(accountsOf(pc).logonRefusal('bob')).toBeNull();
  });

  it('un poste avance de soixante jours refuse le compte expire', async () => {
    const pc = await lab();
    pc._stepSystemClock(60 * DAY);
    expect(accountsOf(pc).isAccountExpired('bob')).toBe(true);
    expect(accountsOf(pc).logonRefusal('bob')).toBe('expired');
  });

  it('net user date le changement de mot de passe sur l horloge du poste', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    pc.setCurrentUser('Administrator');
    pc._stepSystemClock(400 * DAY);
    await pc.executeCommand('net user dora P@ssw0rd1 /add');
    const set = accountsOf(pc).getUser('dora')!.passwordLastSet.getTime();
    expect(Math.abs(set - pc.getSystemClockMs())).toBeLessThan(5_000);
  });
});
