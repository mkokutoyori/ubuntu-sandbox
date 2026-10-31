/**
 * cp(1) -x / --one-file-system : une copie récursive ne descend pas dans un point de montage ; comportement documenté de GNU cp, mesuré sur un tmpfs monté dans l'arbre copié.
 * Mesure de départ : -x était accepté sans effet (le point de montage était copié). 1 des 3 cas tombe avant ; le témoin (cp -r sans -x) et la copie sans montage passent dans les deux états.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('cp -x', () => {
  let pc: LinuxPC;
  beforeEach(async () => {
    pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('sudo mkdir -p /srv/tree/mp; echo top | sudo tee /srv/tree/top.txt >/dev/null');
    await pc.executeCommand('sudo mount -t tmpfs tmpfs /srv/tree/mp; echo inner | sudo tee /srv/tree/mp/inner.txt >/dev/null');
  });

  it('-x laisse le point de montage de côté', async () => {
    await pc.executeCommand('sudo cp -rx /srv/tree /srv/copyx');
    expect(await pc.executeCommand('sudo find /srv/copyx | sort')).toBe('/srv/copyx\n/srv/copyx/top.txt');
  });
  it('témoin : sans -x le montage est copié', async () => {
    await pc.executeCommand('sudo cp -r /srv/tree /srv/copyr');
    expect(await pc.executeCommand('sudo find /srv/copyr | sort')).toBe('/srv/copyr\n/srv/copyr/mp\n/srv/copyr/mp/inner.txt\n/srv/copyr/top.txt');
  });
  it('-x sans montage copie tout', async () => {
    await pc.executeCommand('sudo mkdir -p /srv/plain/sub; echo v | sudo tee /srv/plain/sub/f >/dev/null; sudo cp -rx /srv/plain /srv/plain2');
    expect(await pc.executeCommand('sudo find /srv/plain2 | sort')).toBe('/srv/plain2\n/srv/plain2/sub\n/srv/plain2/sub/f');
  });
});
