/**
 * Le verrouillage de compte est celui de pam_faillock : les lignes `auth ... pam_faillock.so`
 * de la pile, /etc/security/faillock.conf et les fichiers de tally de /var/run/faillock/<user>.
 * L'outil `faillock` est celui de libpam 1.4.0 (modules/pam_faillock/main.c) : en-tete
 * « When Type Source Valid », une ligne par echec, --user, --reset, --dir, et ses messages
 * d'erreur.
 *
 * MESURE DE DEPART, LinuxPC, utilisateur `user`, `su carol` avec un mauvais mot de passe :
 *  - le gestionnaire de comptes tenait SA PROPRE tranche d'echecs (failedLoginCount, une
 *    politique AccountLockoutPolicy deny=3 / unlock_time=600 seme dans faillock.conf) : trois echecs
 *    verrouillaient le compte alors que la pile ne contenait AUCUNE ligne pam_faillock — ce que
 *    l'Ubuntu 22.04 livre : pas de verrouillage par defaut ;
 *  - ni /var/run/faillock/carol ni ligne `pam_faillock(su:auth)` n'existaient, `faillock` lisait le
 *    compteur du gestionnaire et pas les fichiers de tally ;
 *  - retirer les lignes pam_faillock d'une pile n'avait aucun effet.
 * Discriminee contre l'etat d'avant (`git stash push -- src/network src/shell src/terminal`) :
 * 5 des 12 cas tombent, ceux qui lancent `faillock` (l'ancien outil lisait le compteur du
 * gestionnaire de comptes). Les sept autres passent des deux cotes et sont NOMMES : le module
 * pam_faillock tenait deja les fichiers de tally et le verrouillage, et pam_unix refusait deja
 * un hash verrouille par usermod -L (non-regression : le moteur en doublon du gestionnaire de
 * comptes disparait sans changer ces verdicts), et « le bon mot de passe change d'identite » est
 * le temoin du labo.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { enableFaillock } from './faillockLab';

async function labo(faillock: readonly string[] | null = ['deny = 3']) {
  const pc = new LinuxPC('linux-pc', 'PC1');
  await pc.executeCommand('sudo useradd -m -s /bin/bash carol');
  await pc.executeCommand('echo "carol:carolpw" | sudo chpasswd');
  if (faillock !== null) enableFaillock(pc, faillock);
  const su = (password: string) => pc.executeCommand(`echo ${password} | su carol -c whoami`);
  const wrong = async (times: number) => { for (let i = 0; i < times; i++) await su('wrong'); };
  return { pc, su, wrong };
}

const LOCKED = 'The account is locked due to 3 failed logins.\n(10 minutes left to unlock)\nsu: Authentication failure';

afterEach(() => { vi.useRealTimers(); });

describe('pam_faillock decides, faillock reads its tally files', () => {
  it('the right password changes identity — WITNESS', async () => {
    const { su } = await labo(null);
    expect(await su('carolpw')).toBe('carol');
  });

  it('stock Ubuntu has no pam_faillock line: five failures lock nothing', async () => {
    const { su, wrong } = await labo(null);
    await wrong(5);
    expect(await su('carolpw')).toBe('carol');
  });

  it('with the pam_faillock lines, three failures refuse even the right password', async () => {
    const { su, wrong } = await labo();
    await wrong(3);
    expect(await su('carolpw')).toBe(LOCKED);
  });

  it('the failures live in /var/run/faillock/<user>, one record per failure', async () => {
    const { pc, wrong } = await labo();
    await wrong(2);
    const tally = String(await pc.executeCommand('sudo cat /var/run/faillock/carol'));
    expect(tally.split('\n').filter((line) => line.length > 0)).toHaveLength(2);
  });

  it('faillock prints the libpam table: header, one TTY row per failure', async () => {
    const { pc, wrong } = await labo();
    await wrong(2);
    const lines = String(await pc.executeCommand('sudo faillock --user carol')).split('\n');
    expect(lines[0]).toBe('carol:');
    expect(lines[1]).toBe(`${'When'.padEnd(19)} ${'Type'.padEnd(5)} ${'Source'.padEnd(48)} Valid`);
    expect(lines).toHaveLength(4);
    expect(lines[2]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} TTY {3}\/dev\/pts\/0 {43}V$/);
  });

  it('faillock without --user walks the tally directory', async () => {
    const { pc, wrong } = await labo();
    await wrong(1);
    const out = String(await pc.executeCommand('sudo faillock'));
    expect(out.split('\n')[0]).toBe('carol:');
  });

  it('faillock --reset empties the tally and the account opens again', async () => {
    const { pc, su, wrong } = await labo();
    await wrong(3);
    expect(await pc.executeCommand('sudo faillock --user carol --reset')).toBe('');
    expect(await su('carolpw')).toBe('carol');
  });

  it('unlock_time lets the account in once it has elapsed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { su, wrong } = await labo(['deny = 3', 'unlock_time = 60']);
    await wrong(3);
    expect(await su('carolpw')).toContain('su: Authentication failure');
    vi.advanceTimersByTime(61_000);
    expect(await su('carolpw')).toBe('carol');
  });

  it('the lock is logged by pam_faillock under the service that tripped it', async () => {
    const { pc, wrong } = await labo();
    await wrong(3);
    const log = String(await pc.executeCommand('sudo cat /var/log/auth.log'));
    expect(log).toContain('pam_faillock(su:auth): Consecutive login failures for user carol account temporarily locked');
  });

  it('a password locked by usermod -L is refused by the stack even when it is the right one', async () => {
    const { pc, su } = await labo(null);
    await pc.executeCommand('sudo usermod -L carol');
    expect(await su('carolpw')).toBe('su: Authentication failure');
    await pc.executeCommand('sudo usermod -U carol');
    expect(await su('carolpw')).toBe('carol');
  });

  it('an unknown option is refused with the libpam wording and the usage line', async () => {
    const { pc } = await labo();
    expect(await pc.executeCommand('sudo faillock --bogus')).toBe(
      'faillock: Unknown option: --bogus\nUsage: faillock [--dir /path/to/tally-directory] [--user username] [--reset]');
  });

  it('--dir points the tool at another tally directory', async () => {
    const { pc } = await labo();
    expect(await pc.executeCommand('sudo faillock --dir /nonexistent')).toBe(
      'faillock: Error reading tally directory: No such file or directory');
  });
});
