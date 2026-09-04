/**
 * `Get`/`New`/`Set`/`Enable`/`Disable`/`Remove-NetFirewallRule` — les sept
 * regles integrees etaient une FICTION DE RENDU, et `-Enabled True`
 * DESACTIVAIT la regle.
 *
 * Sources. Les cinq pages de `MicrosoftDocs/windows-powershell-docs`
 * (`NetSecurity/{New,Get,Set,Remove,Enable}-NetFirewallRule.md`). Elles
 * donnent les ensembles de valeurs que rien ne verifiait — `-Action`
 * vaut `NotConfigured|Allow|Block`, `-Direction` `Inbound|Outbound`
 * (defaut Inbound), `-Enabled` `True|False` (defaut True), `-Profile`
 * `Any|Domain|Private|Public|NotApplicable` — et surtout la nature de la
 * cle : « only one rule with a given NAME may exist in a policy store at
 * a time » et « the default value is a randomly assigned value ». Le NOM
 * est donc l'identite et le NOM AFFICHE ne l'est pas. `Get-NetFirewallRule`
 * porte un jeu `ByQuery` (`-Enabled`, `-Direction`, `-Action`,
 * `-Description`, `-Group`) qui n'existait pas ici.
 *
 * Ce que la mesure a trouve. Les sept regles integrees etaient
 * SYNTHETISEES a chaque lecture et ne vivaient nulle part : `Enable-
 * NetFirewallRule -Name RemoteDesktop-In-TCP` repondait « No firewall
 * rule named » sur une machine qui affichait la regle, et le plan de
 * donnees ne les parcourait pas — `BlockTelemetry` etait annoncee active
 * et ne bloquait rien. `-Enabled True` posait `enabled: false`, parce que
 * la valeur documentee est le MOT `True` et que le code comparait a
 * `=== true` : une regle Block creee par la commande la plus normale qui
 * soit ne bloquait rien. Le magasin etait indexe par le NOM AFFICHE, donc
 * deux regles de meme nom affiche se confondaient — mesure, `R1`
 * disparaissait au profit de `R2`. `-Action Zorglub`, `-Direction
 * Zorglub`, `-Protocol Zorglub` et `-LocalPort 99999` etaient tous
 * acceptes et ranges, le second rendant la regle inapplicable en silence.
 * Tous les filtres `ByQuery` etaient ignores. `New-NetFirewallRule`
 * n'emettait rien. `Set-NetFirewallRule` ne savait changer que `enabled`
 * et `action`. `-Profile`, `-RemoteAddress` et `-Program` etaient
 * acceptes et jetes.
 *
 * Discrimine par `git stash` : 31 des 35 cas tombent avant correctif. Les 4
 * autres sont nommes ici plutot que laisses a decouvrir, chacun avec la
 * raison pour laquelle il ne discrimine pas. Les DEUX TEMOINS, dont c'est
 * l'objet de passer des deux cotes — la machine porte bien des regles, et
 * un ping passe quand rien ne le bloque ; sans eux un laboratoire mal bati
 * et une fonction en panne seraient indiscernables. « une regle posee par
 * netsh est visible de PowerShell » passait parce que le chemin netsh
 * ecrivait deja dans le magasin que la lecture PowerShell consultait —
 * c'est son JUMEAU, « netsh voit les MEMES regles que PowerShell », qui
 * tombe, les regles integrees n'existant dans aucun des deux. Et « une
 * regle DESACTIVEE ne bloque rien » passait pour une raison qui ne prouve
 * rien : `-Enabled False` etait la seule des deux valeurs que l'ancien
 * code posait juste, et par accident.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
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

function machine(): { pc: WindowsPC; sh: Shell } {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.powerOn();
  return { pc, sh: PowerShellSubShell.create(pc).subShell };
}

function lab(): { win: WindowsPC; lnx: LinuxPC; sh: Shell } {
  const win = new WindowsPC('windows-pc', 'WIN', 0, 0); win.powerOn();
  const lnx = new LinuxPC('linux-pc', 'LNX', 0, 0); lnx.powerOn();
  new Cable('c').connect(win.getPort('eth0')!, lnx.getPort('eth0')!);
  win.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  lnx.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { win, lnx, sh: PowerShellSubShell.create(win).subShell };
}

describe('Une regle integree est une VRAIE regle', () => {
  it('TEMOIN : le laboratoire est sain — la machine porte des regles integrees', async () => {
    const { sh } = machine();
    const compte = await run(sh, 'Get-NetFirewallRule | Measure-Object | Select -ExpandProperty Count');
    expect(Number(compte)).toBeGreaterThan(0);
    expect(await run(sh, 'Get-NetFirewallRule | Format-Table Name')).toContain('CoreNet-DHCP-In');
  });

  it('Enable-NetFirewallRule active une regle integree', async () => {
    const { sh } = machine();
    expect(await run(sh, '(Get-NetFirewallRule -Name RemoteDesktop-UserMode-In-TCP).Enabled')).toBe('False');
    expect(await run(sh, 'Enable-NetFirewallRule -Name RemoteDesktop-UserMode-In-TCP')).toBe('');
    expect(await run(sh, '(Get-NetFirewallRule -Name RemoteDesktop-UserMode-In-TCP).Enabled')).toBe('True');
  });

  it('Set-NetFirewallRule modifie une regle integree', async () => {
    const { sh } = machine();
    await run(sh, 'Set-NetFirewallRule -Name FPS-ICMP4-ERQ-In -Action Block');
    expect(await run(sh, '(Get-NetFirewallRule -Name FPS-ICMP4-ERQ-In).Action')).toBe('Block');
  });

  it('Remove-NetFirewallRule retire une regle integree', async () => {
    const { sh } = machine();
    await run(sh, 'Remove-NetFirewallRule -Name WINRM-HTTP-In-TCP');
    expect(await run(sh, 'Get-NetFirewallRule -Name WINRM-HTTP-In-TCP'))
      .toContain('No MSFT_NetFirewallRule objects found');
  });

  it('netsh voit les MEMES regles que PowerShell', async () => {
    const { pc, sh } = machine();
    await run(sh, 'New-NetFirewallRule -Name "DepuisPS" -DisplayName "Depuis PowerShell" -Action Block');
    const vue = await pc.executeCommand('netsh advfirewall firewall show rule name=all');
    expect(vue).toContain('CoreNet-DHCP-In');
    expect(vue).toContain('DepuisPS');
  });

  it('une regle posee par netsh est visible de PowerShell', async () => {
    const { pc, sh } = machine();
    await pc.executeCommand(
      'netsh advfirewall firewall add rule name=DepuisNetsh dir=in action=block protocol=TCP localport=445');
    expect(await run(sh, '(Get-NetFirewallRule -Name DepuisNetsh).Action')).toBe('Block');
    expect(await run(sh, '(Get-NetFirewallRule -Name DepuisNetsh).LocalPort')).toBe('445');
  });
});

describe('New-NetFirewallRule — ce qu elle pose et ce qu elle refuse', () => {
  it('-Enabled True ACTIVE la regle, et -Enabled False la desactive', async () => {
    const { sh } = machine();
    await run(sh, 'New-NetFirewallRule -Name "A" -DisplayName "A" -Enabled True -Action Block');
    await run(sh, 'New-NetFirewallRule -Name "B" -DisplayName "B" -Enabled False -Action Block');
    expect(await run(sh, '(Get-NetFirewallRule -Name A).Enabled')).toBe('True');
    expect(await run(sh, '(Get-NetFirewallRule -Name B).Enabled')).toBe('False');
  });

  it('rend la regle creee', async () => {
    const { sh } = machine();
    const out = await run(sh, 'New-NetFirewallRule -Name "R" -DisplayName "Une regle" -Action Block | Format-List Name,DisplayName,Action');
    expect(out).toContain('R');
    expect(out).toContain('Une regle');
    expect(out).toContain('Block');
  });

  it('le NOM est la cle : deux regles de meme nom AFFICHE coexistent', async () => {
    const { sh } = machine();
    await run(sh, 'New-NetFirewallRule -Name "R1" -DisplayName "Meme nom" -Direction Inbound -Action Block');
    await run(sh, 'New-NetFirewallRule -Name "R2" -DisplayName "Meme nom" -Direction Outbound -Action Allow');
    const vue = await run(sh, 'Get-NetFirewallRule -DisplayName "Meme nom" | Format-Table Name,Direction');
    expect(vue).toContain('R1');
    expect(vue).toContain('R2');
  });

  it('le meme NOM deux fois est refuse', async () => {
    const { sh } = machine();
    await run(sh, 'New-NetFirewallRule -Name "R1" -DisplayName "Une" -Action Block');
    expect(await run(sh, 'New-NetFirewallRule -Name "R1" -DisplayName "Autre" -Action Block'))
      .toContain('already exists');
  });

  it('sans -Name la regle en recoit un, distinct a chaque fois', async () => {
    const { sh } = machine();
    await run(sh, 'New-NetFirewallRule -DisplayName "Une" -Action Block');
    await run(sh, 'New-NetFirewallRule -DisplayName "Autre" -Action Block');
    const noms = await run(sh, 'Get-NetFirewallRule -Action Block | Format-Table Name');
    const lignes = noms.split('\n').filter(l => l.includes('{'));
    expect(lignes.length).toBe(2);
    expect(lignes[0]).not.toBe(lignes[1]);
  });

  it('exige -DisplayName', async () => {
    const { sh } = machine();
    expect(await run(sh, 'New-NetFirewallRule -Action Block'))
      .toContain('missing mandatory parameters: DisplayName');
  });

  it('refuse une valeur hors de l ensemble, pour les quatre enumerations', async () => {
    const { sh } = machine();
    expect(await run(sh, 'New-NetFirewallRule -DisplayName "Z" -Action Zorglub'))
      .toContain('does not belong to the set "NotConfigured,Allow,Block"');
    expect(await run(sh, 'New-NetFirewallRule -DisplayName "Z" -Direction Zorglub'))
      .toContain('does not belong to the set "Inbound,Outbound"');
    expect(await run(sh, 'New-NetFirewallRule -DisplayName "Z" -Enabled Zorglub'))
      .toContain('does not belong to the set "True,False"');
    expect(await run(sh, 'New-NetFirewallRule -DisplayName "Z" -Profile Zorglub'))
      .toContain('does not belong to the set "Any,Domain,Private,Public,NotApplicable"');
  });

  it('refuse un protocole, un port et une adresse qui n en sont pas', async () => {
    const { sh } = machine();
    expect(await run(sh, 'New-NetFirewallRule -DisplayName "Z" -Protocol Zorglub'))
      .toContain('is not a valid protocol');
    expect(await run(sh, 'New-NetFirewallRule -DisplayName "Z" -LocalPort 99999'))
      .toContain('is not a valid port');
    expect(await run(sh, 'New-NetFirewallRule -DisplayName "Z" -RemoteAddress 999.999.999.999'))
      .toContain('is not a valid address');
    expect(await run(sh, 'Get-NetFirewallRule -DisplayName "Z"'))
      .toContain('No MSFT_NetFirewallRule objects found');
  });

  it('refuse ce que ce simulateur ne sait pas evaluer plutot que de l ignorer', async () => {
    const { sh } = machine();
    expect(await run(sh, 'New-NetFirewallRule -DisplayName "Z" -Program C:\\app.exe'))
      .toContain('not implemented in this simulator');
    expect(await run(sh, 'New-NetFirewallRule -DisplayName "Z" -Service Spooler'))
      .toContain('not implemented in this simulator');
  });

  it('garde une plage de ports, une liste de ports et un prefixe', async () => {
    const { sh } = machine();
    await run(sh, 'New-NetFirewallRule -Name "P" -DisplayName "Plage" -LocalPort "1000-2000" -RemotePort "80,443" -RemoteAddress 10.0.0.0/8 -Profile Domain');
    const vue = await run(sh, 'Get-NetFirewallRule -Name P | Format-List LocalPort,RemotePort,RemoteAddress,Profile');
    expect(vue).toContain('1000-2000');
    expect(vue).toContain('80,443');
    expect(vue).toContain('10.0.0.0/8');
    expect(vue).toContain('Domain');
  });

  it('-WhatIf ne cree AUCUNE regle', async () => {
    const { sh } = machine();
    expect(await run(sh, 'New-NetFirewallRule -Name "W" -DisplayName "W" -WhatIf')).toContain('What if:');
    expect(await run(sh, 'Get-NetFirewallRule -Name W')).toContain('No MSFT_NetFirewallRule objects found');
  });
});

describe('Get-NetFirewallRule — le jeu ByQuery filtre', () => {
  it('filtre par -Enabled', async () => {
    const { sh } = machine();
    const vue = await run(sh, 'Get-NetFirewallRule -Enabled False | Format-Table Name');
    expect(vue).toContain('RemoteDesktop-UserMode-In-TCP');
    expect(vue).not.toContain('CoreNet-DHCP-In');
  });

  it('filtre par -Direction', async () => {
    const { sh } = machine();
    const vue = await run(sh, 'Get-NetFirewallRule -Direction Outbound | Format-Table Name');
    expect(vue).toContain('CoreNet-DNS-Out');
    expect(vue).not.toContain('CoreNet-DHCP-In');
  });

  it('filtre par -Action et par -Group', async () => {
    const { sh } = machine();
    await run(sh, 'New-NetFirewallRule -Name "B" -DisplayName "B" -Action Block -Group "Mon groupe"');
    expect(await run(sh, 'Get-NetFirewallRule -Action Block | Format-Table Name')).toContain('B');
    expect(await run(sh, 'Get-NetFirewallRule -Action Block | Format-Table Name'))
      .not.toContain('CoreNet-DHCP-In');
    expect(await run(sh, 'Get-NetFirewallRule -Group "Mon groupe" | Format-Table Name')).toContain('B');
  });

  it('-DisplayName ne repond PAS sur le nom', async () => {
    const { sh } = machine();
    await run(sh, 'New-NetFirewallRule -Name "LeNom" -DisplayName "Le nom affiche" -Action Block');
    expect(await run(sh, 'Get-NetFirewallRule -DisplayName "LeNom"'))
      .toContain('No MSFT_NetFirewallRule objects found');
  });

  it('un nom qu aucune regle ne porte est un refus nomme', async () => {
    const { sh } = machine();
    expect(await run(sh, 'Get-NetFirewallRule -Name Zorglub'))
      .toContain("No MSFT_NetFirewallRule objects found with property 'Name' equal to 'Zorglub'");
  });
});

describe('Set-NetFirewallRule — elle change ce que la documentation dit', () => {
  it('pose le port, le protocole, la direction et l adresse', async () => {
    const { sh } = machine();
    await run(sh, 'New-NetFirewallRule -Name "S" -DisplayName "S" -Action Block');
    await run(sh, 'Set-NetFirewallRule -Name S -Protocol UDP -LocalPort 53 -Direction Outbound -RemoteAddress 10.0.0.0/8');
    const vue = await run(sh, 'Get-NetFirewallRule -Name S | Format-List Protocol,LocalPort,Direction,RemoteAddress');
    expect(vue).toContain('UDP');
    expect(vue).toContain('53');
    expect(vue).toContain('Outbound');
    expect(vue).toContain('10.0.0.0/8');
  });

  it('-NewDisplayName renomme sans toucher au nom', async () => {
    const { sh } = machine();
    await run(sh, 'New-NetFirewallRule -Name "S" -DisplayName "Avant" -Action Block');
    await run(sh, 'Set-NetFirewallRule -Name S -NewDisplayName "Apres"');
    expect(await run(sh, '(Get-NetFirewallRule -Name S).DisplayName')).toBe('Apres');
  });

  it('refuse une valeur hors ensemble sans rien changer', async () => {
    const { sh } = machine();
    await run(sh, 'New-NetFirewallRule -Name "S" -DisplayName "S" -Action Block');
    expect(await run(sh, 'Set-NetFirewallRule -Name S -Action Zorglub')).toContain('does not belong to the set');
    expect(await run(sh, '(Get-NetFirewallRule -Name S).Action')).toBe('Block');
  });

  it('-PassThru rend la regle modifiee', async () => {
    const { sh } = machine();
    await run(sh, 'New-NetFirewallRule -Name "S" -DisplayName "S" -Action Block');
    expect(await run(sh, 'Set-NetFirewallRule -Name S -Action Allow -PassThru | Format-Table Action'))
      .toContain('Allow');
  });

  it('un nom qu aucune regle ne porte est un refus, et ne CREE pas la regle', async () => {
    const { sh } = machine();
    expect(await run(sh, 'Set-NetFirewallRule -Name Zorglub -Action Block'))
      .toContain('No MSFT_NetFirewallRule objects found');
    expect(await run(sh, 'Get-NetFirewallRule -Name Zorglub'))
      .toContain('No MSFT_NetFirewallRule objects found');
  });
});

describe('Remove-NetFirewallRule — ce qu elle retire', () => {
  it('retire la regle nommee, et -WhatIf ne retire rien', async () => {
    const { sh } = machine();
    await run(sh, 'New-NetFirewallRule -Name "R" -DisplayName "R" -Action Block');
    expect(await run(sh, 'Remove-NetFirewallRule -Name R -WhatIf')).toContain('What if:');
    expect(await run(sh, '(Get-NetFirewallRule -Name R).Name')).toBe('R');
    expect(await run(sh, 'Remove-NetFirewallRule -Name R')).toBe('');
    expect(await run(sh, 'Get-NetFirewallRule -Name R')).toContain('No MSFT_NetFirewallRule objects found');
  });

  it('accepte le pipeline de Get-NetFirewallRule', async () => {
    const { sh } = machine();
    await run(sh, 'New-NetFirewallRule -Name "R" -DisplayName "R" -Action Block -Group "A jeter"');
    await run(sh, 'Get-NetFirewallRule -Group "A jeter" | Remove-NetFirewallRule');
    expect(await run(sh, 'Get-NetFirewallRule -Name R')).toContain('No MSFT_NetFirewallRule objects found');
  });
});

describe('Une regle Block bloque un VRAI paquet', () => {
  it('TEMOIN : sans regle le ping passe', async () => {
    const { lnx } = lab();
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 0% packet loss');
  });

  it('une regle Block ICMPv4 fait tomber le ping, et son retrait le retablit', async () => {
    const { lnx, sh } = lab();
    await run(sh, 'New-NetFirewallRule -Name "NoEcho" -DisplayName "Pas d echo" -Direction Inbound -Protocol ICMPv4 -Action Block');
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 100% packet loss');
    await run(sh, 'Remove-NetFirewallRule -Name NoEcho');
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 0% packet loss');
  });

  it('Disable puis Enable font passer puis retomber le ping', async () => {
    const { lnx, sh } = lab();
    await run(sh, 'New-NetFirewallRule -Name "NoEcho" -DisplayName "Pas d echo" -Direction Inbound -Protocol ICMPv4 -Action Block');
    await run(sh, 'Disable-NetFirewallRule -Name NoEcho');
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 0% packet loss');
    await run(sh, 'Enable-NetFirewallRule -Name NoEcho');
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 100% packet loss');
  });

  it('-RemoteAddress restreint la regle a la source qu elle nomme', async () => {
    const { lnx, sh } = lab();
    await run(sh, 'New-NetFirewallRule -Name "Ailleurs" -DisplayName "Ailleurs" -Direction Inbound -Protocol ICMPv4 -Action Block -RemoteAddress 192.168.0.0/16');
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 0% packet loss');
    await run(sh, 'Set-NetFirewallRule -Name Ailleurs -RemoteAddress 10.0.0.0/8');
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 100% packet loss');
  });

  it('une regle Block prime une regle Allow qui correspond aussi', async () => {
    const { lnx, sh } = lab();
    await run(sh, 'New-NetFirewallRule -Name "Oui" -DisplayName "Oui" -Direction Inbound -Protocol ICMPv4 -Action Allow');
    await run(sh, 'New-NetFirewallRule -Name "Non" -DisplayName "Non" -Direction Inbound -Protocol ICMPv4 -Action Block');
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 100% packet loss');
  });

  it('une regle DESACTIVEE ne bloque rien', async () => {
    const { lnx, sh } = lab();
    await run(sh, 'New-NetFirewallRule -Name "Off" -DisplayName "Off" -Direction Inbound -Protocol ICMPv4 -Action Block -Enabled False');
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 0% packet loss');
  });
});
