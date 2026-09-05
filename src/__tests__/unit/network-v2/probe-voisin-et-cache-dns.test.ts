/**
 * Un voisin IPv6 n'est pas dans la table ARP, et le cache DNS du client
 * Windows est CELUI du projet.
 *
 * Mesure de depart, sur une machine Windows persistante et cablee, les
 * trois vues d'un meme fait interrogees au meme instant :
 *
 *  - `Get-NetNeighbor` numerote la premiere carte 1 — l'index du BOUCLAGE —
 *    pendant que `Get-NetAdapter` la numerote 2, donc
 *    `Get-NetNeighbor -InterfaceIndex 2` ne rend rien pour la carte dont
 *    l'operateur vient de lire l'index ;
 *  - `netsh interface ipv6 show neighbors` liste les voisins IPv4, sa
 *    fonction lisant la table ARP quelle que soit la famille demandee ;
 *  - `New-NetNeighbor` avec une adresse IPv6 ecrit celle-ci DANS la table
 *    ARP, et `NeighborCache.setStatic` — le seul chemin vers le vrai cache
 *    de voisinage — n'a aucun appelant de production ;
 *  - `Get-NetNeighbor` ne lit que trois de ses huit filtres et ne valide
 *    aucun d'eux, donc `-State Zorglub` rend toute la table ;
 *  - `New-NetNeighbor` sans interface INVENTE `Ethernet` au lieu de refuser
 *    le parametre obligatoire ;
 *  - `Get-DnsClientCache` rend le TTL d'ORIGINE la ou
 *    `ipconfig /displaydns` rend le TTL RESTANT, sur la meme entree ;
 *  - `Get-NetUDPEndpoint -LocalPort 99999` est accepte alors que le champ
 *    fait seize bits.
 *
 * Le cache DNS du client Windows etait une SECONDE ecriture : le projet
 * porte deja `dns/resolver/DnsCache`, avec la mise en cache negative de la
 * RFC 2308 et la decroissance du TTL a la lecture, lu par le resolveur
 * recursif, par systemd-resolved, par BIND9 et par le role SERVEUR DNS de
 * Windows — le client, lui, avait sa propre copie sans l'une ni l'autre.
 *
 * Discrimine par `git stash` : 17 cas sur 30 tombent avant correctif.
 * Les TREIZE qui passent des deux cotes sont nommes ici plutot que
 * laisses a deviner, chacun avec sa raison.
 *
 * Quatre TEMOINS, dont c'est l'objet de passer avant comme apres : le
 * voisin appris par un vrai ping, `arp -a` qui le montre toujours (donc
 * la moitie IPv4 n'a pas bouge), l'entree de cache DNS, et les ecoutes
 * UDP de la machine.
 *
 * Cinq cas passaient parce que le filtre n'etait lu par PERSONNE, donc
 * la vue rendait TOUT et contenait par accident ce que le cas cherche :
 * `-InterfaceIndex` (l'ancien code lisait `ctx.named['ifindex']` quand
 * le parametre s'ecrit `-InterfaceIndex`, donc il ne mordait sur rien),
 * `-InterfaceAlias`, `-IPAddress` en position 0, `-Entry` en position 0,
 * et `netsh interface ipv6 show neighbors`, qui n'avait aucun
 * gestionnaire du tout et tombait donc a travers.
 *
 * Quatre cas etaient DEJA justes et gardent qu'on ne les a pas casses :
 * `-State` filtrait (c'est l'un des trois seuls filtres que l'ancien
 * code lisait), `netsh interface ipv4 show neighbors` listait bien les
 * voisins IPv4, `Set-NetNeighbor` changeait l'adresse de couche lien, et
 * `Clear-DnsClientCache` vidait le meme cache qu'`ipconfig /flushdns`.
 */

import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

async function lab() {
  const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
  pc.powerOn(); srv.powerOn();
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  const interp = pc.getPowerShellInterpreter();
  const ps = (line: string): Promise<string> => Promise.resolve(interp.execute(line)) as Promise<string>;
  const cmd = (line: string): Promise<string> => pc.executeCmdCommand(line);
  return { pc, srv, ps, cmd };
}

