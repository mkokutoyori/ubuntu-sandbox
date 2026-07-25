/**
 * Scénario 18 — Audit avancé et collecte centralisée des événements
 * Windows (WEF/WEC).
 *
 * Transcription littérale et fidèle : activation du service Windows
 * Event Collector sur SRV-SIEM (wecutil qc, Wecsvc en démarrage
 * automatique), ajout du compte machine du collecteur au groupe
 * Event Log Readers, GPO de forwarding
 * (SubscriptionManager + démarrage automatique de WinRM sur les
 * sources), création de l'abonnement source-initiated via un fichier
 * XML (wecutil cs/gs), et vérification de la réception centralisée
 * dans le journal ForwardedEvents avec le MachineName de la source.
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

async function buildLan(): Promise<{ dc: WindowsServer; srvSiem: WindowsServer; client: WindowsPC }> {
  const dc = new WindowsServer('DC01');
  const srvSiem = new WindowsServer('SRV-SIEM');
  const client = new WindowsPC('windows-pc', 'PC-WIN-01');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-siem').connect(srvSiem.getPorts()[0], sw.getPorts()[1]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[2]);
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), mask);
  srvSiem.getPorts()[0].configureIP(new IPAddress('192.168.10.25'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.10.30'), mask);

  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');

  srvSiem.setCurrentUser('Administrator');
  await run(ps(srvSiem), 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -NewName "SRV-SIEM" -Server 192.168.10.10 -Force');
  client.setCurrentUser('Administrator');
  await run(ps(client), 'Add-Computer -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -NewName "PC-WIN-01" -Server 192.168.10.10 -Force');

  return { dc, srvSiem, client };
}

describe('Scénario 18 — Windows Event Forwarding centralisé (mandeng.lan)', () => {
  describe('configuration du collecteur WEC sur SRV-SIEM', () => {
    it('wecutil qc /quiet configure le service Windows Event Collector', async () => {
      const { srvSiem } = await buildLan();
      const out = await srvSiem.executeCmdCommand('wecutil qc /quiet');
      expect(out).toMatch(/service is now configured correctly/i);
    });

    it('Set-Service Wecsvc en démarrage automatique puis Start-Service le démarre', async () => {
      const { srvSiem } = await buildLan();
      const sh = ps(srvSiem);
      await run(sh, 'Set-Service -Name "Wecsvc" -StartupType Automatic');
      await run(sh, 'Start-Service -Name "Wecsvc"');

      const out = await run(sh, 'Get-Service -Name "Wecsvc" | Select-Object Name, Status, StartType');
      expect(out).toMatch(/Running/);
      expect(out).toMatch(/Automatic/);
    });

    it('Add-ADGroupMember ajoute le compte machine SRV-SIEM$ au groupe Event Log Readers', async () => {
      const { dc } = await buildLan();
      const out = await run(ps(dc), 'Add-ADGroupMember -Identity "Event Log Readers" -Members "SRV-SIEM$"');
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(ps(dc), 'Get-ADGroupMember "Event Log Readers"');
      expect(check).toContain('SRV-SIEM$');
    });
  });

  describe('configuration de la GPO de forwarding', () => {
    it('New-GPO crée MANDENG-EventForwarding', async () => {
      const { dc } = await buildLan();
      const out = await run(ps(dc), 'New-GPO -Name "MANDENG-EventForwarding" -Domain "mandeng.lan"');
      expect(out).not.toMatch(/not recognized/i);
    });

    it('Set-GPRegistryValue configure le SubscriptionManager vers http://SRV-SIEM.mandeng.lan:5985/wsman/SubscriptionManager/WEC', async () => {
      const { dc } = await buildLan();
      const sh = ps(dc);
      await run(sh, 'New-GPO -Name "MANDENG-EventForwarding" -Domain "mandeng.lan"');
      const out = await run(sh, [
        'Set-GPRegistryValue',
        '-Name "MANDENG-EventForwarding"',
        '-Key "HKLM\\Software\\Policies\\Microsoft\\Windows\\EventLog\\EventForwarding\\SubscriptionManager"',
        '-ValueName "1"',
        '-Type String',
        '-Value "Server=http://SRV-SIEM.mandeng.lan:5985/wsman/SubscriptionManager/WEC,Refresh=60"',
      ].join(' '));
      expect(out).not.toMatch(/not recognized/i);
    });

    it('Set-GPRegistryValue active le démarrage automatique du service WinRM sur les sources', async () => {
      const { dc } = await buildLan();
      const sh = ps(dc);
      await run(sh, 'New-GPO -Name "MANDENG-EventForwarding" -Domain "mandeng.lan"');
      const out = await run(sh, 'Set-GPRegistryValue -Name "MANDENG-EventForwarding" -Key "HKLM\\System\\CurrentControlSet\\Services\\WinRM" -ValueName "Start" -Type DWord -Value 2');
      expect(out).not.toMatch(/not recognized/i);
    });

    it('New-GPLink lie MANDENG-EventForwarding à tout le domaine (DC=mandeng,DC=lan)', async () => {
      const { dc } = await buildLan();
      const sh = ps(dc);
      await run(sh, 'New-GPO -Name "MANDENG-EventForwarding" -Domain "mandeng.lan"');
      const out = await run(sh, 'New-GPLink -Name "MANDENG-EventForwarding" -Target "DC=mandeng,DC=lan" -LinkEnabled Yes');
      expect(out).not.toMatch(/not recognized/i);
    });
  });

  describe('création de l\'abonnement WEF sur SRV-SIEM', () => {
    const subscriptionXml = [
      '<Subscription xmlns="http://schemas.microsoft.com/2006/03/windows/events/subscription">',
      '  <SubscriptionId>Mandeng-Security-Events</SubscriptionId>',
      '  <SubscriptionType>SourceInitiated</SubscriptionType>',
      '  <Description>Collecte des evenements de securite Mandeng</Description>',
      '  <Enabled>true</Enabled>',
      '  <ConfigurationMode>Custom</ConfigurationMode>',
      '  <Query><![CDATA[<QueryList><Query Id="0"><Select Path="Security">*[System[(EventID=4624 or EventID=4625 or EventID=4720)]]</Select></Query></QueryList>]]></Query>',
      '  <ReadExistingEvents>false</ReadExistingEvents>',
      '  <TransportName>HTTP</TransportName>',
      '  <ContentFormat>RenderedText</ContentFormat>',
      '  <LogFile>ForwardedEvents</LogFile>',
      '</Subscription>',
    ].join('\n');

    it('wecutil cs crée l\'abonnement Mandeng-Security-Events à partir du fichier XML', async () => {
      const { srvSiem } = await buildLan();
      const sh = ps(srvSiem);
      await run(sh, 'New-Item -ItemType Directory -Path "C:\\Subscriptions" -Force | Out-Null');
      await run(sh, `'${subscriptionXml.replace(/'/g, "''")}' | Out-File "C:\\Subscriptions\\Mandeng-Security.xml" -Encoding UTF8`);
      const out = await srvSiem.executeCmdCommand('wecutil cs "C:\\Subscriptions\\Mandeng-Security.xml"');
      expect(out).not.toMatch(/not recognized/i);

      const status = await srvSiem.executeCmdCommand('wecutil gs "Mandeng-Security-Events"');
      expect(status).toMatch(/Status:\s*Active/);
      expect(status).toMatch(/RunTimeStatus:\s*Active/);
    });

    it('Get-WinEvent -LogName ForwardedEvents liste les événements collectés avec le MachineName de la source', async () => {
      const { dc, srvSiem, client } = await buildLan();
      const sh = ps(srvSiem);
      await run(sh, 'New-Item -ItemType Directory -Path "C:\\Subscriptions" -Force | Out-Null');
      await run(sh, `'${subscriptionXml.replace(/'/g, "''")}' | Out-File "C:\\Subscriptions\\Mandeng-Security.xml" -Encoding UTF8`);
      await srvSiem.executeCmdCommand('wecutil cs "C:\\Subscriptions\\Mandeng-Security.xml"');

      // Génère un événement 4624 sur le poste client, source de l'abonnement.
      await run(ps(client), 'cmd');
      await run(ps(client), 'runas /user:Administrator whoami');
      void dc;

      const out = await run(sh, 'Get-WinEvent -LogName "ForwardedEvents" -MaxEvents 20 | Select-Object TimeCreated, Id, MachineName, Message | Format-Table -AutoSize -Wrap');
      expect(out).toMatch(/PC-WIN-01/);
    });
  });
});
