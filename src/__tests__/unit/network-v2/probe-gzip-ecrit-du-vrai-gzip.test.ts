/**
 * RFC 1952 : `gzip` ecrit un membre gzip (1f 8b 08, FNAME, MTIME, CRC32, ISIZE) que lit n'importe quel gunzip.
 *
 * Mesure de depart : `gzip -k /tmp/a` ecrivait `!<simgz>\n{"name":...}` ; `xxd` ne montrait pas 1f8b et `file` ne le reconnaissait que par la
 * convention maison. Une seule representation : celle de rsyslog/Zlib.ts. Temoin : l'aller-retour `gzip` puis `gunzip` rend le contenu.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxServer } from '@/network/devices/LinuxServer';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

describe('gzip ecrit du vrai gzip', () => {
  it('commence par 1f 8b 08 08 et nomme le fichier d\'origine', async () => {
    const s = new LinuxServer('linux-server', 'S');
    await s.executeCommand('sh -c \'echo hello > /tmp/a\'');
    await s.executeCommand('gzip -k /tmp/a');
    expect(await s.executeCommand('xxd -l 4 /tmp/a.gz')).toContain('1f8b 0808');
    expect(await s.executeCommand('file /tmp/a.gz')).toContain('gzip compressed data, was "a"');
    expect(await s.executeCommand('gzip -l /tmp/a.gz')).toContain('a');
  });

  it('temoin : l\'aller-retour rend le contenu', async () => {
    const s = new LinuxServer('linux-server', 'S');
    await s.executeCommand('sh -c \'echo hello > /tmp/a\'');
    await s.executeCommand('gzip -k /tmp/a');
    await s.executeCommand('rm /tmp/a');
    await s.executeCommand('gunzip /tmp/a.gz');
    expect(await s.executeCommand('cat /tmp/a')).toBe('hello');
  });
});
