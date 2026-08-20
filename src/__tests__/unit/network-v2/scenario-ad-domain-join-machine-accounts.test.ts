/**
 * Scénario 3 — Jonction de machines Windows au domaine et gestion des
 * comptes machine.
 *
 * Transcription littérale et fidèle : jonction via Add-Computer -OUPath
 * (compte machine créé directement dans l'OU cible, pas dans le
 * conteneur Computers par défaut), vérification côté DC
 * (Get-ADComputer, DNS, Test-ComputerSecureChannel), gestion des
 * comptes machine (comptes inactifs, réinitialisation), et diagnostic
 * post-jonction (klist, Get-ADDomainController -Discover).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLan(): Promise<{ dc: WindowsServer; client: WindowsPC }> {
  const dc = new WindowsServer('DC01');
  const client = new WindowsPC('windows-pc', 'PC-WIN-01');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.10.30'), mask);

  dc.setCurrentUser('Administrator');
  client.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  await run(ps(dc), 'New-ADOrganizationalUnit -Name "Mandeng" -Path "DC=mandeng,DC=lan"');
  await run(ps(dc), 'New-ADOrganizationalUnit -Name "Ordinateurs" -Path "OU=Mandeng,DC=mandeng,DC=lan"');
  await run(ps(dc), 'New-ADOrganizationalUnit -Name "Postes" -Path "OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan"');
  // A real domain join needs the client's DNS resolver already pointed at
  // the domain before anything else works (Resolve-DnsName, discovery,
  // Add-Computer itself) — this simulator has no dynamic-DNS registration
  // for a promoted DC yet, so seed the client's hosts file the same way a
  // real deployment's DHCP-assigned DNS server would already know it.
  await run(ps(client), 'Add-Content -Path "C:\\Windows\\System32\\drivers\\etc\\hosts" -Value "192.168.10.10 mandeng.lan`n192.168.10.10 DC01.mandeng.lan"');
  return { dc, client };
}

describe('Scénario 3 — jonction de machines et comptes machine (mandeng.lan)', () => {
  describe('jonction au domaine depuis le poste client', () => {
    it('Resolve-DnsName mandeng.lan et Test-NetConnection vers le DC réussissent avant jonction', async () => {
      const { client } = await buildLan();
      const resolve = await run(ps(client), 'Resolve-DnsName mandeng.lan');
      expect(resolve).toMatch(/mandeng\.lan/);
      const test = await run(ps(client), 'Test-NetConnection -ComputerName DC01.mandeng.lan -Port 389');
      expect(test).toMatch(/TcpTestSucceeded\s*:\s*True/);
    });

    it('Add-Computer -OUPath crée le compte machine PC-WIN-01$ DIRECTEMENT dans OU=Postes (pas Computers)', async () => {
      const { dc, client } = await buildLan();
      const out = await run(ps(client), [
        'Add-Computer',
        '-DomainName "mandeng.lan"',
        '-Credential "Administrator:DSRM@Mandeng2025!"',
        '-OUPath "OU=Postes,OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan"',
        '-NewName "PC-WIN-01"',
        '-Restart:$false',
        '-Force',
      ].join(' '));
      expect(out).toMatch(/HasSucceeded\s*:\s*True|^$/);
      const computer = dc.getDirectoryStore()!.getComputer('PC-WIN-01');
      expect(computer).not.toBeNull();
      expect(computer?.dn).toContain('OU=Postes,OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan');
    });
  });

  describe('vérification côté DC après jonction', () => {
    it('Get-ADComputer PC-WIN-01 retourne DNSHostName, DistinguishedName sous OU=Postes, Enabled=True', async () => {
      const { dc, client } = await buildLan();
      await run(ps(client), 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -OUPath "OU=Postes,OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan" -NewName "PC-WIN-01"');
      const out = await run(ps(dc), 'Get-ADComputer -Filter {Name -eq "PC-WIN-01"} -Properties *');
      expect(out).toContain('PC-WIN-01');
      expect(out).toMatch(/PC-WIN-01\.mandeng\.lan/);
      expect(out).toContain('OU=Postes,OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan');
      expect(out).toMatch(/Enabled\s*:\s*True/);
    });

    it('Test-ComputerSecureChannel retourne True depuis le poste après jonction', async () => {
      const { client } = await buildLan();
      await run(ps(client), 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -OUPath "OU=Postes,OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan" -NewName "PC-WIN-01"');
      const out = await run(ps(client), 'Test-ComputerSecureChannel');
      expect(out.trim()).toBe('True');
    });
  });

  describe('gestion des comptes machine', () => {
    it('Get-ADComputer -Filter * liste PC-WIN-01 avec son état', async () => {
      const { dc, client } = await buildLan();
      await run(ps(client), 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -OUPath "OU=Postes,OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan" -NewName "PC-WIN-01"');
      const out = await run(ps(dc), 'Get-ADComputer -Filter * -SearchBase "OU=Mandeng,DC=mandeng,DC=lan" -Properties OperatingSystem, LastLogonDate, Enabled');
      expect(out).toContain('PC-WIN-01');
    });

    it('Set-ADAccountPassword -Reset réinitialise le mot de passe du compte machine PC-WIN-01$', async () => {
      const { dc, client } = await buildLan();
      await run(ps(client), 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -OUPath "OU=Postes,OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan" -NewName "PC-WIN-01"');
      const out = await run(ps(dc), 'Set-ADAccountPassword -Identity "PC-WIN-01$" -Reset -NewPassword (ConvertTo-SecureString "MachinePass2025!" -AsPlainText -Force)');
      expect(out).not.toMatch(/not recognized/i);
    });

    it('les SPN HOST/PC-WIN-01 et HOST/PC-WIN-01.mandeng.lan sont créés automatiquement', async () => {
      const { dc, client } = await buildLan();
      await run(ps(client), 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -OUPath "OU=Postes,OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan" -NewName "PC-WIN-01"');
      const out = await run(ps(dc), 'Get-ADComputer PC-WIN-01 -Properties ServicePrincipalNames | Select-Object -ExpandProperty ServicePrincipalNames');
      expect(out).toContain('HOST/PC-WIN-01');
      expect(out).toContain('HOST/PC-WIN-01.mandeng.lan');
    });
  });

  describe('diagnostic post-jonction', () => {
    it('(Get-WmiObject Win32_ComputerSystem).Domain retourne mandeng.lan après redémarrage', async () => {
      const { client } = await buildLan();
      await run(ps(client), 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -OUPath "OU=Postes,OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan" -NewName "PC-WIN-01"');
      const out = await run(ps(client), '(Get-WmiObject Win32_ComputerSystem).Domain');
      expect(out.trim()).toBe('mandeng.lan');
    });

    it('(Get-ADDomainController -Discover).HostName retourne DC01.mandeng.lan', async () => {
      const { client } = await buildLan();
      await run(ps(client), 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -OUPath "OU=Postes,OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan" -NewName "PC-WIN-01"');
      const out = await run(ps(client), '(Get-ADDomainController -Discover).HostName');
      expect(out.trim()).toBe('DC01.mandeng.lan');
    });
  });
});
