/**
 * shadow(5) / crypt(3) : /etc/shadow ne porte plus le mot de passe, mais un hash SHA-512-crypt que l'authentification recalcule ; un ancien « $6$simulated$… » est converti à la lecture.
 * Mesure de départ : chpasswd écrivait « $6$simulated$<clair> ». 4 des 5 cas d'origine tombent avant (le cas du sel d'usine fixe a été ajouté après qu'un sel aléatoire eut fait écrire /etc/shadow par la persistance) ; le témoin (la connexion avec le bon mot de passe) passe dans les deux états.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { sha512Crypt } from '@/crypto/passwords';

describe('/etc/shadow sans clair', () => {
  let pc: LinuxPC;
  beforeEach(() => { pc = new LinuxPC('linux-pc', 'PC1'); });

  it('chpasswd écrit un hash $6$ de 16 caractères de sel', async () => {
    await pc.executeCommand('echo user:Secret123 | sudo chpasswd');
    expect(await pc.executeCommand('sudo grep ^user: /etc/shadow')).toMatch(/^user:\$6\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]{86}:/);
  });
  it('le clair n\'apparaît nulle part dans le fichier', async () => {
    await pc.executeCommand('echo user:Secret123 | sudo chpasswd');
    expect(await pc.executeCommand('sudo cat /etc/shadow')).not.toContain('Secret123');
  });
  it('le hash est recalculable avec le sel du fichier', async () => {
    await pc.executeCommand('echo user:Secret123 | sudo chpasswd');
    const line = await pc.executeCommand('sudo grep ^user: /etc/shadow');
    const salt = /^user:\$6\$([^$]+)\$/.exec(line)![1];
    expect(line.split(':')[1]).toBe(sha512Crypt('Secret123', salt));
  });
  it('un hash collé à la main authentifie', async () => {
    const pasted = sha512Crypt('collé', 'aaaaaaaaaaaaaaaa');
    await pc.executeCommand(`sudo sed -i 's|^user:[^:]*:|user:${pasted.replace(/\$/g, '\\$')}:|' /etc/shadow`);
    expect(pc.checkPassword('user', 'collé')).toBe(true);
    expect(pc.checkPassword('user', 'autre')).toBe(false);
  });
  it('deux machines neuves portent le même /etc/shadow (le sel d\'usine est fixe)', async () => {
    const other = new LinuxPC('linux-pc', 'PC2');
    expect(await other.executeCommand('sudo cat /etc/shadow')).toBe(await pc.executeCommand('sudo cat /etc/shadow'));
  });
  it('témoin : le bon mot de passe ouvre, le mauvais non', async () => {
    await pc.executeCommand('echo user:Secret123 | sudo chpasswd');
    expect(pc.checkPassword('user', 'Secret123')).toBe(true);
    expect(pc.checkPassword('user', 'secret123')).toBe(false);
  });
});
