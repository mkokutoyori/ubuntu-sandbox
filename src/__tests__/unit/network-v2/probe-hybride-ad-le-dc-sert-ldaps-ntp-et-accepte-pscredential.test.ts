/*
 * Sonde — un controleur de domaine Windows sert ce qu'un controleur sert,
 * a travers un pare-feu, et les cmdlets de domaine acceptent un vrai
 * PSCredential.
 *
 * Mesure sur le laboratoire de la batterie 07 (poste Windows -- FortiGate
 * -- controleur de domaine), reduit a trois machines :
 *   - le DC n'ecoutait ni LDAPS (636), ni le catalogue global (3268/3269) ;
 *   - le DC n'ecoutait pas le temps : l'agent NTP n'etait lie a UDP/123
 *     qu'au premier `w32tm` tape sur la machine, et il emettait ses
 *     requetes et ses reponses vers l'adresse de destination comme si elle
 *     etait sur le lien, sans passer par la table de routage de l'hote ;
 *   - `w32tm /query /status` annoncait « secondary reference » pour la
 *     strate 1, `0x00000000 (LOCL)` pour une reference de quatre lettres,
 *     et un PDC se donnait lui-meme pour source ;
 *   - `Add-Computer -Credential $cred` (un objet PSCredential, la seule
 *     forme que PowerShell accepte) lisait la chaine « System.Management…
 *     PSCredential » : huit cmdlets re-analysaient la forme `"user:pass"`
 *     chacune de son cote, et seules Start-Process et Send-MailMessage
 *     savaient lire l'objet ;
 *   - `DOMAINE\utilisateur` n'etait pas ramene au sAMAccountName avant
 *     l'echange AS de Kerberos ;
 *   - `cmd.exe /c "echo x | prog"` attribuait « 'prog' is not recognized »
 *     a `cmd`.
 *
 * Autorite : la forme `DOMAINE\utilisateur` et `utilisateur@domaine.dns`
 * est celle que la documentation Microsoft donne pour un jeton de jonction
 * (MS-ADTS, noms de compte) ; la strate 1 « primary reference - syncd by
 * radio clock » et `0x4C4F434C (source name:  LOCL)` sont les textes de
 * `w32tm /query /status` releves sur un PDC qui n'a pas de source externe —
 * d'apres la memoire de l'auteur, aucune capture n'a pu etre rejouee ici.
 *
 * Mesure avant correction (git stash des sources) : 7 des 11 cas tombent.
 * Le cas du catalogue global ne tombe que sur sa poignee de main TCP : avant
 * le correctif, `dialLdap` ignorait son troisieme argument et interrogeait 389.
 * Passent dans les deux etats :
 *   - « avant promotion, le meme stripchart echoue » est le TEMOIN : il
 *     prouve que la reponse vient du role de DC et non du laboratoire ;
 *   - « avant promotion, LDAPS refuse le handshake » est le temoin du port ;
 *   - « la forme "user:pass" historique rejoint encore » et « un mauvais
 *     mot de passe ne joint pas » sont des non-regressions.
 */
import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { Cable } from '@/network/hardware/Cable';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { probeTlsPeer } from '@/network/tls/tlsPeerProbe';
import { dialLdap } from '@/network/devices/windows/server/ad/ldap/LdapClient';
import { type Cli, taper } from '../new_firewall/fortigateBatteryHarness';

const SAFE_MODE = '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force)';
const CREDENTIAL = (user: string, password = 'P@ssw0rd!') =>
  `$cred = New-Object System.Management.Automation.PSCredential("${user}", (ConvertTo-SecureString "${password}" -AsPlainText -Force));`;

function pwsh(device: WindowsPC | WindowsServer) {
  const shell = PowerShellSubShell.create(device as never).subShell;
  return async (line: string) => (await shell.processLine(line)).output.join('\n').trim();
}

async function buildLab(): Promise<{ workstation: WindowsPC; controller: WindowsServer }> {
  const workstation = new WindowsPC('windows-pc', 'WIN-CLI');
  const controller = new WindowsServer('DC01');
  workstation.powerOn();
  controller.powerOn();
  const firewall = createDevice('firewall-fortinet', 0, 0) as unknown as Cli;
  new Cable('c-ws').connect(workstation.getPort('eth0') as never, firewall.getPort('port1') as never);
  new Cable('c-dc').connect(controller.getPort('eth0') as never, firewall.getPort('dmz') as never);
  await taper(firewall, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit dmz', 'set mode static', 'set ip 10.10.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
    'config firewall policy',
    'edit 1', 'set srcintf "port1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set service "ALL"', 'next',
    'edit 2', 'set srcintf "dmz"', 'set dstintf "port1"', 'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set service "ALL"', 'next',
    'end',
  ]);
  await workstation.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.20 255.255.255.0 192.168.1.1');
  await controller.executeCommand('netsh interface ip set address "Ethernet0" static 10.10.10.10 255.255.255.0 10.10.10.1');
  return { workstation, controller };
}

async function promote(controller: WindowsServer): Promise<void> {
  const shell = pwsh(controller);
  await shell('Install-WindowsFeature -Name AD-Domain-Services');
  await shell(`Install-ADDSForest -DomainName "corp.local" -Force ${SAFE_MODE}`);
}

