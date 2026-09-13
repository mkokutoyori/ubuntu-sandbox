/**
 * Le PROFIL du pare-feu Windows — `Get`/`Set-NetFirewallProfile`,
 * `netsh advfirewall set`, et le profil qu'une regle porte.
 *
 * Sources. `MicrosoftDocs/windows-powershell-docs`
 * (`NetSecurity/{Get,Set}-NetFirewallProfile.md`) donne les valeurs
 * acceptees et surtout les DEFAUTS « when managing a computer » :
 * `Enabled` True, `DefaultInboundAction` Block, `DefaultOutboundAction`
 * Allow, `AllowInboundRules` True, `AllowLocalFirewallRules` True,
 * `AllowLocalIPsecRules` True, `AllowUnicastResponseToMulticast` True,
 * `NotifyOnListen` True, `LogAllowed`/`LogBlocked`/`LogIgnored` False,
 * `LogFileName` `%windir%\system32\logfiles\firewall\pfirewall.log`,
 * `LogMaxSizeKilobytes` 4096 (plage 1..32767). Elle donne aussi le sens
 * de `AllowInboundRules False` : « All inbound firewall rules are
 * ignored », soit le mode Shields-Up quand l'action par defaut est
 * Block. `MicrosoftDocs/windowsserverdocs`
 * (`windows-commands/netsh-advfirewall.md`) donne la grammaire cmd :
 * `set [allprofiles|currentprofile|domainprofile|privateprofile|
 * publicprofile] state|firewallpolicy|settings|logging`, et la valeur
 * `blockinboundalways` — « Blocks all inbound connections even if the
 * connection matches a rule ».
 *
 * Ce que la mesure a trouve. Il n'y avait PAS de profil : `firewallFactsFor`
 * posait `profile: 'Any'` en dur, donc une regle que l'operateur avait
 * portee sur `-Profile Public` ne s'appliquait sur AUCUN paquet — le
 * `rule.profile !== ANY && rule.profile !== packet.profile` la rejetait
 * toujours. Une regle Block ainsi portee ne bloquait rien, en silence.
 * `Get-NetFirewallProfile` et `Set-NetFirewallProfile` n'existaient pas,
 * et `netsh advfirewall set` rendait `Ok.` en avalant tout. La categorie
 * reseau, enfin, valait `DomainAuthenticated` par defaut sur une machine
 * qui n'a jamais joint de domaine.
 *
 * Ce lot ne pretend PAS a l'action entrante par defaut de Windows :
 * la valeur est evaluee, et `Set-NetFirewallProfile -DefaultInboundAction
 * Block` bloque pour de vrai, mais le simulateur LIVRE `Allow`, parce que
 * le jeu de regles integrees que Windows livre avec son Block — celui qui
 * rend le Block vivable — n'est pas atteste depuis ce reseau.
 *
 * Discrimine par `git stash` : 21 des 24 cas tombent avant correctif. Les
 * TROIS autres sont nommes ici plutot que laisses a decouvrir. Le TEMOIN,
 * « sans regle le ping passe », dont c'est l'objet de passer des deux cotes :
 * sans lui, un laboratoire mal cable et un pare-feu qui jette tout seraient
 * indiscernables. Le cas STRUCTUREL, « la meme regle portee sur Domain ne
 * bloque pas cette machine », passe pour DEUX raisons opposees — avant, parce
 * qu'aucune regle portant un profil ne s'appliquait jamais ; apres, parce que
 * la machine est sur Public et que Domain n'est pas Public. C'est son jumeau,
 * la meme regle portee sur Public, qui tranche. Et la NON-REGRESSION,
 * « le sortant reste autorise par defaut », qui verifie que le lot n'a pas
 * ferme la porte de sortie en ouvrant celle d'entree.
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

const field = async (sh: Shell, profile: string, name: string) =>
  run(sh, `(Get-NetFirewallProfile -Name ${profile}).${name}`);

describe('Le pare-feu Windows a TROIS profils, et ils portent les valeurs de Microsoft', () => {
  it('TEMOIN : les trois profils sont nommes Domain, Private et Public', async () => {
    const { sh } = machine();
    const vue = await run(sh, 'Get-NetFirewallProfile | Format-Table Name');
    expect(vue).toContain('Domain');
    expect(vue).toContain('Private');
    expect(vue).toContain('Public');
  });

  it('les defauts documentes sont ceux de la machine', async () => {
    const { sh } = machine();
    for (const profile of ['Domain', 'Private', 'Public']) {
      expect(await field(sh, profile, 'Enabled')).toBe('True');
      expect(await field(sh, profile, 'DefaultOutboundAction')).toBe('Allow');
      expect(await field(sh, profile, 'AllowInboundRules')).toBe('True');
      expect(await field(sh, profile, 'AllowLocalFirewallRules')).toBe('True');
      expect(await field(sh, profile, 'AllowLocalIPsecRules')).toBe('True');
      expect(await field(sh, profile, 'AllowUnicastResponseToMulticast')).toBe('True');
      expect(await field(sh, profile, 'NotifyOnListen')).toBe('True');
      expect(await field(sh, profile, 'LogAllowed')).toBe('False');
      expect(await field(sh, profile, 'LogBlocked')).toBe('False');
      expect(await field(sh, profile, 'LogIgnored')).toBe('False');
    }
  });

  it('le journal porte le chemin et la taille documentes', async () => {
    const { sh } = machine();
    expect(await field(sh, 'Domain', 'LogFileName'))
      .toBe('%windir%\\system32\\logfiles\\firewall\\pfirewall.log');
    expect(await field(sh, 'Domain', 'LogMaxSizeKilobytes')).toBe('4096');
  });

  it('un nom de profil inconnu est REFUSE dans les mots de CIM', async () => {
    const { sh } = machine();
    expect(await run(sh, 'Get-NetFirewallProfile -Name Zorglub'))
      .toContain('No MSFT_NetFirewallProfile objects found');
  });
});

describe('Set-NetFirewallProfile ecrit ce que Get relit', () => {
  it('`-Enabled False` eteint le profil nomme, et lui seul', async () => {
    const { sh } = machine();
    await run(sh, 'Set-NetFirewallProfile -Name Public -Enabled False');
    expect(await field(sh, 'Public', 'Enabled')).toBe('False');
    expect(await field(sh, 'Domain', 'Enabled')).toBe('True');
  });

  it('`-DefaultInboundAction Block` est retenu', async () => {
    const { sh } = machine();
    await run(sh, 'Set-NetFirewallProfile -Name Domain -DefaultInboundAction Block');
    expect(await field(sh, 'Domain', 'DefaultInboundAction')).toBe('Block');
  });

  it('une valeur hors de l ensemble documente est REFUSEE', async () => {
    const { sh } = machine();
    expect(await run(sh, 'Set-NetFirewallProfile -Name Domain -Enabled Zorglub'))
      .toContain('does not belong to the set');
    expect(await run(sh, 'Set-NetFirewallProfile -Name Domain -DefaultInboundAction Zorglub'))
      .toContain('does not belong to the set');
    expect(await field(sh, 'Domain', 'Enabled')).toBe('True');
  });

  it('la taille du journal tient la plage 1..32767', async () => {
    const { sh } = machine();
    expect(await run(sh, 'Set-NetFirewallProfile -Name Domain -LogMaxSizeKilobytes 40000'))
      .toContain('outside the range');
    await run(sh, 'Set-NetFirewallProfile -Name Domain -LogMaxSizeKilobytes 8192');
    expect(await field(sh, 'Domain', 'LogMaxSizeKilobytes')).toBe('8192');
  });

  it('un reglage que rien n applique est REFUSE en nommant la brique absente', async () => {
    const { sh } = machine();
    const out = await run(sh, 'Set-NetFirewallProfile -Name Domain -AllowUserApps False');
    expect(out).toContain('AllowUserApps');
    expect(out).toContain('not implemented by this simulator');
  });
});

describe('netsh et PowerShell regardent le MEME magasin', () => {
  it('`netsh advfirewall set allprofiles state off` eteint les trois', async () => {
    const { pc, sh } = machine();
    expect(await pc.executeCommand('netsh advfirewall set allprofiles state off')).toContain('Ok.');
    for (const profile of ['Domain', 'Private', 'Public']) {
      expect(await field(sh, profile, 'Enabled')).toBe('False');
    }
  });

  it('`firewallpolicy blockinbound,allowoutbound` ne touche que le profil vise', async () => {
    const { pc, sh } = machine();
    await pc.executeCommand('netsh advfirewall set domainprofile firewallpolicy blockinbound,allowoutbound');
    expect(await field(sh, 'Domain', 'DefaultInboundAction')).toBe('Block');
    expect(await field(sh, 'Domain', 'DefaultOutboundAction')).toBe('Allow');
    expect(await field(sh, 'Public', 'DefaultInboundAction')).toBe('Allow');
  });

  it('`settings unicastresponsetomulticast disable` se relit depuis PowerShell', async () => {
    const { pc, sh } = machine();
    await pc.executeCommand('netsh advfirewall set allprofiles settings unicastresponsetomulticast disable');
    expect(await field(sh, 'Public', 'AllowUnicastResponseToMulticast')).toBe('False');
  });

  it('`settings remotemanagement` est REFUSE en nommant la brique absente', async () => {
    const { pc } = machine();
    expect(await pc.executeCommand('netsh advfirewall set allprofiles settings remotemanagement enable'))
      .toContain('not implemented by this simulator');
  });

  it('`netsh advfirewall reset` remet les profils a leurs defauts', async () => {
    const { pc, sh } = machine();
    await pc.executeCommand('netsh advfirewall set allprofiles state off');
    await pc.executeCommand('netsh advfirewall reset');
    expect(await field(sh, 'Public', 'Enabled')).toBe('True');
  });

  it('une ecriture PowerShell se relit depuis le profil actif de netsh', async () => {
    const { pc, sh } = machine();
    await run(sh, 'Set-NetFirewallProfile -Name Public -DefaultInboundAction Block');
    await pc.executeCommand('netsh advfirewall set currentprofile state off');
    expect(await field(sh, 'Public', 'Enabled')).toBe('False');
    expect(await field(sh, 'Public', 'DefaultInboundAction')).toBe('Block');
  });
});

describe('Le profil TRANCHE, sur le fil', () => {
  it('TEMOIN : sans regle le ping passe', async () => {
    const { lnx } = lab();
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 0% packet loss');
  });

  it('une machine hors domaine est sur le profil Public, pas Domain', async () => {
    const { sh } = lab();
    expect(await run(sh, '(Get-NetConnectionProfile).NetworkCategory')).toContain('Public');
  });

  it('une regle Block portee sur Public BLOQUE sur une machine hors domaine', async () => {
    const { lnx, sh } = lab();
    await run(sh, 'New-NetFirewallRule -DisplayName "NoPing" -Direction Inbound'
      + ' -Action Block -Protocol ICMPv4 -Profile Public');
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 100% packet loss');
  });

  it('STRUCTUREL : la meme regle portee sur Domain ne bloque pas cette machine', async () => {
    const { lnx, sh } = lab();
    await run(sh, 'New-NetFirewallRule -DisplayName "NoPing" -Direction Inbound'
      + ' -Action Block -Protocol ICMPv4 -Profile Domain');
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 0% packet loss');
  });

  it('changer la categorie de la connexion change le profil qui tranche', async () => {
    const { lnx, sh } = lab();
    await run(sh, 'New-NetFirewallRule -DisplayName "NoPingPrivate" -Direction Inbound'
      + ' -Action Block -Protocol ICMPv4 -Profile Private');
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 0% packet loss');
    await run(sh, 'Set-NetConnectionProfile -InterfaceAlias "Ethernet 0"'
      + ' -NetworkCategory Private -Confirm:$false');
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 100% packet loss');
  });

  it('un profil ETEINT ne filtre plus rien, meme avec une regle Block', async () => {
    const { lnx, sh } = lab();
    await run(sh, 'New-NetFirewallRule -DisplayName "NoPing" -Direction Inbound'
      + ' -Action Block -Protocol ICMPv4 -Profile Any');
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 100% packet loss');
    await run(sh, 'Set-NetFirewallProfile -Name Public -Enabled False');
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 0% packet loss');
  });

  it('`-DefaultInboundAction Block` jette ce qu aucune regle n autorise', async () => {
    const { lnx, sh } = lab();
    await run(sh, 'Disable-NetFirewallRule -Name FPS-ICMP4-ERQ-In');
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 0% packet loss');
    await run(sh, 'Set-NetFirewallProfile -Name Public -DefaultInboundAction Block');
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 100% packet loss');
  });

  it('`blockinboundalways` IGNORE meme les regles qui autorisent', async () => {
    const { win, lnx } = lab();
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 0% packet loss');
    await win.executeCommand('netsh advfirewall set allprofiles firewallpolicy blockinboundalways,allowoutbound');
    expect(await lnx.executeCommand('ping -c 1 10.0.0.1')).toContain(', 100% packet loss');
  });

  it('NON-REGRESSION : le sortant reste autorise par defaut', async () => {
    const { win } = lab();
    expect(await win.executeCommand('ping -n 1 10.0.0.2')).toContain('Reply from 10.0.0.2');
  });
});
