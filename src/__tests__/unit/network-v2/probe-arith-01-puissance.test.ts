/**
 * Probes — l'opérateur de puissance de `$(( ))`.
 *
 * `echo $((2 ** 8))` rendait `0` : l'analyseur lexical de l'expansion
 * arithmétique ne connaissait pas `**` et lisait deux multiplications
 * de suite. Le transcript `linux-text-pipes` le montrait en clair, à
 * côté des lignes `bc` de la même section.
 *
 * Les valeurs attendues sont celles de bash, relevées sur la machine :
 * `**` lie plus fort que `*`, associe à droite, et refuse un exposant
 * négatif au lieu de le tronquer à zéro. `**=` n'existe pas en bash et
 * n'a donc pas été ajouté.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

function lab(): LinuxPC {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  pc.powerOn();
  return pc;
}

describe('Scénario 1 — `**` calcule une puissance', () => {
  it('la forme du transcript rend 256, plus zéro', async () => {
    const pc = lab();
    expect(await pc.executeCommand('echo $((2 ** 8))')).toBe('256');
    expect(await pc.executeCommand('echo $((2**8))')).toBe('256');
  });

  it('l\'exposant zéro rend un', async () => {
    const pc = lab();
    expect(await pc.executeCommand('echo $((2 ** 0))')).toBe('1');
  });

  it('une base négative garde son signe', async () => {
    const pc = lab();
    expect(await pc.executeCommand('echo $(((-2) ** 3))')).toBe('-8');
  });
});

describe('Scénario 2 — priorité et associativité', () => {
  it('`**` associe à droite : 2**3**2 vaut 512, pas 64', async () => {
    const pc = lab();
    expect(await pc.executeCommand('echo $((2**3**2))')).toBe('512');
  });

  it('`**` lie plus fort que `*` et que `+`', async () => {
    const pc = lab();
    expect(await pc.executeCommand('echo $((3 * 2 ** 3))')).toBe('24');
    expect(await pc.executeCommand('echo $((1 + 2 ** 3))')).toBe('9');
  });

  it('une multiplication ordinaire n\'a pas changé', async () => {
    const pc = lab();
    expect(await pc.executeCommand('echo $((7 * 6))')).toBe('42');
    expect(await pc.executeCommand('echo $((100 % 7))')).toBe('2');
  });
});

describe('Scénario 3 — ce que bash refuse', () => {
  it('un exposant négatif est une erreur, pas un zéro silencieux', async () => {
    const pc = lab();
    // bash : « exponent less than 0 ». Rendre 0 serait une réponse fausse
    // présentée comme un résultat.
    const out = await pc.executeCommand('echo $((10 ** -1))');
    expect(out).not.toBe('0');
    expect(out.toLowerCase()).toContain('arithmetic');
  });
});
