/**
 * procps sysctl -p / --system : /etc/sysctl.conf existe comme sur Ubuntu (copie du fichier d'une Ubuntu 24.04 réelle) et /etc/sysctl.d/99-sysctl.conf y renvoie.
 * Mesure de départ : « sysctl -p » répondait « cannot open "/etc/sysctl.conf" ». 4 des 5 cas tombent avant ; le témoin (sysctl lit un paramètre) passe dans les deux états.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('/etc/sysctl.conf livré', () => {
  let pc: LinuxPC;
  beforeEach(() => { pc = new LinuxPC('linux-pc', 'PC1'); });

  it('sysctl -p sur une machine neuve ne dit rien', async () => { expect(await pc.executeCommand('sudo sysctl -p; echo rc=$?')).toBe('rc=0'); });
  it('le fichier est de root, 0644', async () => { expect(await pc.executeCommand('ls -l /etc/sysctl.conf')).toMatch(/^-rw-r--r-- 1 root root \d+ .* \/etc\/sysctl\.conf$/); });
  it('l\'en-tête est celui de Debian', async () => { expect(await pc.executeCommand('head -2 /etc/sysctl.conf')).toBe('#\n# /etc/sysctl.conf - Configuration file for setting system variables'); });
  it('99-sysctl.conf est un lien vers lui', async () => { expect(await pc.executeCommand('readlink /etc/sysctl.d/99-sysctl.conf')).toBe('../sysctl.conf'); });
  it('témoin : sysctl lit un paramètre', async () => { expect(await pc.executeCommand('sysctl -n net.ipv4.ip_forward')).toBe('0'); });
});
