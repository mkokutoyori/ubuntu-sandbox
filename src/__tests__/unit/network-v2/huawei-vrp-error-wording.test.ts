/**
 * Huawei VRP CLI errors (routeur ET switch) affichaient le wording Cisco
 * "%" au lieu du wording "Error: ... found at '^' position." de VRP —
 * VRP n'utilise JAMAIS le préfixe "%". Root cause : CommandTrie.match()
 * (partagé par les deux vendeurs) code en dur le wording Cisco dans
 * `.error`, et `executeOnTrie()` faisait `result.error || HUAWEI_ERRORS.X`
 * — mais `.error` est TOUJOURS renseigné, donc le fallback Huawei correct
 * n'était jamais atteint (code mort).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let r: HuaweiRouter;
let sw: HuaweiSwitch;
beforeEach(() => {
  EquipmentRegistry.resetInstance();
  r = new HuaweiRouter('hwR1', 0, 0);
  sw = new HuaweiSwitch('hwSW1', 'SW1', 4);
});

describe('Scénario — HuaweiRouter : aucune trace du "%" de Cisco dans les erreurs CLI', () => {
  it('commande totalement inconnue ("dispaly", faute de frappe sur "display")', async () => {
    const out = await r.executeCommand('dispaly ip interface brief');
    expect(out).not.toContain('%');
    expect(out).toContain('Error: Unrecognized command found at \'^\' position.');
    expect(out).toContain('dispaly ip interface brief');
  });

  it('commande incomplète ("display" seul dans system-view attend un sous-mot-clé)', async () => {
    await r.executeCommand('system-view');
    const out = await r.executeCommand('display');
    expect(out).not.toContain('%');
    expect(out).toContain('Error: Incomplete command found at \'^\' position.');
  });

  it('commande ambiguë (préfixe correspondant à plusieurs mots-clés)', async () => {
    await r.executeCommand('system-view');
    // 'i' matches both 'interface' and 'ip' (and others) at top level.
    const out = await r.executeCommand('i');
    expect(out).not.toContain('%');
    expect(out).toContain('Error: Ambiguous command found at \'^\' position.');
  });

  it('le caret est positionné sous le premier caractère du mot fautif', async () => {
    const out = await r.executeCommand('dispaly ip interface brief');
    const lines = out.split('\n');
    const echoIdx = lines.findIndex((l) => l === 'dispaly ip interface brief');
    expect(echoIdx).toBeGreaterThanOrEqual(0);
    expect(lines[echoIdx + 1]).toBe('^'); // "dispaly" starts at column 0
  });
});

describe('Scénario — HuaweiSwitch : même correction, cohérence entre les deux shells Huawei', () => {
  it('commande totalement inconnue', async () => {
    const out = await sw.executeCommand('foobar');
    expect(out).not.toContain('%');
    expect(out).toContain('Error: Unrecognized command found at \'^\' position.');
  });

  it('commande incomplète (mot-clé avec sous-commandes, aucune fournie)', async () => {
    await sw.executeCommand('system-view');
    const out = await sw.executeCommand('display');
    expect(out).not.toContain('%');
    expect(out).toContain('Error: Incomplete command found at \'^\' position.');
  });
});
