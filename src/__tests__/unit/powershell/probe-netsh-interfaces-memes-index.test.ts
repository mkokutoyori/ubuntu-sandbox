/**
 * `netsh` numerote les interfaces comme le reste de la machine.
 *
 * Mesure de depart, un `WindowsPC` cable :
 *
 *     route print            ->  2...02 00 00 00 00 01 ...  (Ethernet 0 = 2)
 *     Get-NetIPAddress       ->  fe80::ff:fe00:1%2
 *     netsh … ipv4 show interface
 *                            ->  Idx 1  Ethernet 0
 *     netsh … ipv6 show interface
 *                            ->  l'aide generique du contexte
 *
 * Le rendu `netsh` comptait ses propres lignes — `let idx = 1` — au lieu
 * de lire l'index de la machine. Une TROISIEME numerotation du meme fait,
 * apres celle d'`adapterIfIndexOf` et celle que `route print` affiche : la
 * meme carte s'appelait 2 dans trois vues et 1 dans la quatrieme. Le
 * bouclage, que Windows liste toujours en tete avec l'index 1, n'y
 * figurait pas du tout.
 *
 * La table IPv6 n'existait simplement pas : le contexte `ipv6` ne
 * reconnaissait pas `show interface` et rendait son aide. C'est la MEME
 * table sur une vraie machine, aux metriques par famille pres, et c'est
 * donc le meme rendu qui sert les deux.
 *
 * `Met` reste la constante 25 : la table debit → metrique de Microsoft
 * n'est pas atteignable depuis ce reseau (TODO.md), et l'inventer serait
 * pire que la repeter.
 *
 * Discrimination par `git stash` : 4 des 5 cas TOMBENT sans le lot.
 *
 * Le seul qui passe DES DEUX COTES est le TEMOIN : `route print` et
 * `Get-NetIPAddress` s'accordaient DEJA sur l'index 2. C'est lui qui
 * designe le coupable — la machine a bien UN index par carte, et c'est
 * `netsh` qui en inventait un autre. Sans lui, les quatre autres cas ne
 * diraient pas laquelle des vues a tort.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

function lab() {
  const win = new WindowsPC('windows-pc', 'WIN', 0, 0);
  const peer = new LinuxPC('linux-pc', 'LNX', 0, 0);
  new Cable('c').connect(win.getPorts()[0], peer.getPorts()[0]);
  win.setCurrentUser('Administrator');
  const sub = PowerShellSubShell.create(win).subShell;
  return {
    win,
    cmd: (l: string) => win.executeCommand(l),
    ps: async (l: string) => (await sub.processLine(l)).output.join('\n'),
  };
}

/** La ligne d'`Ethernet 0` dans un tableau `Idx Met MTU State Name`. */
const rowOf = (out: string, name: string): string =>
  out.split('\n').find(l => l.trimEnd().endsWith(name)) ?? '';

describe('netsh numerote comme la machine', () => {
  it('TEMOIN : les autres vues s accordent deja sur l index 2', async () => {
    const { win, ps } = lab();
    expect(await win.executeCommand('route print')).toMatch(/^\s+2\.\.\./m);
    expect(await ps('Get-NetIPAddress -InterfaceAlias "Ethernet 0" -AddressFamily IPv6 | Select-Object -ExpandProperty IPAddress'))
      .toMatch(/%2$/m);
  });

  it('`netsh interface ipv4 show interface` donne le MEME index', async () => {
    const { cmd } = lab();
    const row = rowOf(await cmd('netsh interface ipv4 show interface'), 'Ethernet 0');
    expect(row).toMatch(/^\s+2\s/);
  });

  it('le bouclage est liste, en tete et avec l index 1', async () => {
    const { cmd } = lab();
    const out = await cmd('netsh interface ipv4 show interface');
    expect(out).toContain('Loopback Pseudo-Interface 1');
    expect(rowOf(out, 'Loopback Pseudo-Interface 1')).toMatch(/^\s+1\s/);
  });

  it('le contexte ipv6 rend la meme table, pas son aide', async () => {
    const { cmd } = lab();
    const out = await cmd('netsh interface ipv6 show interface');
    expect(out).not.toContain('The following commands are available');
    expect(out).toContain('Ethernet 0');
    expect(rowOf(out, 'Ethernet 0')).toMatch(/^\s+2\s/);
  });

  it('les quatre cartes portent des index DISTINCTS et consecutifs', async () => {
    const { cmd } = lab();
    const out = await cmd('netsh interface ipv6 show interface');
    const index = ['Ethernet 0', 'Ethernet 1', 'Ethernet 2', 'Ethernet 3']
      .map(n => Number(rowOf(out, n).trim().split(/\s+/)[0]));
    expect(index).toEqual([2, 3, 4, 5]);
  });
});
