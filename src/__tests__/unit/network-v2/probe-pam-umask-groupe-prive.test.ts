/**
 * pam_umask(8) + login.defs USERGROUPS_ENAB : su et sudo donnent l'umask 0002 à un utilisateur non root dont le groupe privé porte son nom, 0022 aux autres et à root ; relevé sur le su et le sudo réels de cette machine.
 * Mesure de départ : su et sudo appliquaient 0022 à tout le monde. 2 des 4 cas tombent avant ; passent dans les deux états : nobody et root (0022).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('umask de session', () => {
  let pc: LinuxPC;
  beforeEach(async () => {
    pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('sudo useradd -m tu');
  });

  it('su vers un utilisateur à groupe privé', async () => { expect(await pc.executeCommand('sudo su tu -c umask')).toBe('0002'); });
  it('sudo -u vers un utilisateur à groupe privé', async () => { expect(await pc.executeCommand('sudo -u tu sh -c umask')).toBe('0002'); });
  it('su -s vers nobody (groupe nogroup)', async () => { expect(await pc.executeCommand('sudo su -s /bin/sh nobody -c umask')).toBe('0022'); });
  it('su vers root', async () => { expect(await pc.executeCommand('sudo su root -c umask')).toBe('0022'); });
});