async function dnsLab() {
  const l = await lab();
  l.srv.dnsService.start();
  l.srv.dnsService.addRecord({ name: 'example.com', type: 'A', value: '93.184.216.34', ttl: 3600 });
  l.srv.dnsService.addRecord({ name: 'srv.lab', type: 'A', value: '10.0.0.2', ttl: 3600 });
  (l.pc as unknown as { dnsConfig: Map<string, { servers: string[]; mode: string }> })
    .dnsConfig = new Map([['eth0', { servers: ['10.0.0.2'], mode: 'static' }]]);
  return l;
}

async function labWithNeighbor() {
  const l = await lab();
  await l.cmd('ping -n 1 10.0.0.2');
  return l;
}

describe('un voisin IPv6 n est pas dans la table ARP', () => {
  it('TEMOIN : un ping reel apprend le voisin, et Get-NetNeighbor le montre', async () => {
    const { ps } = await labWithNeighbor();
    const out = await ps('(Get-NetNeighbor).IPAddress');
    expect(out).toContain('10.0.0.2');
  });

  it('NON-REGRESSION : arp -a montre toujours le voisin IPv4', async () => {
    const { cmd } = await labWithNeighbor();
    const out = await cmd('arp -a');
    expect(out).toContain('10.0.0.2');
  });

  it('Get-NetNeighbor numerote la carte comme Get-NetAdapter', async () => {
    const { ps } = await labWithNeighbor();
    const adapter = (await ps("(Get-NetAdapter -Name 'Ethernet 0').ifIndex")).trim();
    const neighbor = (await ps("(Get-NetNeighbor -IPAddress 10.0.0.2).InterfaceIndex")).trim();
    expect(adapter).not.toBe('');
    expect(neighbor).toBe(adapter);
  });

  it('-InterfaceIndex de la carte rend ses voisins', async () => {
    const { ps } = await labWithNeighbor();
    const idx = (await ps("(Get-NetAdapter -Name 'Ethernet 0').ifIndex")).trim();
    const out = await ps(`(Get-NetNeighbor -InterfaceIndex ${idx}).IPAddress`);
    expect(out).toContain('10.0.0.2');
  });

  it('un voisin IPv6 permanent se pose et se relit par sa famille', async () => {
    const { ps } = await labWithNeighbor();
    await ps("New-NetNeighbor -IPAddress 2001:db8::2 -InterfaceAlias 'Ethernet 0' -LinkLayerAddress 00-11-22-33-44-55");
    const out = await ps('(Get-NetNeighbor -AddressFamily IPv6).IPAddress');
    expect(out).toContain('2001:db8::2');
  });

  it('un voisin IPv6 n entre PAS dans la table ARP', async () => {
    const { ps, cmd } = await labWithNeighbor();
    await ps("New-NetNeighbor -IPAddress 2001:db8::2 -InterfaceAlias 'Ethernet 0' -LinkLayerAddress 00-11-22-33-44-55");
    const out = await cmd('arp -a');
    expect(out).not.toContain('2001:db8::2');
  });

  it('netsh interface ipv6 show neighbors ne liste pas les voisins IPv4', async () => {
    const { cmd } = await labWithNeighbor();
    const out = await cmd('netsh interface ipv6 show neighbors');
    expect(out).not.toContain('10.0.0.2');
  });

  it('netsh interface ipv4 show neighbors liste bien les voisins IPv4', async () => {
    const { cmd } = await labWithNeighbor();
    const out = await cmd('netsh interface ipv4 show neighbors');
    expect(out).toContain('10.0.0.2');
  });

  it('-AddressFamily IPv4 ne rend pas le voisin IPv6', async () => {
    const { ps } = await labWithNeighbor();
    await ps("New-NetNeighbor -IPAddress 2001:db8::2 -InterfaceAlias 'Ethernet 0' -LinkLayerAddress 00-11-22-33-44-55");
    const out = await ps('(Get-NetNeighbor -AddressFamily IPv4).IPAddress');
    expect(out).toContain('10.0.0.2');
    expect(out).not.toContain('2001:db8::2');
  });

  it('-State refuse une valeur hors de l enumeration documentee', async () => {
    const { ps } = await labWithNeighbor();
    const out = await ps('Get-NetNeighbor -State Zorglub');
    expect(out).toContain("Cannot validate argument on parameter 'State'");
    expect(out).not.toContain('10.0.0.2');
  });

  it('-State filtre pour de bon', async () => {
    const { ps } = await labWithNeighbor();
    await ps("New-NetNeighbor -IPAddress 10.0.0.9 -InterfaceAlias 'Ethernet 0' -LinkLayerAddress 00-11-22-33-44-66");
    const out = await ps('(Get-NetNeighbor -State Permanent).IPAddress');
    expect(out).toContain('10.0.0.9');
    expect(out).not.toContain('10.0.0.2');
  });

  it('-LinkLayerAddress filtre, quelle que soit son orthographe', async () => {
    const { ps } = await labWithNeighbor();
    await ps("New-NetNeighbor -IPAddress 10.0.0.9 -InterfaceAlias 'Ethernet 0' -LinkLayerAddress 00-11-22-33-44-66");
    const dash = await ps('(Get-NetNeighbor -LinkLayerAddress 00-11-22-33-44-66).IPAddress');
    const colon = await ps('(Get-NetNeighbor -LinkLayerAddress 00:11:22:33:44:66).IPAddress');
    expect(dash.trim()).toBe('10.0.0.9');
    expect(colon.trim()).toBe('10.0.0.9');
  });

  it('-InterfaceAlias filtre', async () => {
    const { ps } = await labWithNeighbor();
    const out = await ps("(Get-NetNeighbor -InterfaceAlias 'Ethernet 0').IPAddress");
    expect(out).toContain('10.0.0.2');
  });

  it('une selection qui ne correspond a rien REFUSE au lieu de tout rendre', async () => {
    const { ps } = await labWithNeighbor();
    const out = await ps('Get-NetNeighbor -IPAddress 10.0.0.77');
    expect(out).toContain("No MSFT_NetNeighbor objects found with property 'IPAddress' equal to '10.0.0.77'.");
    expect(out).not.toContain('10.0.0.2');
  });

  it('-IPAddress est en position 0', async () => {
    const { ps } = await labWithNeighbor();
    const out = await ps('(Get-NetNeighbor 10.0.0.2).LinkLayerAddress');
    expect(out.trim()).not.toBe('');
    expect(out).toMatch(/^[0-9A-F]{2}(-[0-9A-F]{2}){5}$/m);
  });

  it('New-NetNeighbor sans interface REFUSE au lieu d inventer Ethernet', async () => {
    const { ps } = await labWithNeighbor();
    const out = await ps('New-NetNeighbor -IPAddress 10.0.0.55 -LinkLayerAddress 00-11-22-33-44-77');
    expect(out).toContain('missing mandatory parameters: InterfaceAlias');
    const after = await ps('Get-NetNeighbor -IPAddress 10.0.0.55');
    expect(after).toContain('No MSFT_NetNeighbor objects found');
  });

  it('New-NetNeighbor -WhatIf ne pose rien', async () => {
    const { ps } = await labWithNeighbor();
    await ps("New-NetNeighbor -IPAddress 10.0.0.56 -InterfaceAlias 'Ethernet 0' -LinkLayerAddress 00-11-22-33-44-88 -WhatIf");
    const after = await ps('Get-NetNeighbor -IPAddress 10.0.0.56');
    expect(after).toContain('No MSFT_NetNeighbor objects found');
  });

  it('Set-NetNeighbor change l adresse de couche lien de l entree designee', async () => {
    const { ps } = await labWithNeighbor();
    await ps("New-NetNeighbor -IPAddress 10.0.0.9 -InterfaceAlias 'Ethernet 0' -LinkLayerAddress 00-11-22-33-44-66");
    await ps('Set-NetNeighbor -IPAddress 10.0.0.9 -LinkLayerAddress 00-11-22-33-44-99');
    const out = await ps('(Get-NetNeighbor -IPAddress 10.0.0.9).LinkLayerAddress');
    expect(out.trim()).toBe('00-11-22-33-44-99');
  });

  it('Remove-NetNeighbor ne retire QUE ce qui correspond', async () => {
    const { ps } = await labWithNeighbor();
    await ps("New-NetNeighbor -IPAddress 10.0.0.9 -InterfaceAlias 'Ethernet 0' -LinkLayerAddress 00-11-22-33-44-66");
    await ps('Remove-NetNeighbor -IPAddress 10.0.0.9');
    const gone = await ps('Get-NetNeighbor -IPAddress 10.0.0.9');
    expect(gone).toContain('No MSFT_NetNeighbor objects found');
    const kept = await ps('(Get-NetNeighbor -IPAddress 10.0.0.2).IPAddress');
    expect(kept.trim()).toBe('10.0.0.2');
  });
});