const STRIPCHART = 'w32tm /stripchart /computer:10.10.10.10 /samples:1 /dataonly';

describe('the domain controller keeps time for the domain, across a firewall', () => {
  it('answers a workstation stripchart routed through the gateway', async () => {
    const { workstation, controller } = await buildLab();
    await promote(controller);
    const chart = String(await workstation.executeCommand(STRIPCHART));
    expect(chart).not.toMatch(/error/i);
    expect(chart).toMatch(/\d\d:\d\d:\d\d, [+-]\d+\.\d+s/);
  });

  it('before promotion, the same stripchart times out', async () => {
    const { workstation } = await buildLab();
    expect(String(await workstation.executeCommand(STRIPCHART))).toMatch(/0x800705B4/);
  });

  it('reports itself as a primary reference on its local clock', async () => {
    const { controller } = await buildLab();
    await promote(controller);
    const status = String(await controller.executeCommand('w32tm /query /status'));
    expect(status).toContain('Stratum: 1 (primary reference - syncd by radio clock)');
    expect(status).toContain('ReferenceId: 0x4C4F434C (source name:  LOCL)');
    expect(status).toContain('Source: Local CMOS Clock');
  });
});

describe('the domain controller listens on LDAPS and on the global catalog', () => {
  it('completes a TLS handshake on 636', async () => {
    const { workstation, controller } = await buildLab();
    await promote(controller);
    const outcome = probeTlsPeer(workstation.getTcpStack(), '10.10.10.10', 636);
    expect(outcome.ok).toBe(true);
    expect(outcome.certificate).not.toBeNull();
  });

  it('before promotion, 636 gives no handshake', async () => {
    const { workstation } = await buildLab();
    expect(probeTlsPeer(workstation.getTcpStack(), '10.10.10.10', 636).ok).toBe(false);
  });

  it('answers a search on the global catalog port 3268', async () => {
    const { workstation, controller } = await buildLab();
    await promote(controller);
    expect(await pwsh(workstation)('Test-NetConnection -ComputerName 10.10.10.10 -Port 3268')).toMatch(/TcpTestSucceeded\s*:\s*True/);
    const connection = dialLdap(workstation.getTcpStack(), '10.10.10.10', 3268);
    expect(connection.ok).toBe(true);
    expect(connection.client!.bind('Administrator', 'P@ssw0rd!').ok).toBe(true);
    const found = connection.client!.search('DC=corp,DC=local', 'base', { kind: 'present', attr: 'objectClass' });
    expect(found.ok).toBe(true);
    expect(found.entries.length).toBeGreaterThan(0);
  });
});

describe('Add-Computer reads the credential the way PowerShell passes it', () => {
  async function joinedLab(): Promise<{ shell: ReturnType<typeof pwsh> }> {
    const { workstation, controller } = await buildLab();
    await promote(controller);
    const shell = pwsh(workstation);
    await shell('Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 10.10.10.10');
    return { shell };
  }

  it('joins with a PSCredential named DOMAIN\\user', async () => {
    const { shell } = await joinedLab();
    const out = await shell(`${CREDENTIAL('CORP\\Administrator')} Add-Computer -DomainName corp.local -Credential $cred -Restart:$false`);
    expect(out).not.toMatch(/failed|error/i);
    expect(await shell('(Get-WmiObject Win32_ComputerSystem).Domain')).toBe('corp.local');
  });

  it('joins with a PSCredential named user@dns.name', async () => {
    const { shell } = await joinedLab();
    const out = await shell(`${CREDENTIAL('Administrator@corp.local')} Add-Computer -DomainName corp.local -Credential $cred -Restart:$false`);
    expect(out).not.toMatch(/failed|error/i);
    expect(await shell('(Get-WmiObject Win32_ComputerSystem).Domain')).toBe('corp.local');
  });

  it('still joins with the historical "user:password" string', async () => {
    const { shell } = await joinedLab();
    const out = await shell('Add-Computer -DomainName corp.local -Credential "Administrator:P@ssw0rd!" -Restart:$false');
    expect(out).not.toMatch(/failed|error/i);
    expect(await shell('(Get-WmiObject Win32_ComputerSystem).Domain')).toBe('corp.local');
  });

  it('does not join with a wrong password', async () => {
    const { shell } = await joinedLab();
    const out = await shell(`${CREDENTIAL('CORP\\Administrator', 'wrong')} Add-Computer -DomainName corp.local -Credential $cred -Restart:$false`);
    expect(out).toMatch(/Logon failure/);
    expect(await shell('(Get-WmiObject Win32_ComputerSystem).Domain')).toBe('WORKGROUP');
  });
});

describe('cmd.exe names the program it could not find', () => {
  it('attributes the missing program to itself, not to the shell that ran it', async () => {
    const { workstation } = await buildLab();
    const out = await pwsh(workstation)('cmd.exe /c "echo x | zzprog"');
    expect(out).toContain("'zzprog' is not recognized as an internal or external command");
    expect(out).not.toMatch(/The term 'cmd/);
  });
});
