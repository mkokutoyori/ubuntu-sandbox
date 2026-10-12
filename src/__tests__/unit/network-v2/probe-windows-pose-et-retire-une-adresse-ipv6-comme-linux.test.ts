/**
 * Une adresse IPv6 posee sur une machine Windows est posee UNE fois : sur le port ET dans sa table de routes, par la
 * methode que Linux emploie deja (`EndHost.configureIPv6Interface`) ; `netsh interface ipv6 add address`,
 * `New-NetIPAddress` et `ip -6 addr add` en sont trois portes. Retiree, elle l'est des deux endroits, par la methode
 * soeur (`EndHost.removeIPv6Interface`) que `netsh interface ipv6 delete address`, `Remove-NetIPAddress` et
 * `ip -6 addr del` partagent ; la route du prefixe ne part qu'avec la derniere adresse qui le couvre.
 *
 * Mesure de depart (33a7166a5), un Linux et un Windows relies par un cable, `fd00::/64` des deux cotes : le Linux
 * envoie sa sollicitation de voisin, Windows y repond (annonce de voisin), le Linux envoie son echo-request, Windows le
 * RECOIT et n'y repond pas. `handleICMPv6EchoRequest` cherche la route de retour de l'adresse source et n'en trouve
 * pas : `netsh interface ipv6 add address` appelait `port.configureIPv6` sans poser la route du prefixe, que
 * `ip -6 addr add` pose. De la, `ping -6` : 100 % de pertes, `nc -6 -zv` : delai depasse, avec le prefixe absent de
 * `route print -6`, de `netsh interface ipv6 show route` et de `Get-NetRoute`. Par ailleurs `New-NetIPAddress` d'une
 * adresse IPv6 ne l'inscrivait que dans le magasin PowerShell (`extraIPs`) : `Get-NetIPAddress` la listait, `ipconfig`
 * et le fil l'ignoraient ; `Remove-NetIPAddress` d'une adresse IPv4 posee par `netsh` n'etait un acte que pour les
 * adresses nees de `New-NetIPAddress` : la commande reussissait en silence et l'adresse restait dans `ipconfig` ;
 * enfin `ip -6 addr del` repondait toujours `RTNETLINK answers: Cannot assign requested address` (l'analyseur ne
 * connaissait que l'IPv4, la methode `removeInterfaceIPv6` du contexte n'etait appelee par personne).
 *
 * Autorites : le comportement de Linux est celui du noyau (une adresse sur un prefixe porte la route connectee, la
 * derniere adresse du prefixe l'emporte avec elle ; `RTNETLINK answers: Cannot assign requested address` pour une
 * adresse absente). Pour Windows, les vues qui doivent s'accorder sont celles que la machine possede deja : `ipconfig`,
 * `netsh interface ipv6 show address|route`, `route print -6`, `Get-NetIPAddress`, `Get-NetRoute`. Non confirme : le
 * texte exact d'une re-ajout d'une adresse existante (`netsh` repond ici `Ok.` comme avant).
 *
 * La route connectee est identifiee par (interface, prefixe, longueur) : `configureIPv6Interface` ignorait la longueur et
 * n'installait pas `fd00::/48` quand `fd00::/64` existait deja pour la meme interface.
 *
 * Discrimination (fichier copie sur 33a7166a5) : DIX-SEPT cas sur vingt-cinq tombent. Les huit autres passent des deux
 * cotes : les deux temoins du banc (deux Linux se repondent en IPv6 ; un Windows sans adresse IPv6 ne repond pas),
 * les deux refus d'une adresse absente (`netsh ... delete address`, `ip -6 addr del`) qui etaient deja justes,
 * `Remove-NetIPAddress` d'une adresse nee de `New-NetIPAddress` (temoin), et trois proprietes que le changement ne devait
 * pas casser : l'adresse n'est listee qu'une fois, les attributs que la commande a enregistres restent sur la ligne, et
 * l'adresse IPv4 de l'interface reste. Mutations, toutes tuees (13) : route jamais retiree 5, retiree meme quand une
 * autre adresse couvre le prefixe 2, couverture qui ignore la longueur 1, filtre de route qui ignore l'interface 1, retrait
 * d'une adresse absente annonce reussi 2, `netsh add` sans route 5, `netsh delete` sans route 1, PowerShell : ajout qui
 * n'atteint pas le port 3, retrait IPv6 qui ne l'atteint pas 2, retrait IPv4 limite aux adresses enregistrees 2 ;
 * Linux : branche IPv6 de `ip addr del` supprimee 7, retrait sans route 4, retrait d'une adresse absente silencieux 1.
 * Un quatorzieme mutant (le suffixe de zone d'une adresse de lien n'est pas retire avant l'analyse) survit parce que
 * `IPv6Address` lit deja la zone : le code qui la retirait etait superflu et a ete supprime.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import type { EthernetFrame, ICMPv6Packet, IPv6Packet } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { watchWire } from '../../support/wireWatch';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

type Shell = ReturnType<typeof PowerShellSubShell.create>['subShell'];

interface Bench {
  readonly linux: LinuxPC;
  readonly win: WindowsPC;
  readonly sh: Shell;
  powershell(line: string): Promise<string>;
  linuxPings(target: string): Promise<boolean>;
}

async function bench(): Promise<Bench> {
  const linux = new LinuxPC('linux-pc', 'LIN', 0, 0);
  const win = new WindowsPC('windows-pc', 'WIN', 100, 0);
  linux.powerOn();
  win.powerOn();
  new Cable('c1').connect(linux.getPort('eth0')!, win.getPort('eth0')!);
  await linux.executeCommand('ip -6 addr add fd00::1/64 dev eth0');
  const sh = PowerShellSubShell.create(win).subShell;
  return {
    linux,
    win,
    sh,
    powershell: async (line) => (await sh.processLine(line)).output.join('\n').trim(),
    linuxPings: async (target) => /1 received/.test(await linux.executeCommand(`ping -6 -c 1 ${target}`)),
  };
}

async function linuxPair(): Promise<{ readonly first: LinuxPC; readonly second: LinuxPC }> {
  const first = new LinuxPC('linux-pc', 'LIN', 0, 0);
  const second = new LinuxPC('linux-pc', 'LIN2', 100, 0);
  first.powerOn();
  second.powerOn();
  new Cable('c1').connect(first.getPort('eth0')!, second.getPort('eth0')!);
  await first.executeCommand('ip -6 addr add fd00::1/64 dev eth0');
  await second.executeCommand('ip -6 addr add fd00::2/64 dev eth0');
  return { first, second };
}

const icmpv6TypeOf = (frame: EthernetFrame): string | null => {
  const packet = frame.payload as IPv6Packet;
  if (packet?.type !== 'ipv6') return null;
  const inner = packet.payload as ICMPv6Packet | undefined;
  return inner?.type === 'icmpv6' ? inner.icmpType : null;
};

describe('the bench is sound (witness)', () => {
  it('two Linux hosts on the same prefix answer each other over IPv6', async () => {
    const { first } = await linuxPair();
    expect(await first.executeCommand('ping -6 -c 1 fd00::2')).toMatch(/1 received/);
  });

  it('a Windows host that was given no IPv6 address does not answer', async () => {
    const { linuxPings } = await bench();
    expect(await linuxPings('fd00::7')).toBe(false);
  });
});

describe('netsh interface ipv6 add address', () => {
  it('makes the Windows host answer a ping from its neighbour', async () => {
    const { win, linuxPings } = await bench();
    await win.executeCommand('netsh interface ipv6 add address "Ethernet 0" fd00::7/64');
    expect(await linuxPings('fd00::7')).toBe(true);
  });

  it('answers with one real echo-reply frame that leaves the Windows port', async () => {
    const { win, linux } = await bench();
    await win.executeCommand('netsh interface ipv6 add address "Ethernet 0" fd00::7/64');
    const wire = watchWire(win);
    await linux.executeCommand('ping -6 -c 1 fd00::7');
    const kinds = wire.frames.map((f) => `${f.direction}:${icmpv6TypeOf(f.frame)}`);
    expect(kinds.filter((kind) => kind === 'in:echo-request')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'out:echo-reply')).toHaveLength(1);
  });

  it('puts the prefix in every view of the Windows routes', async () => {
    const { win, powershell } = await bench();
    await win.executeCommand('netsh interface ipv6 add address "Ethernet 0" fd00::7/64');
    expect(await win.executeCommand('route print -6')).toMatch(/fd00::\/64\s+On-link/);
    expect(await win.executeCommand('netsh interface ipv6 show route')).toMatch(/Connected\s+0\s+fd00::\/64\s+Ethernet 0/);
    expect(await powershell('Get-NetRoute -AddressFamily IPv6 | Format-Table DestinationPrefix,InterfaceAlias'))
      .toMatch(/fd00::\/64\s+Ethernet 0/);
  });

  it('takes the prefix away with the address: no answer, no route', async () => {
    const { win, linuxPings } = await bench();
    await win.executeCommand('netsh interface ipv6 add address "Ethernet 0" fd00::7/64');
    expect(await linuxPings('fd00::7')).toBe(true);
    expect(await win.executeCommand('netsh interface ipv6 delete address "Ethernet 0" fd00::7')).toBe('Ok.');
    expect(await win.executeCommand('route print -6')).not.toContain('fd00::/64');
    expect(await win.executeCommand('netsh interface ipv6 show route')).not.toContain('fd00::/64');
    expect(await linuxPings('fd00::7')).toBe(false);
  });

  it('keeps the prefix while another address still covers it', async () => {
    const { win, linuxPings } = await bench();
    await win.executeCommand('netsh interface ipv6 add address "Ethernet 0" fd00::7/64');
    await win.executeCommand('netsh interface ipv6 add address "Ethernet 0" fd00::8/64');
    await win.executeCommand('netsh interface ipv6 delete address "Ethernet 0" fd00::7');
    expect(await win.executeCommand('route print -6')).toContain('fd00::/64');
    expect(await linuxPings('fd00::8')).toBe(true);
    expect(await linuxPings('fd00::7')).toBe(false);
  });

  it('answers that a deleted address that was never there does not exist', async () => {
    const { win } = await bench();
    expect(await win.executeCommand('netsh interface ipv6 delete address "Ethernet 0" fd00::9'))
      .toBe('The specified value does not exist.');
  });
});

describe('New-NetIPAddress and Remove-NetIPAddress with an IPv6 address', () => {
  it('puts the address on the port: ipconfig lists it', async () => {
    const { win, powershell } = await bench();
    await powershell('New-NetIPAddress -IPAddress fd00::7 -InterfaceAlias "Ethernet 0" -PrefixLength 64');
    expect(await win.executeCommand('ipconfig')).toMatch(/IPv6 Address[ .]*: fd00::7/);
  });

  it('puts the address on the wire: the neighbour gets an answer', async () => {
    const { powershell, linuxPings } = await bench();
    await powershell('New-NetIPAddress -IPAddress fd00::7 -InterfaceAlias "Ethernet 0" -PrefixLength 64');
    expect(await linuxPings('fd00::7')).toBe(true);
  });

  it('lists the address once, whichever store holds it', async () => {
    const { powershell } = await bench();
    await powershell('New-NetIPAddress -IPAddress fd00::7 -InterfaceAlias "Ethernet 0" -PrefixLength 64');
    const rows = (await powershell('Get-NetIPAddress -AddressFamily IPv6 | Format-Table IPAddress'))
      .split('\n').filter((line) => line.trim() === 'fd00::7');
    expect(rows).toHaveLength(1);
  });

  it('keeps the attributes the cmdlet recorded on the row it now reads from the port', async () => {
    const { powershell } = await bench();
    await powershell('New-NetIPAddress -IPAddress fd00::7 -InterfaceAlias "Ethernet 0" -PrefixLength 64 -SkipAsSource $true');
    expect(await powershell('(Get-NetIPAddress -IPAddress fd00::7).SkipAsSource')).toBe('True');
  });

  it('takes the address away from the port, the routes and the wire', async () => {
    const { win, powershell, linuxPings } = await bench();
    await powershell('New-NetIPAddress -IPAddress fd00::7 -InterfaceAlias "Ethernet 0" -PrefixLength 64');
    expect(await win.executeCommand('ipconfig')).toContain('fd00::7');
    await powershell('Remove-NetIPAddress -IPAddress fd00::7 -Confirm:$false');
    expect(await win.executeCommand('ipconfig')).not.toContain('fd00::7');
    expect(await win.executeCommand('route print -6')).not.toContain('fd00::/64');
    expect(await linuxPings('fd00::7')).toBe(false);
  });

  it('removes every address Get-NetIPAddress hands it, the zone of a link-local one included', async () => {
    const { win, powershell } = await bench();
    await powershell('New-NetIPAddress -IPAddress fd00::7 -InterfaceAlias "Ethernet 0" -PrefixLength 64');
    expect(await win.executeCommand('ipconfig')).toMatch(/Link-local IPv6 Address[ .]*: fe80::/);
    await powershell('Get-NetIPAddress -InterfaceAlias "Ethernet 0" -AddressFamily IPv6 | Remove-NetIPAddress -Confirm:$false');
    const after = await win.executeCommand('ipconfig');
    expect(after).not.toContain('fd00::7');
    expect(after).not.toMatch(/Link-local IPv6 Address[ .]*: fe80::/);
  });

  it('does not touch the IPv4 address of the interface', async () => {
    const { win, powershell } = await bench();
    await win.executeCommand('netsh interface ip set address "Ethernet 0" static 10.0.0.7 255.255.255.0');
    await powershell('New-NetIPAddress -IPAddress fd00::7 -InterfaceAlias "Ethernet 0" -PrefixLength 64');
    await powershell('Remove-NetIPAddress -IPAddress fd00::7 -Confirm:$false');
    expect(await win.executeCommand('ipconfig')).toContain('10.0.0.7');
  });
});

describe('Remove-NetIPAddress with an IPv4 address', () => {
  it('removes an address that netsh set, from the port that carries it', async () => {
    const { win, powershell } = await bench();
    await win.executeCommand('netsh interface ip set address "Ethernet 0" static 10.0.0.7 255.255.255.0');
    expect(await win.executeCommand('ipconfig')).toContain('10.0.0.7');
    await powershell('Remove-NetIPAddress -IPAddress 10.0.0.7 -Confirm:$false');
    expect(await win.executeCommand('ipconfig')).not.toContain('10.0.0.7');
    expect(await powershell('Get-NetIPAddress -AddressFamily IPv4 | Format-Table IPAddress')).not.toContain('10.0.0.7');
  });

  it('removes an address that New-NetIPAddress set (witness)', async () => {
    const { win, powershell } = await bench();
    await powershell('New-NetIPAddress -IPAddress 10.0.0.9 -InterfaceAlias "Ethernet 0" -PrefixLength 24');
    expect(await win.executeCommand('ipconfig')).toContain('10.0.0.9');
    await powershell('Remove-NetIPAddress -IPAddress 10.0.0.9 -Confirm:$false');
    expect(await win.executeCommand('ipconfig')).not.toContain('10.0.0.9');
  });
});

describe('ip -6 addr del on a Linux host', () => {
  it('removes the address the way ip -6 addr add put it', async () => {
    const { linux } = await bench();
    expect(await linux.executeCommand('ip -6 addr del fd00::1/64 dev eth0')).toBe('');
    expect(await linux.executeCommand('ip -6 addr show dev eth0')).not.toContain('fd00::1');
  });

  it('removes the route of the prefix with the last address that covers it', async () => {
    const { linux } = await bench();
    expect(await linux.executeCommand('ip -6 route')).toContain('fd00::/64 dev eth0');
    await linux.executeCommand('ip -6 addr del fd00::1/64 dev eth0');
    expect(await linux.executeCommand('ip -6 route')).not.toContain('fd00::/64');
  });

  it('keeps the route while another address covers the prefix', async () => {
    const { linux } = await bench();
    await linux.executeCommand('ip -6 addr add fd00::2/64 dev eth0');
    await linux.executeCommand('ip -6 addr del fd00::1/64 dev eth0');
    expect(await linux.executeCommand('ip -6 route')).toContain('fd00::/64 dev eth0');
    const addresses = await linux.executeCommand('ip -6 addr show dev eth0');
    expect(addresses).toContain('inet6 fd00::2/64');
    expect(addresses).not.toContain('inet6 fd00::1/64');
  });

  it('keeps the route of another interface that carries the same prefix', async () => {
    const { linux } = await bench();
    await linux.executeCommand('ip -6 addr add fd00::5/64 dev eth1');
    await linux.executeCommand('ip -6 addr del fd00::1/64 dev eth0');
    const routes = await linux.executeCommand('ip -6 route');
    expect(routes).toContain('fd00::/64 dev eth1');
    expect(routes).not.toContain('fd00::/64 dev eth0');
  });

  it('tells two prefixes of different lengths apart when they start at the same address', async () => {
    const { linux } = await bench();
    await linux.executeCommand('ip -6 addr add fd00::2/48 dev eth0');
    expect(await linux.executeCommand('ip -6 route')).toContain('fd00::/48 dev eth0');
    await linux.executeCommand('ip -6 addr del fd00::1/64 dev eth0');
    const routes = await linux.executeCommand('ip -6 route');
    expect(routes).toContain('fd00::/48 dev eth0');
    expect(routes).not.toContain('fd00::/64 dev eth0');
  });

  it('stops answering the neighbours at the address it gave up', async () => {
    const { first, second } = await linuxPair();
    expect(await second.executeCommand('ping -6 -c 1 fd00::1')).toMatch(/1 received/);
    await first.executeCommand('ip -6 addr del fd00::1/64 dev eth0');
    expect(await second.executeCommand('ping -6 -c 1 fd00::1')).not.toMatch(/1 received/);
  });

  it('refuses an address it does not carry, in the words of the kernel (witness)', async () => {
    const { linux } = await bench();
    expect(await linux.executeCommand('ip -6 addr del fd00::9/64 dev eth0'))
      .toBe('RTNETLINK answers: Cannot assign requested address');
  });

  it('names a device that does not exist, as the kernel does', async () => {
    const { linux } = await bench();
    expect(await linux.executeCommand('ip -6 addr del fd00::1/64 dev eth9')).toBe('Cannot find device "eth9"');
  });
});
