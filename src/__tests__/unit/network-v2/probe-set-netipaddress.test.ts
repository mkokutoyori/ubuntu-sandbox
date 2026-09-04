/**
 * `Set-NetIPAddress` — elle ne changeait RIEN, et annoncait la reussite.
 *
 * Sources. La page de la commande
 * (`MicrosoftDocs/windows-powershell-docs`, `NetTCPIP/Set-NetIPAddress.md`)
 * separe nettement deux roles que le MEME nom de parametre porte ailleurs :
 * dans le jeu `Query` les parametres sont des FILTRES au pluriel
 * (`-IPAddress <String[]>`, `-InterfaceAlias <String[]>`, `-AddressFamily`,
 * `-Type`, `-PrefixOrigin`, `-SuffixOrigin`, `-AddressState`,
 * `-InterfaceIndex`, `-PolicyStore`), tandis que `-PrefixLength <Byte>`,
 * `-ValidLifetime <TimeSpan>`, `-PreferredLifetime <TimeSpan>` et
 * `-SkipAsSource <Boolean>` sont au SINGULIER et appartiennent a tous les
 * jeux : ce sont les VALEURS a poser. `-PrefixLength` est donc un filtre
 * dans `Get`/`Remove` et une valeur ici. La DESCRIPTION precise aussi que
 * la commande « modifies IP address configuration properties of an
 * EXISTING IP address » — elle ne change pas l'adresse elle-meme.
 *
 * Le moteur HISTORIQUE portait une SECONDE implantation
 * (`PSNetCmdlets.handleSetNetIPAddress`), qui, elle, REMPLACAIT l'adresse ;
 * elle est supprimee, et un cas de STRUCTURE l'epingle.
 *
 * Discrimine par `git stash` : 12 cas tombent avant correctif — la commande
 * ne faisait RIEN. Le 13e est le TEMOIN, et il a ete ajoute APRES une
 * premiere discrimination ou les douze tombaient : une sonde faite
 * uniquement d'echecs ne distingue pas une commande en panne d'un
 * laboratoire mal bati, et c'est ce temoin qui prouve que les adresses
 * sont bien la avant qu'on demande de les modifier.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resetCounters, MACAddress } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

type Shell = ReturnType<typeof PowerShellSubShell.create>['subShell'];
const run = async (sh: Shell, line: string) => (await sh.processLine(line)).output.join('\n').trim();

async function machine(): Promise<{ pc: WindowsPC; sh: Shell }> {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.powerOn();
  const sh = PowerShellSubShell.create(pc).subShell;
  await run(sh, 'New-NetIPAddress -IPAddress 10.1.1.1 -InterfaceAlias "Ethernet 0" -PrefixLength 24');
  await run(sh, 'New-NetIPAddress -IPAddress 10.2.2.2 -InterfaceAlias "Ethernet 1" -PrefixLength 25');
  return { pc, sh };
}

const view = async (sh: Shell) => run(sh, 'Get-NetIPAddress | Format-Table IPAddress,PrefixLength,SkipAsSource');

describe('Set-NetIPAddress — elle change vraiment', () => {
  it('TEMOIN : le laboratoire est sain — les deux adresses sont posees avant tout Set', async () => {
    const { pc, sh } = await machine();
    const out = await view(sh);
    expect(out).toMatch(/10\.1\.1\.1\s+24/);
    expect(out).toMatch(/10\.2\.2\.2\s+25/);
    expect(String(pc.getPort('eth0')!.getSubnetMask())).toBe('255.255.255.0');
  });

  it('le prefixe change, et le MASQUE du vrai port avec lui', async () => {
    const { pc, sh } = await machine();
    expect(String(pc.getPort('eth0')!.getSubnetMask())).toBe('255.255.255.0');
    expect(await run(sh, 'Set-NetIPAddress -IPAddress 10.1.1.1 -PrefixLength 16')).toBe('');
    expect(await view(sh)).toMatch(/10\.1\.1\.1\s+16/);
    expect(String(pc.getPort('eth0')!.getSubnetMask())).toBe('255.255.0.0');
  });

  it('-SkipAsSource change, et Get-NetIPAddress le relit', async () => {
    const { sh } = await machine();
    await run(sh, 'Set-NetIPAddress -IPAddress 10.2.2.2 -SkipAsSource $true');
    expect(await view(sh)).toMatch(/10\.2\.2\.2\s+25\s+True/);
  });

  it('-ValidLifetime et -PreferredLifetime sont retenues', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Set-NetIPAddress -IPAddress 10.1.1.1 -ValidLifetime (New-TimeSpan -Hours 1) -PreferredLifetime (New-TimeSpan -Minutes 30)')).toBe('');
    const out = await run(sh, 'Get-NetIPAddress -IPAddress 10.1.1.1 | Format-List ValidLifetime,PreferredLifetime');
    expect(out).toContain('01:00:00');
    expect(out).toContain('00:30:00');
  });
});

describe('Set-NetIPAddress — les filtres choisissent la cible', () => {
  it('selectionne par interface', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Set-NetIPAddress -InterfaceAlias "Ethernet 1" -PrefixLength 30')).toBe('');
    const out = await view(sh);
    expect(out).toMatch(/10\.2\.2\.2\s+30/);
    expect(out).toMatch(/10\.1\.1\.1\s+24/);
  });

  it('combine plusieurs filtres', async () => {
    const { sh } = await machine();
    await run(sh, 'Set-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Ethernet 0" -PrefixLength 8');
    const out = await view(sh);
    expect(out).toMatch(/10\.1\.1\.1\s+8/);
    expect(out).toMatch(/10\.2\.2\.2\s+25/);
  });

  it('accepte -IPAddress en position 0', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Set-NetIPAddress 10.1.1.1 -PrefixLength 12')).toBe('');
    expect(await view(sh)).toMatch(/10\.1\.1\.1\s+12/);
  });

  it('recoit sa cible par le tuyau, par nom de propriete', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Get-NetIPAddress -IPAddress 10.2.2.2 | Set-NetIPAddress -PrefixLength 28')).toBe('');
    expect(await view(sh)).toMatch(/10\.2\.2\.2\s+28/);
  });
});

describe('Set-NetIPAddress — ce qu elle refuse et ce qu elle rend', () => {
  it('une adresse inconnue est refusee dans les mots de Windows', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Set-NetIPAddress -IPAddress 10.9.9.9 -PrefixLength 24'))
      .toContain("No MSFT_NetIPAddress objects found with property 'IPAddress' equal to '10.9.9.9'.");
  });

  it('un prefixe hors de la plage de la famille est refuse, et rien n est pose', async () => {
    const { pc, sh } = await machine();
    expect(await run(sh, 'Set-NetIPAddress -IPAddress 10.1.1.1 -PrefixLength 33'))
      .toContain('The prefix length 33 is not valid for an IPv4 address.');
    expect(await view(sh)).toMatch(/10\.1\.1\.1\s+24/);
    expect(String(pc.getPort('eth0')!.getSubnetMask())).toBe('255.255.255.0');
  });

  it('-WhatIf nomme sa cible et ne change rien', async () => {
    const { pc, sh } = await machine();
    expect(await run(sh, 'Set-NetIPAddress -IPAddress 10.1.1.1 -PrefixLength 20 -WhatIf'))
      .toContain('What if: Performing the operation "Set-NetIPAddress" on target "IPAddress: 10.1.1.1, InterfaceAlias: Ethernet 0".');
    expect(await view(sh)).toMatch(/10\.1\.1\.1\s+24/);
    expect(String(pc.getPort('eth0')!.getSubnetMask())).toBe('255.255.255.0');
  });

  it('la boucle locale est protegee, et un refus par objet n interrompt pas le lot', async () => {
    const { sh } = await machine();
    const out = await run(sh, 'Set-NetIPAddress -PrefixLength 22');
    expect(out).toContain('Cannot modify loopback address.');
    const vue = await view(sh);
    expect(vue).toMatch(/127\.0\.0\.1\s+8/);
    expect(vue).toMatch(/10\.1\.1\.1\s+22/);
    expect(vue).toMatch(/10\.2\.2\.2\s+22/);
  });

  it('-PassThru rend l objet MODIFIE, et sans lui la commande est muette', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Set-NetIPAddress -IPAddress 10.1.1.1 -PrefixLength 22')).toBe('');
    const out = await run(sh, 'Set-NetIPAddress -IPAddress 10.1.1.1 -PrefixLength 20 -PassThru');
    expect(out).toContain('10.1.1.1');
    expect(out).toMatch(/\b20\b/);
  });
});

describe('Set-NetIPAddress — une seule source de verite', () => {
  it('le moteur historique ne porte plus de Set-NetIPAddress a lui', () => {
    expect(existsSync('src/network/devices/windows/PSNetCmdlets.ts')).toBe(false);
    expect(readFileSync('src/network/devices/windows/PowerShellExecutor.ts', 'utf8'))
      .not.toContain('handleSetNetIPAddress');
  });
});
