/**
 * Scénario 6 — Détection et résolution d'un conflit de serveurs DHCP
 * parasites (rogue DHCP) par PowerShell avec analyse des baux distribués.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const SERVEURS_AUTORISES = ['192.168.10.1', '192.168.10.2'];
const PASSERELLE_ATTENDUE = '192.168.10.1';
const DNS_ATTENDU = '192.168.10.10';

async function buildRogueOnlyLab() {
  const rogue = new CiscoRouter('ROGUE');
  const sw = new CiscoSwitch('switch-cisco', 'SW1');
  const win = new WindowsPC('windows-pc', 'WINPC');
  const fakeDns = new LinuxServer('linux-server', 'FAKEDNS');
  win.setCurrentUser('Administrator');

  new Cable('c-r').connect(rogue.getPort('GigabitEthernet0/0')!, sw.getPort('GigabitEthernet0/1')!);
  new Cable('c-w').connect(win.getPort('eth0')!, sw.getPort('GigabitEthernet0/2')!);
  new Cable('c-d').connect(fakeDns.getPort('eth0')!, sw.getPort('GigabitEthernet0/3')!);

  rogue.configureInterface('GigabitEthernet0/0', new IPAddress('192.168.10.66'), new SubnetMask('255.255.255.0'));
  for (const cmd of [
    'enable', 'configure terminal',
    'service dhcp',
    'ip dhcp pool ROGUE',
    'network 192.168.10.0 255.255.255.0',
    'default-router 192.168.10.66',
    'dns-server 192.168.10.250',
    'exit',
    'ip dhcp excluded-address 192.168.10.66 192.168.10.99',
    'end',
  ]) await rogue.executeCommand(cmd);

  fakeDns.configureInterface('eth0', new IPAddress('192.168.10.250'), new SubnetMask('255.255.255.0'));
  fakeDns.dnsService.addRecord({ name: 'intranet', type: 'A', value: '6.6.6.6', ttl: 3600 });
  fakeDns.dnsService.start();

  return { rogue, sw, win, fakeDns };
}

async function buildLegitAndRogueLab(trustLegit: boolean) {
  const legit = new CiscoRouter('LEGIT');
  const rogue = new CiscoRouter('ROGUE');
  const sw = new CiscoSwitch('switch-cisco', 'SW1');
  const win = new WindowsPC('windows-pc', 'WINPC');
  const legitDns = new LinuxServer('linux-server', 'LEGITDNS');
  win.setCurrentUser('Administrator');

  new Cable('c-l').connect(legit.getPort('GigabitEthernet0/0')!, sw.getPort('GigabitEthernet0/1')!);
  new Cable('c-r').connect(rogue.getPort('GigabitEthernet0/0')!, sw.getPort('GigabitEthernet0/2')!);
  new Cable('c-w').connect(win.getPort('eth0')!, sw.getPort('GigabitEthernet0/3')!);
  new Cable('c-d').connect(legitDns.getPort('eth0')!, sw.getPort('GigabitEthernet0/4')!);

  legit.configureInterface('GigabitEthernet0/0', new IPAddress(PASSERELLE_ATTENDUE), new SubnetMask('255.255.255.0'));
  for (const cmd of [
    'enable', 'configure terminal',
    'service dhcp',
    'ip dhcp pool LAN',
    'network 192.168.10.0 255.255.255.0',
    `default-router ${PASSERELLE_ATTENDUE}`,
    `dns-server ${DNS_ATTENDU}`,
    'exit',
    'ip dhcp excluded-address 192.168.10.1 192.168.10.20',
    'end',
  ]) await legit.executeCommand(cmd);

  rogue.configureInterface('GigabitEthernet0/0', new IPAddress('192.168.10.66'), new SubnetMask('255.255.255.0'));
  for (const cmd of [
    'enable', 'configure terminal',
    'service dhcp',
    'ip dhcp pool ROGUE',
    'network 192.168.10.0 255.255.255.0',
    'default-router 192.168.10.66',
    'dns-server 192.168.10.250',
    'exit',
    'ip dhcp excluded-address 192.168.10.66 192.168.10.99',
    'end',
  ]) await rogue.executeCommand(cmd);

  legitDns.configureInterface('eth0', new IPAddress(DNS_ATTENDU), new SubnetMask('255.255.255.0'));
  legitDns.dnsService.addRecord({ name: 'intranet', type: 'A', value: '192.168.10.50', ttl: 3600 });
  legitDns.dnsService.start();

  for (const cmd of [
    'enable', 'configure terminal',
    'ip dhcp snooping', 'ip dhcp snooping vlan 1',
    'interface GigabitEthernet0/1',
    ...(trustLegit ? ['ip dhcp snooping trust'] : []),
    'exit', 'end',
  ]) await sw.executeCommand(cmd);

  return { legit, rogue, sw, win, legitDns };
}

function psShell(win: WindowsPC) {
  const { subShell } = PowerShellSubShell.create(win);
  return async (script: string) => (await subShell.processLine(script)).output.join('\n');
}

const AUDIT_SCRIPT = String.raw`
function Invoke-RogueDhcpAudit {
  param(
    [string[]]$ServeursAutorises = @('${SERVEURS_AUTORISES[0]}','${SERVEURS_AUTORISES[1]}'),
    [string]$PasserelleAttendue = '${PASSERELLE_ATTENDUE}',
    [string]$DNSAttendu = '${DNS_ATTENDU}',
    [string]$InterfaceAlias = 'Ethernet 0',
    [string]$NomInterne = 'intranet'
  )
  $cfg = Get-NetIPConfiguration | Where-Object { $_.InterfaceAlias -eq $InterfaceAlias }
  $serveur = $cfg.DhcpServer
  $autorise = $ServeursAutorises -contains $serveur

  $neighbor = Get-NetNeighbor -IPAddress $serveur -ErrorAction SilentlyContinue
  $macServeur = $neighbor.LinkLayerAddress

  $passerelleRecue = $cfg.IPv4DefaultGateway
  $dnsRecu = ($cfg.DNSServer -split ',')[0].Trim()

  $ecarts = @()
  if ($passerelleRecue -ne $PasserelleAttendue) { $ecarts += "Passerelle: attendu=$PasserelleAttendue recu=$passerelleRecue" }
  if ($dnsRecu -ne $DNSAttendu) { $ecarts += "DNS: attendu=$DNSAttendu recu=$dnsRecu" }

  $dnsJoignable = (Test-NetConnection -ComputerName $dnsRecu -Port 53).TcpTestSucceeded
  $resolutionInterne = $null
  try { $resolutionInterne = (Resolve-DnsName $NomInterne -Server $dnsRecu -ErrorAction Stop).IPAddress } catch {}

  $passerelleJoignable = (Test-NetConnection -ComputerName $passerelleRecue).PingSucceeded

  [PSCustomObject]@{
    ServeurDHCP          = $serveur
    ServeurAutorise      = $autorise
    MacServeur           = $macServeur
    Passerelle           = $passerelleRecue
    DNS                  = $dnsRecu
    Ecarts               = $ecarts
    DnsJoignable         = $dnsJoignable
    ResolutionInterne    = $resolutionInterne
    PasserelleJoignable  = $passerelleJoignable
  }
}
`;

const REMEDIATION_SCRIPT = String.raw`
${AUDIT_SCRIPT}
function Invoke-RogueDhcpRemediation {
  param(
    [string[]]$ServeursAutorises = @('${SERVEURS_AUTORISES[0]}','${SERVEURS_AUTORISES[1]}'),
    [string]$PasserelleAttendue = '${PASSERELLE_ATTENDUE}',
    [string]$DNSAttendu = '${DNS_ATTENDU}',
    [string]$InterfaceAlias = 'Ethernet 0',
    [string]$AdresseSecours = '192.168.10.222'
  )
  $src = 'RogueDhcpAuditScript'
  New-EventLog -LogName Application -Source $src -ErrorAction SilentlyContinue

  $audit = Invoke-RogueDhcpAudit -ServeursAutorises $ServeursAutorises -PasserelleAttendue $PasserelleAttendue -DNSAttendu $DNSAttendu -InterfaceAlias $InterfaceAlias

  if ($audit.ServeurAutorise) {
    return [PSCustomObject]@{ Result = 'ok'; Audit = $audit }
  }

  $msg = "Serveur DHCP non autorise detecte: IP=$($audit.ServeurDHCP) MAC=$($audit.MacServeur) Passerelle=$($audit.Passerelle) DNS=$($audit.DNS) Ecarts=$($audit.Ecarts -join '; ')"
  Write-EventLog -LogName Application -Source $src -EventId 2001 -EntryType Warning -Message $msg

  New-Item -ItemType Directory -Path Z:\alertes -Force | Out-Null
  $audit | ConvertTo-Json -Depth 5 | Out-File -FilePath Z:\alertes\rogue-dhcp.json

  Invoke-Expression "ipconfig /release" | Out-Null
  Invoke-Expression "ipconfig /renew" | Out-Null
  $after = Invoke-RogueDhcpAudit -ServeursAutorises $ServeursAutorises -PasserelleAttendue $PasserelleAttendue -DNSAttendu $DNSAttendu -InterfaceAlias $InterfaceAlias

  if ($after.ServeurAutorise) {
    return [PSCustomObject]@{ Result = 'remediated'; Audit = $after }
  }

  New-NetIPAddress -IPAddress $AdresseSecours -InterfaceAlias $InterfaceAlias -PrefixLength 24 -DefaultGateway $PasserelleAttendue
  Set-DnsClientServerAddress -InterfaceAlias $InterfaceAlias -ServerAddresses $DNSAttendu
  return [PSCustomObject]@{ Result = 'static-fallback'; Audit = $after }
}
`;

describe('Scénario 6 — identification du serveur DHCP ayant répondu', () => {
  it('Get-NetIPConfiguration expose le serveur DHCP dans DhcpServer', async () => {
    const { win } = await buildRogueOnlyLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const out = await ps("(Get-NetIPConfiguration | Where-Object { $_.InterfaceAlias -eq 'Ethernet 0' }).DhcpServer");

    expect(out.trim()).toBe('192.168.10.66');
  }, 20000);

  it('comparaison avec la liste blanche identifie un serveur DHCP non autorisé', async () => {
    const { win } = await buildRogueOnlyLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const out = await ps(`${AUDIT_SCRIPT}\n(Invoke-RogueDhcpAudit).ServeurAutorise`);

    expect(out.trim()).toBe('False');
  }, 20000);

  it('un serveur légitime dans la liste blanche ne déclenche aucune alerte', async () => {
    const { win } = await buildLegitAndRogueLab(true);
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const out = await ps(`${AUDIT_SCRIPT}\n(Invoke-RogueDhcpAudit).ServeurAutorise`);

    expect(out.trim()).toBe('True');
  }, 20000);

  it("l'adresse MAC du serveur ayant répondu est capturée même quand elle diffère d'un serveur attendu", async () => {
    const { win, rogue } = await buildRogueOnlyLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const mac = (await ps(`${AUDIT_SCRIPT}\n(Invoke-RogueDhcpAudit).MacServeur`)).trim().toLowerCase();
    const rogueMac = rogue.getPort('GigabitEthernet0/0')!.getMAC().toString().toLowerCase();

    expect(mac).toBe(rogueMac.replace(/:/g, '-'));
  }, 20000);
});

describe('Scénario 6 — analyse de la configuration distribuée', () => {
  it("le rapport d'écarts détaille précisément passerelle et DNS incorrects", async () => {
    const { win } = await buildRogueOnlyLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const out = await ps(`${AUDIT_SCRIPT}\n(Invoke-RogueDhcpAudit).Ecarts -join '|'`);

    expect(out).toContain('Passerelle: attendu=192.168.10.1 recu=192.168.10.66');
    expect(out).toContain('DNS: attendu=192.168.10.10 recu=192.168.10.250');
  }, 20000);

  it('une configuration saine ne produit aucun écart', async () => {
    const { win } = await buildLegitAndRogueLab(true);
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const out = await ps(`${AUDIT_SCRIPT}\n(Invoke-RogueDhcpAudit).Ecarts.Count`);

    expect(out.trim()).toBe('0');
  }, 20000);

  it('Resolve-DnsName -Server le DNS parasite révèle une réponse falsifiée', async () => {
    const { win } = await buildRogueOnlyLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const out = await ps(`${AUDIT_SCRIPT}\n(Invoke-RogueDhcpAudit).ResolutionInterne`);

    expect(out.trim()).toBe('6.6.6.6');
  }, 20000);

  it('Test-NetConnection montre que la passerelle parasite reste joignable (ce qui ne la rend pas légitime)', async () => {
    const { win } = await buildRogueOnlyLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const joignable = await ps(`${AUDIT_SCRIPT}\n(Invoke-RogueDhcpAudit).PasserelleJoignable`);
    const autorise = await ps(`${AUDIT_SCRIPT}\n(Invoke-RogueDhcpAudit).ServeurAutorise`);

    expect(joignable.trim()).toBe('True');
    expect(autorise.trim()).toBe('False');
  }, 20000);
});

describe('Scénario 6 — journalisation et alerte', () => {
  it('EventId 2001 en Warning est émis avec IP, MAC et configuration du serveur parasite', async () => {
    const { win } = await buildRogueOnlyLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    await ps(`${REMEDIATION_SCRIPT}\nInvoke-RogueDhcpRemediation | Out-Null`);

    const out = await ps("Get-EventLog -LogName Application -Source RogueDhcpAuditScript | Where-Object { $_.EventID -eq 2001 } | Format-List EventID,EntryType,Message");

    expect(out).toMatch(/EventID\s*:\s*2001/);
    expect(out).toMatch(/EntryType\s*:\s*Warning/);
    expect(out).toContain('192.168.10.66');
    expect(out).toContain('192.168.10.250');
  }, 30000);

  it("export JSON de l'anomalie vers le partage réseau via ConvertTo-Json", async () => {
    const { win } = await buildRogueOnlyLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    await ps('net use Z: \\\\serveur-supervision\\alertes');
    await ps(`${REMEDIATION_SCRIPT}\nInvoke-RogueDhcpRemediation | Out-Null`);

    const out = await ps('Get-Content Z:\\alertes\\rogue-dhcp.json | ConvertFrom-Json | Select-Object -ExpandProperty ServeurDHCP');

    expect(out.trim()).toBe('192.168.10.66');
  }, 30000);

  it('aucune alerte pour un serveur légitime (pas de faux positif)', async () => {
    const { win } = await buildLegitAndRogueLab(true);
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    await ps(`${REMEDIATION_SCRIPT}\nInvoke-RogueDhcpRemediation | Out-Null`);

    const out = await ps('(Get-EventLog -LogName Application -Source RogueDhcpAuditScript -ErrorAction SilentlyContinue | Where-Object { $_.EventID -eq 2001 } | Measure-Object).Count');

    expect(out.trim()).toBe('0');
  }, 30000);
});

describe('Scénario 6 — remédiation automatique', () => {
  it('un renouvellement forcé obtient le serveur légitime une fois le port de confiance configuré', async () => {
    const { win, sw } = await buildLegitAndRogueLab(false);
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const before = await ps(`${AUDIT_SCRIPT}\n(Invoke-RogueDhcpAudit).ServeurAutorise`);
    expect(before.trim()).toBe('False');

    for (const cmd of [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/1', 'ip dhcp snooping trust', 'exit', 'end',
    ]) await sw.executeCommand(cmd);

    const out = await ps(`${REMEDIATION_SCRIPT}\n(Invoke-RogueDhcpRemediation).Result`);

    expect(out.trim()).toBe('remediated');

    const after = await ps(`${AUDIT_SCRIPT}\n(Invoke-RogueDhcpAudit).ServeurAutorise`);
    expect(after.trim()).toBe('True');
  }, 40000);

  it("bascule sur une adresse statique de secours quand le réseau n'est pas protégé par DHCP snooping", async () => {
    const { win } = await buildRogueOnlyLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const out = await ps(`${REMEDIATION_SCRIPT}\n(Invoke-RogueDhcpRemediation).Result`);
    expect(out.trim()).toBe('static-fallback');

    const staticIp = await ps("(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq '192.168.10.222' }).PrefixOrigin");
    expect(staticIp).toMatch(/Manual/);
  }, 40000);
});
