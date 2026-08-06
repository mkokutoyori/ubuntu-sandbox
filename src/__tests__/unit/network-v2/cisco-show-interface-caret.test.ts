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
    // IOS met le caret AVANT le message et ne réécrit pas la ligne saisie :
    // le terminal l'a déjà affichée, prompt compris — d'où le décalage.
    const prompt = 'R1#'.length;
    expect(lines[0]).toBe(`${' '.repeat(prompt + 'show interface '.length)}^`);
    expect(lines[1]).toContain('% Invalid input detected at \'^\' marker.');
    expect(lines[0]).not.toBe(`${' '.repeat(5)}^`);
  });

  it('la position du caret s\'adapte à la longueur du nom d\'interface', async () => {
    EquipmentRegistry.resetInstance();
    const r = new CiscoRouter('R1', 0, 0);
    const out = await r.executeCommand('show interface Gi0/0/99');
    const lines = out.split('\n');
    const prompt = 'R1#'.length;
    expect(lines[0]).toBe(`${' '.repeat(prompt + 'show interface '.length)}^`);
    expect(lines[1]).toContain('% Invalid input detected at \'^\' marker.');
  });
});