describe('le cache DNS du client Windows est celui du projet', () => {
  it('TEMOIN : une entree resolue parait dans Get-DnsClientCache', async () => {
    const { ps } = await dnsLab();
    await ps('Resolve-DnsName example.com');
    const out = await ps('(Get-DnsClientCache).Entry');
    expect(out).toContain('example.com');
  });

  it('le TTL rendu est le TTL RESTANT, comme ipconfig /displaydns', async () => {
    vi.useFakeTimers();
    try {
      const { ps, cmd } = await dnsLab();
      await ps('Resolve-DnsName example.com');
      const before = Number((await ps('(Get-DnsClientCache -Entry example.com).TimeToLive')).trim());
      vi.advanceTimersByTime(30_000);
      const after = Number((await ps('(Get-DnsClientCache -Entry example.com).TimeToLive')).trim());
      const shown = await cmd('ipconfig /displaydns');
      expect(before).toBeGreaterThan(0);
      expect(after).toBeLessThan(before);
      expect(shown).toContain(`Time To Live  . . . . : ${after}`);
    } finally { vi.useRealTimers(); }
  });

  it('Status et Section sont LUS sur l entree, pas ecrits en dur', async () => {
    const { ps } = await dnsLab();
    await ps('Resolve-DnsName example.com');
    const ok = await ps('(Get-DnsClientCache -Status Success).Entry');
    expect(ok).toContain('example.com');
    const none = await ps('Get-DnsClientCache -Status NotExist');
    expect(none).toContain('No MSFT_DNSClientCache objects found');
  });

  it('-Type refuse une valeur hors de l enumeration documentee', async () => {
    const { ps } = await dnsLab();
    await ps('Resolve-DnsName example.com');
    const out = await ps('Get-DnsClientCache -Type Zorglub');
    expect(out).toContain("Cannot validate argument on parameter 'Type'");
    expect(out).not.toContain('example.com');
  });

  it('-Entry est en position 0 et filtre', async () => {
    const { ps } = await dnsLab();
    await ps('Resolve-DnsName example.com');
    await ps('Resolve-DnsName srv.lab');
    const out = await ps('(Get-DnsClientCache example.com).Entry');
    expect(out).toContain('example.com');
    expect(out).not.toContain('srv.lab');
  });

  it('Clear-DnsClientCache et ipconfig /flushdns vident le MEME cache', async () => {
    const { ps, cmd } = await dnsLab();
    await ps('Resolve-DnsName example.com');
    await ps('Clear-DnsClientCache');
    const shown = await cmd('ipconfig /displaydns');
    expect(shown).toContain('(no entries)');
  });

  it('la longueur de donnee d un enregistrement A est 4, pas la longueur du texte', async () => {
    const { ps } = await dnsLab();
    await ps('Resolve-DnsName example.com');
    const out = await ps('(Get-DnsClientCache -Entry example.com).DataLength');
    expect(out.trim()).toBe('4');
  });
});

describe('Get-NetUDPEndpoint juge ses parametres', () => {
  it('TEMOIN : la machine a de vraies ecoutes UDP', async () => {
    const { ps } = await lab();
    const out = await ps('(Get-NetUDPEndpoint).LocalPort');
    expect(out.trim()).not.toBe('');
  });

  it('-LocalPort hors de seize bits est REFUSE', async () => {
    const { ps } = await lab();
    const out = await ps('Get-NetUDPEndpoint -LocalPort 99999');
    expect(out).toContain('System.UInt16');
  });

  it('-LocalAddress filtre', async () => {
    const { ps } = await lab();
    const all = (await ps('(Get-NetUDPEndpoint).LocalAddress')).trim();
    expect(all).not.toBe('');
    const out = await ps('Get-NetUDPEndpoint -LocalAddress 203.0.113.9');
    expect(out).toContain('No MSFT_NetUDPEndpoint objects found');
  });
});

describe('le moteur historique de configuration reseau a disparu', () => {
  it('PSNetConfigCmdlets.ts n existe plus', () => {
    expect(existsSync('src/network/devices/windows/PSNetConfigCmdlets.ts')).toBe(false);
  });
});
