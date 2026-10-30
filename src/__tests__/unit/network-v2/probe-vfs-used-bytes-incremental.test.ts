/**
 * Mesure : VirtualFileSystem.usedBytes() recalculait la somme de tous les inodes a chaque ecriture (fitsBytes), soit O(inodes) par ecriture.
 * Sous nat-lab, 1000 curl en parallele portent 16 000 inodes (/proc/<pid>/...) : le profil Chromium plaçait fitsBytes et usedBytes parmi les
 * premiers postes (4,6 s sur 71 s). Le total est maintenant tenu a chaque changement de taille, de generateur ou de suppression.
 *
 * Ce test tient la somme complete comme oracle : apres une suite pseudo-aleatoire d'operations (ecriture, ajout, troncature declaree, lien symbolique,
 * fichier genere, copie, renommage sur un fichier existant, suppression, rmrf), usedBytes() doit egaler la somme recalculee sur les inodes.
 * Avant le correctif usedBytes() EST la somme recalculee : les cas d'egalite passent des deux cotes (non-regression) ; le cas de duree
 * (20 000 ecritures sur 30 000 inodes sous 2 s) est celui qui tombe avant.
 */
import { describe, it, expect } from 'vitest';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

interface Inspectable { inodes: Map<number, { type: string; size: number; generator?: unknown }> }

function scannedBytes(vfs: VirtualFileSystem): number {
  let total = 0;
  for (const inode of (vfs as unknown as Inspectable).inodes.values()) {
    if (inode.type === 'directory' || inode.generator) continue;
    total += inode.size;
  }
  return total;
}

function lcg(seed: number): () => number {
  let state = seed;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0x100000000; };
}

describe('usedBytes tenu au fil des changements', () => {
  it('egale la somme recalculee apres une suite aleatoire d operations', () => {
    const vfs = new VirtualFileSystem();
    const random = lcg(7);
    const paths = Array.from({ length: 40 }, (_, i) => `/tmp/d${i % 5}/f${i}`);
    for (let step = 0; step < 4000; step++) {
      const path = paths[Math.floor(random() * paths.length)];
      const other = paths[Math.floor(random() * paths.length)];
      const text = 'x'.repeat(Math.floor(random() * 300));
      switch (Math.floor(random() * 9)) {
        case 0: vfs.writeFile(path, text, 0, 0, 0o022); break;
        case 1: vfs.writeFile(path, text, 0, 0, 0o022, true); break;
        case 2: vfs.writeFile(path, '', 0, 0, 0o022, false, Math.floor(random() * 5000)); break;
        case 3: vfs.deleteFile(path); break;
        case 4: vfs.createSymlink(`${path}.lnk`, other, 0, 0); break;
        case 5: vfs.registerGeneratedFile(path, () => 'generated'); break;
        case 6: { const source = vfs.resolveInode(path); if (source?.type === 'file') vfs.createFileAt(other, source.content, 0o644, 0, 0); break; }
        case 7: vfs.rename(path, other); break;
        default: if (random() < 0.1) vfs.rmrf(`/tmp/d${Math.floor(random() * 5)}`); break;
      }
      if (step % 250 === 0) expect(vfs.usedBytes()).toBe(scannedBytes(vfs));
    }
    expect(vfs.usedBytes()).toBe(scannedBytes(vfs));
    expect(vfs.usedBytes()).toBeGreaterThanOrEqual(0);
  });

  it('une ecriture refusee faute de place ne deplace pas le total', () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/tmp/a', 'abc', 0, 0, 0o022);
    vfs.setCapacityBytes(vfs.usedBytes() + 10);
    const before = vfs.usedBytes();

    expect(vfs.writeFile('/tmp/b', 'y'.repeat(100), 0, 0, 0o022)).toBe(false);
    expect(vfs.usedBytes()).toBe(before);
    expect(vfs.writeFile('/tmp/b', 'y'.repeat(10), 0, 0, 0o022)).toBe(true);
    expect(vfs.usedBytes()).toBe(before + 10);
    expect(vfs.usedBytes()).toBe(scannedBytes(vfs));
  });

  it('20 000 ecritures sur 30 000 inodes tiennent sous 2 s', () => {
    const vfs = new VirtualFileSystem();
    for (let i = 0; i < 30000; i++) vfs.writeFile(`/tmp/many/f${i}`, 'seed', 0, 0, 0o022);
    const startedAt = performance.now();
    for (let i = 0; i < 20000; i++) vfs.writeFile(`/tmp/many/f${i % 30000}`, `value ${i}`, 0, 0, 0o022);
    expect(performance.now() - startedAt).toBeLessThan(2000);
    expect(vfs.usedBytes()).toBe(scannedBytes(vfs));
  });
});
