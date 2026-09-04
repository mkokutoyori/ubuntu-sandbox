/**
 * `Remove-NetIPAddress` — une commande de REQUETE : tous ses parametres
 * sont des filtres, et elle retire ce qu'ils selectionnent.
 *
 * Sources. La syntaxe, le fait qu'`-IPAddress` ne soit PAS obligatoire et
 * la phrase « If you do not specify an IPv4 or IPv6 address, the cmdlet
 * will remove all IP addresses that match » viennent de la page de la
 * commande (`MicrosoftDocs/windows-powershell-docs`,
 * `NetTCPIP/Remove-NetIPAddress.md`), qui declare aussi la position 0
 * d'`-IPAddress`, l'entree par tuyau par NOM DE PROPRIETE, `-PassThru`,
 * et `-Confirm` a False par defaut — contrairement a
 * `Remove-ADGroupMember`, qui demande confirmation.
 *
 * Le moteur HISTORIQUE portait une SECONDE implantation
 * (`PSNetCmdlets.handleRemoveNetIPAddress`) ; elle est supprimee, et un
 * cas de STRUCTURE l'epingle.
 *
 * Discrimine par `git stash` : 10 cas tombent avant correctif. Les 4
 * autres sont nommes ici plutot que laisses a decouvrir :
 *   - « le retrait par adresse » est le TEMOIN — la commande retirait deja
 *     par `-IPAddress`, et sans lui une implantation qui refuserait TOUT
 *     passerait une sonde faite seulement de refus ;
 *   - « la boucle locale est protegee » etait deja juste, `removeIPAddress`
 *     la gardant depuis un lot anterieur ;
 *   - « l'adresse quitte aussi le port » passait deja, et il est ici parce
 *     que c'est la propriete que la suppression du DOUBLON ne devait pas
 *     casser ;
 *   - « -IPAddress en position 0 » passait deja, l'ancienne applet lisant
 *     `positional[0]` — elle ne lisait QUE cela.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
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
  await run(sh, 'New-NetIPAddress -IPAddress 2001:db8::5 -InterfaceAlias "Ethernet 0" -PrefixLength 64');
  await run(sh, '$ConfirmPreference = "None"');
  return { pc, sh };
}

const table = async (sh: Shell) => run(sh, 'Get-NetIPAddress | Format-Table IPAddress');

describe('Remove-NetIPAddress — elle DEMANDE confirmation', () => {
  it('sans reponse elle ne retire rien, et -Confirm:$false passe outre', async () => {
    const { sh } = await machine();
    await run(sh, '$ConfirmPreference = "High"');
    expect(await run(sh, 'Remove-NetIPAddress -IPAddress 10.1.1.1')).toContain('NonInteractive');
    expect(await table(sh)).toContain('10.1.1.1');
    expect(await run(sh, 'Remove-NetIPAddress -IPAddress 10.1.1.1 -Confirm:$false')).toBe('');
    expect(await table(sh)).not.toContain('10.1.1.1');
  });
});

describe('Remove-NetIPAddress — chaque parametre est un filtre', () => {
  it('TEMOIN : retire par adresse', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Remove-NetIPAddress -IPAddress 10.1.1.1')).toBe('');
    expect(await table(sh)).not.toContain('10.1.1.1');
    expect(await table(sh)).toContain('10.2.2.2');
  });

  it('TEMOIN : l adresse quitte aussi le vrai port', async () => {
    const { pc, sh } = await machine();
    expect(pc.getPort('eth0')!.getIPAddress()?.toString()).toBe('10.1.1.1');
    await run(sh, 'Remove-NetIPAddress -IPAddress 10.1.1.1');
    expect(pc.getPort('eth0')!.getIPAddress()).toBeNull();
  });

  it('retire par interface', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Remove-NetIPAddress -InterfaceAlias "Ethernet 1"')).toBe('');
    expect(await table(sh)).not.toContain('10.2.2.2');
    expect(await table(sh)).toContain('10.1.1.1');
  });

  it('retire par longueur de prefixe', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Remove-NetIPAddress -PrefixLength 25')).toBe('');
    expect(await table(sh)).not.toContain('10.2.2.2');
    expect(await table(sh)).toContain('10.1.1.1');
  });

  it('retire par famille, et n en retire QUE ce que le filtre nomme', async () => {
    const { sh } = await machine();
    await run(sh, 'Remove-NetIPAddress -AddressFamily IPv6 -InterfaceAlias "Ethernet 0"');
    const out = await table(sh);
    expect(out).not.toContain('2001:db8::5');
    expect(out).toContain('10.1.1.1');
    expect(out).toContain('10.2.2.2');
  });

  it('accepte -IPAddress en position 0', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Remove-NetIPAddress 10.1.1.1')).toBe('');
    expect(await table(sh)).not.toContain('10.1.1.1');
  });

  it('recoit l adresse par le tuyau, par nom de propriete', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Get-NetIPAddress -IPAddress 10.2.2.2 | Remove-NetIPAddress')).toBe('');
    expect(await table(sh)).not.toContain('10.2.2.2');
    expect(await table(sh)).toContain('10.1.1.1');
  });
});

describe('Remove-NetIPAddress — ce qu elle refuse et ce qu elle rend', () => {
  it('une adresse qui n existe pas est refusee dans les mots de Windows', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Remove-NetIPAddress -IPAddress 10.9.9.9'))
      .toContain("No MSFT_NetIPAddress objects found with property 'IPAddress' equal to '10.9.9.9'.");
    expect(await table(sh)).toContain('10.1.1.1');
  });

  it('TEMOIN : la boucle locale est protegee', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Remove-NetIPAddress -IPAddress 127.0.0.1')).toContain('loopback');
    expect(await table(sh)).toContain('127.0.0.1');
  });

  it('un refus par objet n interrompt PAS le lot', async () => {
    const { sh } = await machine();
    const out = await run(sh, 'Remove-NetIPAddress -AddressFamily IPv6');
    expect(out).toContain('loopback');
    const rendu = await table(sh);
    expect(rendu).toContain('::1');
    expect(rendu).not.toContain('2001:db8::5');
  });

  it('-WhatIf nomme sa cible et ne retire rien', async () => {
    const { pc, sh } = await machine();
    expect(await run(sh, 'Remove-NetIPAddress -IPAddress 10.1.1.1 -WhatIf'))
      .toContain('What if: Performing the operation "Remove-NetIPAddress" on target "IPAddress: 10.1.1.1, InterfaceAlias: Ethernet 0".');
    expect(await table(sh)).toContain('10.1.1.1');
    expect(pc.getPort('eth0')!.getIPAddress()?.toString()).toBe('10.1.1.1');
  });

  it('-PassThru rend l objet retire, et sans lui la commande est muette', async () => {
    const { sh } = await machine();
    expect(await run(sh, 'Remove-NetIPAddress -IPAddress 10.2.2.2')).toBe('');
    expect(await run(sh, 'Remove-NetIPAddress -IPAddress 10.1.1.1 -PassThru')).toContain('10.1.1.1');
  });
});

describe('Remove-NetIPAddress — une seule source de verite', () => {
  it('le moteur historique ne porte plus de Remove-NetIPAddress a lui', () => {
    expect(readFileSync('src/network/devices/windows/PSNetCmdlets.ts', 'utf8'))
      .not.toContain('handleRemoveNetIPAddress');
    expect(readFileSync('src/network/devices/windows/PowerShellExecutor.ts', 'utf8'))
      .not.toContain('handleRemoveNetIPAddress');
  });

  it('Get et Remove selectionnent par la MEME regle', async () => {
    const { sh } = await machine();
    const vus = await run(sh, 'Get-NetIPAddress -InterfaceAlias "Ethernet 0" -AddressFamily IPv4 | Format-Table IPAddress');
    expect(vus).toContain('10.1.1.1');
    expect(vus).not.toContain('10.2.2.2');
    await run(sh, 'Remove-NetIPAddress -InterfaceAlias "Ethernet 0" -AddressFamily IPv4');
    const reste = await table(sh);
    expect(reste).not.toContain('10.1.1.1');
    expect(reste).toContain('10.2.2.2');
    expect(reste).toContain('2001:db8::5');
  });
});
