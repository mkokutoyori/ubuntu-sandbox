/**
 * Une carte Windows dont le lien monte porte une adresse `fe80::/64`.
 *
 * Mesure de depart, un `WindowsPC` cable a un `LinuxPC`, les deux liens
 * montes, la carte Windows portant la MAC `02:00:00:00:00:01` :
 *
 *     WIN  Get-NetIPAddress -AddressFamily IPv6  ->  ::1   et rien d'autre
 *     WIN  ipconfig                              ->  aucune ligne IPv6
 *     LNX  ip -6 addr show eth0                  ->  inet6 fe80::ff:fe00:5/64
 *
 * Une vraie machine Windows autoconfigure une adresse de lien-local par
 * carte des que le lien monte ; c'est la premiere ligne que `ipconfig`
 * affiche sous chaque adaptateur. Le simulateur ne la posait NULLE PART :
 * aucune trame ne pouvait la porter, et `Get-NetRoute` ne la voyait pas.
 *
 * La derivation n'est pas reecrite. `Port.enableIPv6()` la pose deja —
 * c'est du materiel, partage par toutes les plateformes — et
 * `LinuxMachine` l'appelle au passage du lien a l'etat haut. `WindowsPC`
 * fait desormais de meme, par `EndHost.enableIPv6(iface)` qui pose EN
 * PLUS la route connectee du lien-local.
 *
 * Deux details de plateforme, mesures contre une vraie machine :
 *  - Windows numerote la ZONE par l'INDEX de l'interface (`%2`), la ou
 *    Linux la nomme (`%eth0`). Les vues Windows rendent donc `%<ifIndex>`.
 *  - `Get-NetIPAddress` et `ipconfig` sont deux vues d'UN magasin : elles
 *    lisent maintenant les memes adresses du meme port. Le fournisseur ne
 *    lisait que l'adresse IPv4 de la carte.
 *
 * Discrimination par `git stash` : 3 des 5 cas TOMBENT sans le lot — la
 * cmdlet qui ne rendait que `::1`, les deux vues qui ne montraient pas la
 * meme adresse, et la zone.
 *
 * Les 2 qui passent DES DEUX COTES :
 *  - le TEMOIN — le lien est monte et le voisin Linux porte bien SA
 *    `fe80::`. Sans lui, un cable qui ne relierait rien ferait passer les
 *    trois autres cas pour verts sans qu'aucune carte ne monte.
 *  - la carte SANS lien — elle n'en portait aucune avant, elle n'en porte
 *    aucune apres. C'est la porte que le lot ne doit pas ouvrir : une
 *    adresse de lien-local se pose quand le LIEN monte, pas a la
 *    construction de la machine.
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
  return { win, peer, ps: async (l: string) => (await sub.processLine(l)).output.join('\n') };
}

describe('une carte Windows porte son adresse de lien-local', () => {
  it('TEMOIN : le lien est bien monte, et le voisin Linux en porte une', async () => {
    const { win, peer } = lab();
    expect(win.getPorts()[0].isConnected()).toBe(true);
    expect(await peer.executeCommand('ip -6 addr show eth0')).toMatch(/inet6 fe80::/);
  });

  it('Get-NetIPAddress rend la fe80:: de la carte, pas seulement ::1', async () => {
    const { ps } = lab();
    const out = await ps('Get-NetIPAddress -AddressFamily IPv6 | Select-Object -ExpandProperty IPAddress');
    expect(out).toContain('::1');
    expect(out).toMatch(/fe80::/);
  });

  it('ipconfig affiche la meme adresse que Get-NetIPAddress', async () => {
    const { win, ps } = lab();
    const cmdlet = await ps('Get-NetIPAddress -AddressFamily IPv6 -InterfaceAlias "Ethernet 0" | Select-Object -ExpandProperty IPAddress');
    const linkLocal = cmdlet.split('\n').map(l => l.trim()).find(l => l.startsWith('fe80::'));
    expect(linkLocal).toBeDefined();
    expect(await win.executeCommand('ipconfig')).toContain(linkLocal!);
  });

  it('la ZONE est l index de l interface, comme sur Windows', async () => {
    const { win, ps } = lab();
    const out = await ps('Get-NetIPAddress -AddressFamily IPv6 -InterfaceAlias "Ethernet 0" | Select-Object -ExpandProperty IPAddress');
    const linkLocal = out.split('\n').map(l => l.trim()).find(l => l.startsWith('fe80::'));
    expect(linkLocal).toMatch(/%\d+$/);
    expect(linkLocal).not.toContain('%eth');
    expect(await win.executeCommand('ipconfig')).not.toContain('%eth0');
  });

  it('une carte SANS lien n en porte aucune', async () => {
    const { ps } = lab();
    const out = await ps('Get-NetIPAddress -AddressFamily IPv6 -InterfaceAlias "Ethernet 1" | Select-Object -ExpandProperty IPAddress');
    expect(out).not.toMatch(/fe80::/);
  });
});
