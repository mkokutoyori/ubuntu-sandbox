/*
 * Sonde — `bfd interval <tx> min_rx <rx> multiplier <n>` applique l'intervalle d'emission.
 *
 * Mesure AVANT : la boucle de lecture appariait les mots deux a deux (cle, valeur) a partir du premier ; or le premier mot est la
 * VALEUR de `interval` (`300`), pas une cle. `300` etait lu comme une cle sans valeur numerique, donc ignoree, et l'intervalle
 * retombait sur le defaut de 1000 ms, quoi que l'operateur ait tape. `min_rx` et `multiplier` etaient, eux, bien lus.
 *
 * DEUX cas sur deux tombent avant : le decalage d'appariement faussait aussi `min_rx` et `multiplier` (la premiere paire lue etait
 * `300`/`min_rx`, la suivante `400`/`multiplier`). Le second cas est donc un cas de non-regression du meme defaut, et non un temoin ;
 * le temoin du laboratoire (session creee, timers relus) est que les deux passent apres le correctif.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

async function lab(): Promise<{ run: (c: string) => Promise<string> }> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as {
    executeCommand(c: string): Promise<string>; powerOn(): void;
  };
  r.powerOn();
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'bfd neighbor 10.0.0.2',
    'bfd interval 300 min_rx 400 multiplier 5', 'end']) await r.executeCommand(c);
  return { run: (c) => r.executeCommand(c) };
}

describe('bfd interval positional value', () => {
  it('applies the transmit interval', async () => {
    const out = await (await lab()).run('show bfd neighbors details');
    expect(out).toMatch(/MinTxInt: 300000\b/);
  });
  it('applies min_rx and multiplier', async () => {
    const out = await (await lab()).run('show bfd neighbors details');
    expect(out).toMatch(/MinRxInt: 400000, Multiplier: 5/);
  });
});
