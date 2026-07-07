/**
 * Scénario 4 — Diagnostic automatisé de la chaîne DHCP→DNS par script PowerShell.
 *
 * Un script PowerShell audite de façon autonome la cohérence de toute la
 * configuration réseau obtenue via DHCP (adresse, passerelle, DNS, bail
 * résiduel) et détecte proactivement les incohérences avant qu'elles ne
 * causent une panne de résolution, en exploitant les cmdlets réseau natives
 * (Get-NetIPConfiguration, Get-NetIPAddress, Get-DnsClientServerAddress,
 * Resolve-DnsName, Test-NetConnection, Measure-Command) et produit un rapport
 * structuré (PSCustomObject → JSON / CSV) exploitable par un superviseur.
 *
 * On exécute le script dans trois états successifs du poste :
 *   1. configuration saine
 *   2. bail dont la durée résiduelle passe sous le seuil d'alerte
 *   3. serveur DNS communiqué par DHCP injoignable au niveau réseau
 * et on vérifie la classification OK / AVERTISSEMENT / CRITIQUE sans faux
 * positif ni faux négatif, ainsi que la distinction explicite entre un DNS
 * injoignable (réseau) et un DNS joignable mais ne résolvant pas (NXDOMAIN).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

interface LabOptions {
  leaseCmd?: string;        // Cisco `lease ...` clause (default 8 days)
  dnsServerIp?: string;     // option 6 advertised by DHCP
  dnsReachable?: boolean;   // cable the real DNS box or leave the advertised IP a black hole
}

async function buildLab(opts: LabOptions = {}) {
  const leaseCmd = opts.leaseCmd ?? 'lease 8';
  const dnsServerIp = opts.dnsServerIp ?? '192.168.1.10';
  const dnsReachable = opts.dnsReachable ?? true;

  const router = new CiscoRouter('R1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  const win = new WindowsPC('windows-pc', 'WINPC');
  const dns = new LinuxServer('linux-server', 'DNS1');
  win.setCurrentUser('Administrator');

  new Cable('c-r').connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('eth0')!);
  new Cable('c-w').connect(win.getPort('eth0')!, sw.getPort('eth1')!);
  if (dnsReachable) {
    new Cable('c-d').connect(dns.getPort('eth0')!, sw.getPort('eth2')!);
  }

  router.configureInterface('GigabitEthernet0/0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
  dns.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));

  for (const cmd of [
    'enable', 'configure terminal',
    'service dhcp',
    'ip dhcp pool LAN',
    'network 192.168.1.0 255.255.255.0',
    'default-router 192.168.1.1',
    `dns-server ${dnsServerIp}`,
    'domain-name lab.local',
    leaseCmd,
    'exit',
    'ip dhcp excluded-address 192.168.1.1 192.168.1.20',
    'end',
  ]) await router.executeCommand(cmd);

  dns.dnsService.addRecord({ name: 'appserver', type: 'A', value: '192.168.1.88', ttl: 3600 });
  dns.dnsService.addRecord({ name: 'appserver.lab.local', type: 'A', value: '192.168.1.88', ttl: 3600 });
  dns.dnsService.start();

  return { router, sw, win, dns };
}

function psShell(win: WindowsPC) {
  const { subShell } = PowerShellSubShell.create(win);
  return async (script: string) => (await subShell.processLine(script)).output.join('\n');
}

// The audit script under test — the very kind of proactive diagnostic a
// supervision tool would schedule. It returns a JSON array (one object per
// active IPv4 interface) plus a global status, so the test can parse it back.
const AUDIT_SCRIPT = String.raw`
function Invoke-NetworkAudit {
  param([int]$LeaseWarningSeconds = 14400, [string]$Probe = "appserver")
  $report = @()
  $addrs = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -ne 'Loopback Pseudo-Interface 1' }
  foreach ($a in $addrs) {
    $origin = $a.PrefixOrigin
    $isApipa = $a.IPAddress -like '169.254.*'
    $lease = 0
    if ($a.ValidLifetime) { $lease = [int]$a.ValidLifetime.TotalSeconds }
    $dnsList = (Get-DnsClientServerAddress -InterfaceAlias $a.InterfaceAlias).ServerAddresses
    $dnsPrimary = ''
    if ($dnsList.Count -gt 0) { $dnsPrimary = $dnsList[0] }
    $reachable = $false
    $resolves = $false
    $failKind = 'None'
    if ($dnsPrimary -ne '') {
      $tnc = Test-NetConnection -ComputerName $dnsPrimary -Port 53
      $reachable = $tnc.TcpTestSucceeded
      try {
        $r = Resolve-DnsName $Probe -Server $dnsPrimary -ErrorAction Stop
        if ($r) { $resolves = $true }
      } catch { $resolves = $false }
      if (-not $reachable) { $failKind = 'ServerUnreachable' }
      elseif (-not $resolves) { $failKind = 'NameError' }
    }
    $status = 'OK'
    if ($isApipa) { $status = 'CRITICAL' }
    elseif ($failKind -eq 'ServerUnreachable') { $status = 'CRITICAL' }
    elseif ($failKind -eq 'NameError') { $status = 'WARNING' }
    elseif ($origin -eq 'Dhcp' -and $lease -gt 0 -and $lease -lt $LeaseWarningSeconds) { $status = 'WARNING' }
    $report += [PSCustomObject]@{
      InterfaceAlias        = $a.InterfaceAlias
      IPAddress             = $a.IPAddress
      Origin                = $origin
      IsApipa               = $isApipa
      LeaseRemainingSeconds = $lease
      DnsServers            = $dnsList
      DnsReachable          = $reachable
      DnsResolves           = $resolves
      DnsFailureKind        = $failKind
      Status                = $status
    }
  }
  return $report
}
`;

async function runAudit(win: WindowsPC, args = ''): Promise<any[]> {
  const ps = psShell(win);
  const out = await ps(`${AUDIT_SCRIPT}\n$rep = Invoke-NetworkAudit ${args}\n$rep | ConvertTo-Json -Depth 5`);
  const start = out.indexOf('[') >= 0 && (out.indexOf('[') < out.indexOf('{') || out.indexOf('{') < 0)
    ? out.indexOf('[') : out.indexOf('{');
  const json = out.slice(start).trim();
  const parsed = JSON.parse(json);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// ─── Point de contrôle 1 : collecte de configuration ────────────────────────

describe('Scénario 4 — collecte de configuration réseau', () => {
  it('Get-NetIPConfiguration retourne IP, passerelle et serveurs DNS de l\'interface active', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const out = await ps('Get-NetIPConfiguration | Where-Object { $_.IPv4Address -ne "" } | Format-List *');

    expect(out).toContain('192.168.1.21');
    expect(out).toContain('192.168.1.1');
    expect(out).toContain('192.168.1.10');
  }, 20000);

  it('Get-NetIPAddress marque une adresse DHCP avec PrefixOrigin Dhcp', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const out = await ps("Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -eq 'Dhcp' } | Format-List IPAddress,PrefixOrigin,SuffixOrigin");

    expect(out).toContain('192.168.1.21');
    expect(out).toMatch(/PrefixOrigin\s*:\s*Dhcp/);
  }, 20000);

  it('Get-NetIPAddress marque une adresse statique avec PrefixOrigin Manual', async () => {
    const { win } = await buildLab();
    await win.executeCommand('netsh interface ip set address "Ethernet 0" static 192.168.1.50 255.255.255.0 192.168.1.1');
    const ps = psShell(win);

    const out = await ps("Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq '192.168.1.50' } | Format-List IPAddress,PrefixOrigin");

    expect(out).toContain('192.168.1.50');
    expect(out).toMatch(/PrefixOrigin\s*:\s*Manual/);
  }, 20000);

  it('Get-NetIPAddress marque une adresse APIPA avec PrefixOrigin WellKnown / SuffixOrigin Link', async () => {
    // DHCP activé mais aucun serveur joignable → repli APIPA (RFC 3927).
    const win = new WindowsPC('windows-pc', 'ISOPC');
    win.setCurrentUser('Administrator');

    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const out = await ps("Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '169.254.*' } | Format-List IPAddress,PrefixOrigin,SuffixOrigin");

    expect(out).toMatch(/169\.254\./);
    expect(out).toMatch(/PrefixOrigin\s*:\s*WellKnown/);
    expect(out).toMatch(/SuffixOrigin\s*:\s*Link/);
  }, 20000);

  it('Get-DnsClientServerAddress confirme le serveur DNS de l\'option DHCP 6', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const out = await ps("(Get-DnsClientServerAddress -InterfaceAlias 'eth0').ServerAddresses");

    expect(out).toContain('192.168.1.10');
  }, 20000);
});

// ─── Point de contrôle 2 : vérification active de la résolution ─────────────

describe('Scénario 4 — vérification active de la résolution', () => {
  it('Resolve-DnsName -Server force la résolution vers le DNS du bail et concorde avec la résolution système', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const forced = await ps('(Resolve-DnsName appserver -Server 192.168.1.10).IPAddress');
    const system = await ps('(Resolve-DnsName appserver).IPAddress');

    expect(forced).toContain('192.168.1.88');
    expect(system).toContain('192.168.1.88');
  }, 20000);

  it('Measure-Command chronomètre la résolution DNS', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const out = await ps('(Measure-Command { Resolve-DnsName appserver }).TotalMilliseconds');

    expect(out.trim()).toMatch(/^\d+(\.\d+)?$/);
    expect(Number(out.trim())).toBeGreaterThanOrEqual(0);
  }, 20000);

  it('Test-NetConnection -Port 53 réussit quand le DNS est joignable', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const out = await ps('(Test-NetConnection -ComputerName 192.168.1.10 -Port 53).TcpTestSucceeded');

    expect(out.trim()).toBe('True');
  }, 20000);
});

// ─── Point de contrôle 3 & 4 : détection d'anomalies + rapport structuré ────

describe('Scénario 4 — audit complet dans les trois états du poste', () => {
  it('état 1 — configuration saine → OK sans anomalie', async () => {
    const { win } = await buildLab({ leaseCmd: 'lease 8' });
    await win.executeCommand('ipconfig /renew');

    const report = await runAudit(win, '-LeaseWarningSeconds 14400 -Probe appserver');
    const eth0 = report.find(r => r.InterfaceAlias === 'eth0');

    expect(eth0).toBeDefined();
    expect(eth0.Origin).toBe('Dhcp');
    expect(eth0.DnsReachable).toBe(true);
    expect(eth0.DnsResolves).toBe(true);
    expect(eth0.DnsFailureKind).toBe('None');
    expect(eth0.Status).toBe('OK');
  }, 30000);

  it('état 2 — bail résiduel sous le seuil → AVERTISSEMENT sans fausse alerte DNS', async () => {
    const { win } = await buildLab({ leaseCmd: 'lease 0 2' }); // 2 heures
    await win.executeCommand('ipconfig /renew');

    const report = await runAudit(win, '-LeaseWarningSeconds 14400 -Probe appserver'); // seuil 4 h
    const eth0 = report.find(r => r.InterfaceAlias === 'eth0');

    expect(eth0.Origin).toBe('Dhcp');
    expect(eth0.LeaseRemainingSeconds).toBeGreaterThan(0);
    expect(eth0.LeaseRemainingSeconds).toBeLessThan(14400);
    expect(eth0.DnsReachable).toBe(true);
    expect(eth0.Status).toBe('WARNING');
  }, 30000);

  it('état 3 — serveur DNS du bail injoignable → CRITIQUE avec cause ServerUnreachable', async () => {
    const { win } = await buildLab({ dnsServerIp: '192.168.1.200', dnsReachable: false });
    await win.executeCommand('ipconfig /renew');

    const report = await runAudit(win, '-LeaseWarningSeconds 14400 -Probe appserver');
    const eth0 = report.find(r => r.InterfaceAlias === 'eth0');

    expect(eth0.DnsReachable).toBe(false);
    expect(eth0.DnsFailureKind).toBe('ServerUnreachable');
    expect(eth0.Status).toBe('CRITICAL');
  }, 30000);

  it('distinction explicite — DNS joignable mais nom introuvable → NameError, pas ServerUnreachable', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');

    const report = await runAudit(win, '-LeaseWarningSeconds 14400 -Probe absent.lab.local');
    const eth0 = report.find(r => r.InterfaceAlias === 'eth0');

    expect(eth0.DnsReachable).toBe(true);
    expect(eth0.DnsResolves).toBe(false);
    expect(eth0.DnsFailureKind).toBe('NameError');
  }, 30000);

  it('rapport structuré exportable en JSON exploitable sans post-traitement', async () => {
    const { win } = await buildLab({ leaseCmd: 'lease 8' });
    await win.executeCommand('ipconfig /renew');

    const report = await runAudit(win, '-LeaseWarningSeconds 14400 -Probe appserver');
    const eth0 = report.find(r => r.InterfaceAlias === 'eth0');

    for (const key of ['InterfaceAlias', 'IPAddress', 'Origin', 'LeaseRemainingSeconds', 'DnsReachable', 'DnsFailureKind', 'Status']) {
      expect(eth0).toHaveProperty(key);
    }
  }, 30000);

  it('rapport exportable en CSV via Export-Csv', async () => {
    const { win } = await buildLab({ leaseCmd: 'lease 8' });
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    await ps(`${AUDIT_SCRIPT}\nInvoke-NetworkAudit -Probe appserver | Export-Csv -Path C:\\audit.csv -NoTypeInformation`);
    const csv = await ps('Get-Content C:\\audit.csv');

    expect(csv).toContain('InterfaceAlias');
    expect(csv).toContain('Status');
    expect(csv).toContain('eth0');
  }, 30000);
});
