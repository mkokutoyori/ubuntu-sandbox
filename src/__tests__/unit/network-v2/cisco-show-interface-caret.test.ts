/**
 * `show interface <bad-name>` sur un routeur Cisco pointait toujours le
 * caret sous le "i" de "interface" (indentation fixe de 5 espaces codée
 * en dur), au lieu de sous le nom d'interface invalide lui-même — quels
 * que soient l'abréviation utilisée ou la longueur du nom.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario — Cisco "show interface <bad-name>" : caret sous le nom invalide', () => {
  it('le caret pointe sous le début du nom d\'interface, pas sous "interface"', async () => {
    EquipmentRegistry.resetInstance();
    const r = new CiscoRouter('R1', 0, 0);
    const out = await r.executeCommand('show interface FastEthernet99/99');
    const lines = out.split('\n');
    expect(lines[0]).toBe('% Invalid input detected at \'^\' marker.');
    expect(lines[1]).toBe('show interface FastEthernet99/99');
    // "show interface " is 15 chars — the bad name starts at column 15.
    expect(lines[2]).toBe(`${' '.repeat('show interface '.length)}^`);
    expect(lines[2]).not.toBe(`${' '.repeat(5)}^`); // the old, wrong position
  });

  it('la position du caret s\'adapte à la longueur du nom d\'interface', async () => {
    EquipmentRegistry.resetInstance();
    const r = new CiscoRouter('R1', 0, 0);
    const out = await r.executeCommand('show interface Gi0/0/99');
    const lines = out.split('\n');
    expect(lines[1]).toBe('show interface Gi0/0/99');
    expect(lines[2]).toBe(`${' '.repeat('show interface '.length)}^`);
  });
});
