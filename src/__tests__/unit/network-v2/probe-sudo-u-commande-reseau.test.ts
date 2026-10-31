/**
 * sudo(8) -u : une commande réseau lancée par « sudo -u USER » (au premier plan ou en tâche de fond) s'exécute sous USER ; relevé sur nc 1.226 / sudo réels (labo unix-user de netcmds-oracle).
 * Mesure de départ : « -u nobody » était pris pour le nom de la commande (127) et le travail se terminait aussitôt. 3 des 5 cas tombent avant (travail en cours, refus au premier plan, témoin sudo nc) ; la prise et le processus appartenant à USER passent dans les deux états (le chemin synchrone de sudo changeait déjà l'identité).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('sudo -u et commande réseau', () => {
  let pc: LinuxPC;
  beforeEach(async () => {
    pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('mkdir /tmp/lab; chmod 777 /tmp/lab');
  });

  it('la prise appartient à USER', async () => {
    await pc.executeCommand('sudo -u nobody nc -lU /tmp/lab/s1 &');
    expect(await pc.executeCommand('ls -l /tmp/lab/s1')).toContain('nobody');
  });
  it('le travail reste en cours', async () => {
    await pc.executeCommand('sudo -u nobody nc -lU /tmp/lab/s1 &');
    expect(await pc.executeCommand('jobs')).toContain('Running');
  });
  it('le processus appartient à USER', async () => {
    await pc.executeCommand('sudo -u nobody nc -lU /tmp/lab/s1 &');
    expect(await pc.executeCommand('ps -eo user,comm | grep nc')).toContain('nobody');
  });
  it('au premier plan, USER se voit refuser une prise en 700', async () => {
    await pc.executeCommand('sudo -u nobody nc -lU /tmp/lab/s1 &');
    await pc.executeCommand('sudo -u nobody chmod 700 /tmp/lab/s1');
    expect(await pc.executeCommand('sudo -u daemon nc -U /tmp/lab/s1 < /dev/null; echo rc=$?')).toBe('nc: /tmp/lab/s1: Permission denied\nrc=1');
  });
  it('témoin : sudo nc sans -u', async () => {
    await pc.executeCommand('sudo nc -lU /tmp/lab/s2 &');
    expect(await pc.executeCommand('ls -l /tmp/lab/s2')).toContain('root');
  });
});
