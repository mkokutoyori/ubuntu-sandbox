/**
 * Un filtre `| include`, `| section`, `| begin` ne filtre pas le refus de l'analyseur.
 *
 * MESURE DE DEPART : `show running-config | section dhcp` saisi en EXEC utilisateur — ou
 * `show frobnicate | include x` — rendait une chaine VIDE. Le filtre s'appliquait au refus
 * `% Invalid input detected at '^' marker.` comme a la sortie d'une commande, et l'operateur
 * n'avait ni sortie ni explication. Sur IOS le refus vient de l'analyseur, avant le tube : il
 * s'affiche toujours. La spec e2e du tutoriel DHCP (« section dhcp » depuis `Passerelle>`) en a
 * revele l'effet : un terminal muet.
 *
 * DISCRIMINATION : les trois cas de refus tombent avant correctif (sortie vide). Passent des
 * deux cotes, TEMOINS : une commande valide dont le filtre ne retient rien rend toujours vide,
 * et un filtre qui retient une ligne la rend.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

type Machine = { executeCommand(c: string): Promise<string> };

async function routeur(privileged: boolean): Promise<Machine> {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
  const r = new CiscoRouter('R1', 0, 0) as unknown as Machine;
  if (privileged) await r.executeCommand('enable');
  return r;
}

describe('le refus de l analyseur traverse le tube', () => {
  it.each([
    ['show running-config | section dhcp', false],
    ['show frobnicate | include x', false],
    ['show frobnicate | begin x', true],
  ])('`%s`', async (commande, privileged) => {
    const sortie = await (await routeur(privileged)).executeCommand(commande);
    expect(sortie).toContain("% Invalid input detected at '^' marker.");
  });

  it('TEMOIN — une commande valide dont le filtre ne retient rien reste vide', async () => {
    const r = await routeur(true);
    expect(await r.executeCommand('show clock | include zzzzzzzz')).toBe('');
  });

  it('TEMOIN — un filtre qui retient une ligne la rend', async () => {
    const r = await routeur(true);
    expect(await r.executeCommand('show version | include Processor')).toContain('Processor board ID');
  });
});
