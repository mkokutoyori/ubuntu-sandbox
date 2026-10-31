/**
 * Ubuntu livre /etc/hosts en root:root 0644 : un simple utilisateur le LIT et ne l'écrit pas. Mesure de départ : le fichier d'usine
 * était en 0666, le seul de /etc ouvert en écriture à tous (`find /etc -perm -0002`), si bien que `echo x >> /etc/hosts` réussissait
 * sans sudo. Témoin : root, via sudo, y écrit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxServer } from '@/network/devices/LinuxServer';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

describe('/etc/hosts est en 0644', () => {
  it('rien dans /etc n\'est inscriptible par tous, hors liens et sticky', async () => {
    const s = new LinuxServer('linux-server', 'S');
    expect(await s.executeCommand('stat -c %a /etc/hosts')).toBe('644');
    expect(await s.executeCommand('find /etc -maxdepth 1 -type f -perm -0002')).toBe('');
  });

  it('un utilisateur ordinaire ne peut pas y écrire', async () => {
    const s = new LinuxServer('linux-server', 'S');
    await s.executeCommand('useradd -m bob');
    const out = await s.executeCommand("su - bob -c 'echo 1.2.3.4 x >> /etc/hosts'");
    expect(out).toContain('Permission denied');
  });

  it('témoin : sudo tee -a y écrit', async () => {
    const s = new LinuxServer('linux-server', 'S');
    await s.executeCommand('echo 1.2.3.4 witness | sudo tee -a /etc/hosts > /dev/null');
    expect(await s.executeCommand('grep -c witness /etc/hosts')).toBe('1');
  });
});
