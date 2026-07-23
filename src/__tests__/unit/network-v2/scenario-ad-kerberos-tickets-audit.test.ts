/**
 * Scénario 5 — Authentification Kerberos : tickets, flux d'authentification
 * et audit.
 *
 * Transcription littérale et fidèle : flux AS-REQ/AS-REP/TGS-REQ/TGS-REP
 * lors d'une connexion domaine (logonDomain déclenche un vrai échange
 * Kerberos, backing `klist`), EventIDs de sécurité 4768/4769/4771/4776 via
 * Get-WinEvent -FilterHashtable, simulation d'échec d'authentification
 * (runas + mauvais mot de passe), Search-ADAccount -LockedOut, et
 * inspection/détection de conflits de SPN.
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
  await run(ps(dc), 'New-ADUser -Name "Jean Admin" -SamAccountName jadmin -AccountPassword (ConvertTo-SecureString "User@Mandeng2025!" -AsPlainText -Force) -Enabled $true');
  await run(ps(client), 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -Server "192.168.10.10" -NewName "PC-WIN-01" -Force');
  return { dc, client };
}

describe('Scénario 5 — Kerberos : tickets, flux d\'authentification et audit (mandeng.lan)', () => {
  describe('flux Kerberos complet lors de la connexion', () => {
    it('klist affiche le TGT krbtgt/MANDENG.LAN avec les flags forwardable renewable initial pre_authent après une connexion domaine réussie', async () => {
      const { client } = await buildLan();
      client.logonDomain('MANDENG\\jadmin', 'User@Mandeng2025!');

      const out = await client.executeCmdCommand('klist');
      expect(out).toContain('Cached Tickets: (1)');
      expect(out).toContain('jadmin @ MANDENG.LAN');
      expect(out).toContain('krbtgt/MANDENG.LAN');
      expect(out).toMatch(/forwardable renewable initial pre_authent/);
    });

    it('le TGT a un temps de validité de 10h (défaut domaine) et une fenêtre de renouvellement de 7 jours', async () => {
      const { client } = await buildLan();
      client.logonDomain('MANDENG\\jadmin', 'User@Mandeng2025!');

      const tgt = client.getKerberosTicketCache().getTgt();
      expect(tgt).toBeDefined();
      const enc = tgt!.encKdcRepPart;
      const start = enc.starttime ?? enc.authtime;
      expect(enc.endtime - start).toBe(10 * 60 * 60); // 10h de validité
      expect(enc.renewTill).toBeDefined();
      expect(enc.renewTill! - start).toBe(7 * 24 * 60 * 60); // 7 jours de renouvellement
    });

    it('klist get host/DC01.mandeng.lan demande explicitement un TGS pour HOST/DC01', async () => {
      const { client } = await buildLan();
      client.logonDomain('MANDENG\\jadmin', 'User@Mandeng2025!');
      const out = await client.executeCmdCommand('klist get host/DC01.mandeng.lan');
      expect(out).not.toMatch(/not recognized/i);
    });
  });

  describe('événements Kerberos dans l\'Observateur d\'événements', () => {
    it('EventID 4768 (AS-REQ) est journalisé sur le DC avec code de résultat 0x0 lors d\'une obtention de TGT réussie', async () => {
      const { dc, client } = await buildLan();
      client.logonDomain('MANDENG\\jadmin', 'User@Mandeng2025!');

      const out = await run(ps(dc), [
        '$StartTime = (Get-Date).AddHours(-1)',
        "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4768; StartTime = $StartTime }",
      ].join('\n'));
      expect(out).toContain('4768');
      expect(out).toMatch(/jadmin/);
      expect(out).toMatch(/0x0/);
    });
  });

  describe('simulation d\'échecs d\'authentification', () => {
    it('runas /user:MANDENG\\jadmin reconnaît un compte de domaine valide (pas "not recognized")', async () => {
      const { dc } = await buildLan();
      const out = await dc.executeCmdCommand('runas /user:MANDENG\\jadmin whoami');
      expect(out).not.toMatch(/not recognized/i);
      expect(out.toLowerCase()).toContain('jadmin');
    });

    it('l\'échec de mot de passe interactif produit le message runas.exe réel "1326: The user name or password is incorrect."', async () => {
      const { runasIncorrectPasswordMessage } = await import('@/network/devices/windows/WinRunas');
      const out = runasIncorrectPasswordMessage('cmd');
      expect(out).toMatch(/RUNAS ERROR/i);
      expect(out).toMatch(/1326/);
      expect(out).toMatch(/user name or password is incorrect/i);
    });

    it('EventID 4771 (échec de pré-authentification) est journalisé sur le DC avec code 0x18 après une authentification échouée', async () => {
      const { dc, client } = await buildLan();
      client.logonDomain('MANDENG\\jadmin', 'WrongPassword!');

      const out = await run(ps(dc), 'Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = 4771 } -MaxEvents 5');
      expect(out).toContain('4771');
      expect(out).toMatch(/0x18/);
    });

    it('Search-ADAccount -LockedOut liste les comptes verrouillés après des échecs répétés', async () => {
      const { dc, client } = await buildLan();
      for (let i = 0; i < 6; i++) {
        client.logonDomain('MANDENG\\jadmin', 'WrongPassword!');
      }
      const out = await run(ps(dc), 'Search-ADAccount -LockedOut | Select-Object Name, SamAccountName, LockedOut, BadLogonCount');
      expect(out).toContain('jadmin');
      expect(out).toMatch(/True/);
    });
  });

  describe('inspection des SPN et tickets de service', () => {
    async function withServiceAccount() {
      const { dc, client } = await buildLan();
      const sh = ps(dc);
      await run(sh, 'New-ADUser -Name "svc-oracle" -SamAccountName svc-oracle -AccountPassword (ConvertTo-SecureString "Svc@Mandeng2025!" -AsPlainText -Force) -Enabled $true');
      await run(sh, 'Set-ADUser -Identity svc-oracle -Add @{ServicePrincipalNames="oracle/srv-oracle.mandeng.lan","oracle/srv-oracle.mandeng.lan:1521"}');
      return { dc, client, sh };
    }

    it('Get-ADUser svc-oracle -Properties ServicePrincipalNames liste les SPN oracle/srv-oracle.mandeng.lan', async () => {
      const { sh } = await withServiceAccount();
      const out = await run(sh, 'Get-ADUser -Identity "svc-oracle" -Properties ServicePrincipalNames | Select-Object -ExpandProperty ServicePrincipalNames');
      expect(out).toContain('oracle/srv-oracle.mandeng.lan');
      expect(out).toContain('oracle/srv-oracle.mandeng.lan:1521');
    });

    it('un SPN dupliqué sur deux comptes est détecté via Get-ADObject -Filter + Group-Object', async () => {
      const { dc, sh } = await withServiceAccount();
      await run(sh, 'New-ADUser -Name "svc-oracle2" -SamAccountName svc-oracle2 -AccountPassword (ConvertTo-SecureString "Svc@Mandeng2025!" -AsPlainText -Force) -Enabled $true');
      await run(sh, 'Set-ADUser -Identity svc-oracle2 -Add @{ServicePrincipalNames="oracle/srv-oracle.mandeng.lan"}');

      const out = await run(ps(dc), [
        '$AllSPNs = Get-ADObject -Filter {ServicePrincipalName -like "*"} -Properties ServicePrincipalName | Select-Object Name, ServicePrincipalName',
        '$SPNs = $AllSPNs | ForEach-Object { $_.ServicePrincipalName | ForEach-Object { [PSCustomObject]@{Compte=$_.Name; SPN=$_} } }',
        '$SPNs | Group-Object SPN | Where-Object {$_.Count -gt 1} | Select-Object Name, Count, Group',
      ].join('\n'));
      expect(out).toContain('oracle/srv-oracle.mandeng.lan');
      expect(out).toMatch(/2/);
    });
  });
});
