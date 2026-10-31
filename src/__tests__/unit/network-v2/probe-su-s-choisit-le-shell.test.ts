/**
 * su(1) -s SHELL : root peut choisir le shell d'un compte dont le shell est nologin ; un shell absent donne « failed to execute » (127) ; le message nologin se termine par un retour à la ligne ; sorties relevées sur le su réel de cette machine.
 * Mesure de départ : -s était ignoré, un shell absent n'était pas signalé, le message nologin n'avait pas de retour à la ligne et /usr/sbin/nologin n'existait pas dans le VFS. Les 4 cas tombent avant.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('su -s', () => {
  let pc: LinuxPC;
  beforeEach(() => { pc = new LinuxPC('linux-pc', 'PC1'); });

  it('-s /bin/sh ouvre une session pour nobody', async () => {
    expect(await pc.executeCommand("sudo su -s /bin/sh nobody -c 'id -un'")).toBe('nobody');
  });
  it('shell absent', async () => {
    expect(await pc.executeCommand('sudo su -s /bin/nonexistent nobody -c true; echo rc=$?')).toBe('su: failed to execute /bin/nonexistent: No such file or directory\nrc=127');
  });
  it('sans -s, nologin refuse avec un retour à la ligne', async () => {
    expect(await pc.executeCommand('sudo su nobody -c true; echo rc=$?')).toBe('This account is currently not available.\nrc=1');
  });
  it('-s /usr/sbin/nologin refuse aussi', async () => {
    expect(await pc.executeCommand('sudo su -s /usr/sbin/nologin nobody -c true; echo rc=$?')).toBe('This account is currently not available.\nrc=1');
  });
});
