/**
 * La table de routage IPv6 d'un poste Windows se lit par SES DEUX vues.
 *
 * Mesure de depart, un `WindowsPC` cable, sa carte portant desormais une
 * adresse de lien-local et la route connectee qui va avec :
 *
 *     la machine        ->  fe80::/10 connected via eth0   (elle l'a)
 *     Get-NetRoute -AddressFamily IPv6
 *                       ->  « No matching MSFT_NetRoute objects found »
 *     route print -6    ->  la table IPv4, et pas de table IPv6 du tout
 *
 * Le fait EXISTE sur la machine et aucune des deux vues ne le lit. Le
 * fournisseur ne parcourait que `getRoutingTable()` — l'IPv4 — et
 * `showRoutePrint` ne rendait que la table IPv4 : `-4` et `-6`, pourtant
 * documentes dans l'aide de `route` elle-meme, etaient acceptes et
 * IGNORES, y compris la forme `route print -6` ou le drapeau suit le
 * verbe.
 *
 * La route de bouclage `::1/128` suit la regle que ce depot s'est deja
 * donnee pour l'IPv4 : UNE declaration (`WINDOWS_LOOPBACK_ROUTES_V6`),
 * deux lecteurs, au lieu d'un nombre recopie de chaque cote.
 *
 * `fe80::/10` et non `/64` : c'est ce que la machine porte vraiment
 * (`EndHost.ensureLinkLocalRoute`, choix documente la-bas). Une vraie
 * machine Windows affiche `fe80::/64`. Les vues rendent ici la table
 * REELLE plutot qu'un chiffre plus flatteur ; l'ecart appartient au plan
 * de donnees IPv6, pas a l'affichage.
 *
 * Discrimination par `git stash` : 4 des 5 cas TOMBENT sans le lot.
 *
 * Le seul qui passe DES DEUX COTES est le TEMOIN : la machine PORTE deja
 * sa route, avant comme apres. C'est precisement ce qui fait du reste un
 * defaut de VUE et non de moteur — sans lui, on ne saurait pas si les
 * quatre autres cas mesurent une route absente ou une route invisible.
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
  return { win, ps: async (l: string) => (await sub.processLine(l)).output.join('\n') };
}

describe('les routes IPv6 d une machine Windows', () => {
  it('TEMOIN : la machine porte bien la route connectee du lien-local', () => {
    const { win } = lab();
    const routes = (win as unknown as {
      getIPv6RoutingTable(): Array<{ prefix: { toString(): string }; iface: string }>;
    }).getIPv6RoutingTable();
    expect(routes.some(r => r.prefix.toString() === 'fe80::' && r.iface === 'eth0')).toBe(true);
  });

  it('Get-NetRoute rend la route du lien-local et celle du bouclage', async () => {
    const { ps } = lab();
    const out = await ps('Get-NetRoute -AddressFamily IPv6 | Select-Object -ExpandProperty DestinationPrefix');
    expect(out).toContain('fe80::/10');
    expect(out).toContain('::1/128');
  });

  it('`route print -6` rend la table IPv6, dans la mise en page de Windows', async () => {
    const { win } = lab();
    const out = await win.executeCommand('route print -6');
    expect(out).toContain('IPv6 Route Table');
    expect(out).toMatch(/ If Metric Network Destination\s+Gateway/);
    expect(out).toContain('fe80::/10');
    expect(out).toContain('::1/128');
  });

  it('les deux vues nomment les MEMES prefixes', async () => {
    const { win, ps } = lab();
    const cmdlet = (await ps('Get-NetRoute -AddressFamily IPv6 | Select-Object -ExpandProperty DestinationPrefix'))
      .split('\n').map(l => l.trim()).filter(Boolean).sort();
    const print = await win.executeCommand('route print -6');
    for (const prefix of cmdlet) expect(print).toContain(prefix);
  });

  it('`-4` et `-6` choisissent la table, ou qu ils soient ecrits', async () => {
    const { win } = lab();
    const deux = await win.executeCommand('route print');
    expect(deux).toContain('IPv4 Route Table');
    expect(deux).toContain('IPv6 Route Table');

    const quatre = await win.executeCommand('route print -4');
    expect(quatre).toContain('IPv4 Route Table');
    expect(quatre).not.toContain('IPv6 Route Table');

    const six = await win.executeCommand('route -6 print');
    expect(six).not.toContain('IPv4 Route Table');
    expect(six).toContain('IPv6 Route Table');
  });
});
