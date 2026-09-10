/**
 * `netsh interface ipv6` lit et ecrit la table de LA MACHINE.
 *
 * Mesure de depart, un `WindowsPC` cable, sa carte portant sa `fe80::` et
 * la route connectee qui va avec :
 *
 *     netsh interface ipv6 show address    ->  l'aide generique du contexte
 *     netsh interface ipv6 show interface  ->  l'aide generique du contexte
 *     netsh interface ipv6 show route      ->  un tableau VIDE
 *     netsh interface ipv6 delete route …  ->  « Ok. », et rien de supprime
 *
 * Trois defauts, de trois natures.
 *
 * `show address` etait ECRIT mais inatteignable : l'aiguillage ne
 * reconnaissait que `addresses`, au pluriel, alors que la forme que
 * Microsoft documente est `show address`. Un mot, et la vue disparaissait.
 *
 * `show route` lisait un SECOND magasin : une `WeakMap` locale a `netsh`,
 * ou `add route` ecrivait et que personne d'autre ne lisait. Une route
 * ajoutee la n'orientait aucun paquet, n'apparaissait ni dans
 * `Get-NetRoute` ni dans `route print`, et la table connectee de la
 * machine n'y apparaissait pas non plus. Deux tables pour un seul fait.
 * Le commentaire du module disait deja que les ADRESSES vivent sur le
 * `Port` « pour que ipconfig, ping -6 et le plan de donnees voient le
 * meme etat » — les routes, elles, ne le faisaient pas.
 *
 * `delete route` rendait « Ok. » sans rien supprimer : l'annonce du
 * succes sans l'effet.
 *
 * `netsh` passe donc par la table de la machine, comme les deux autres
 * vues. La zone suit la meme regle que partout ailleurs sous Windows :
 * l'INDEX de l'interface, pas son nom.
 *
 * Discrimination par `git stash` : 5 des 6 cas TOMBENT sans le lot.
 *
 * Le seul qui passe DES DEUX COTES est le TEMOIN — `Get-NetRoute` voyait
 * deja la route connectee, fermee au lot precedent. Il est la parce qu'il
 * situe le defaut : la machine PORTE sa table et une AUTRE vue la lisait
 * deja, donc les cinq autres cas mesurent bien `netsh` et non l'absence
 * de la route.
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

const prefixes = (out: string): string[] =>
  out.split('\n').map(l => l.trim()).filter(Boolean);

describe('netsh interface ipv6 partage la table de la machine', () => {
  it('TEMOIN : Get-NetRoute voit deja la route connectee', async () => {
    const { ps } = lab();
    expect(await ps('Get-NetRoute -AddressFamily IPv6 | Select-Object -ExpandProperty DestinationPrefix'))
      .toContain('fe80::/10');
  });

  it('`show address` repond au singulier, la forme documentee', async () => {
    const { cmd } = lab();
    const out = await cmd('netsh interface ipv6 show address');
    expect(out).toMatch(/fe80::/);
    expect(out).not.toContain('The following commands are available');
  });

  it('la zone est l index de l interface, comme dans les autres vues', async () => {
    const { cmd } = lab();
    const out = await cmd('netsh interface ipv6 show address');
    expect(out).toMatch(/fe80::[0-9a-f:]+%\d+/);
    expect(out).not.toContain('%eth0');
  });

  it('`show route` rend la table de la MACHINE, pas un magasin a lui', async () => {
    const { cmd } = lab();
    expect(await cmd('netsh interface ipv6 show route')).toContain('fe80::/10');
  });

  it('une route ajoutee par netsh se lit par PowerShell, et sa suppression aussi', async () => {
    const { cmd, ps } = lab();
    expect(await cmd('netsh interface ipv6 add route 2001:db8:9::/64 "Ethernet 0" fe80::1'))
      .toContain('Ok.');

    const apres = prefixes(await ps('Get-NetRoute -AddressFamily IPv6 | Select-Object -ExpandProperty DestinationPrefix'));
    expect(apres).toContain('2001:db8:9::/64');
    expect(await cmd('netsh interface ipv6 show route')).toContain('2001:db8:9::/64');

    expect(await cmd('netsh interface ipv6 delete route 2001:db8:9::/64 "Ethernet 0"'))
      .toContain('Ok.');
    const final = prefixes(await ps('Get-NetRoute -AddressFamily IPv6 | Select-Object -ExpandProperty DestinationPrefix'));
    expect(final).not.toContain('2001:db8:9::/64');
  });

  it('supprimer une route absente ne s annonce pas comme un succes', async () => {
    const { cmd } = lab();
    expect(await cmd('netsh interface ipv6 delete route 2001:db8:ff::/64 "Ethernet 0"'))
      .toContain('Element not found.');
  });
});
