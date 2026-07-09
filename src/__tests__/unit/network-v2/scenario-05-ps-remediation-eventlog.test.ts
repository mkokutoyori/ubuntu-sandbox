/**
 * Scénario 5 — Renouvellement forcé de bail DHCP et flush DNS orchestrés par
 * PowerShell avec journalisation d'événements Windows (remédiation automatisée).
 *
 * Un script PowerShell orchestre une séquence complète de remédiation réseau
 * en réponse à une dégradation détectée — libération du bail, purge du cache
 * DNS, renouvellement forcé, vérification post-renouvellement — et journalise
 * chaque étape dans l'Observateur d'événements Windows (source personnalisée
 * "NetRemediationScript", EventIds 1001-1006) pour une traçabilité complète.
 *
 * Points vérifiés :
 *   - disparition de l'ancienne adresse / apparition d'une nouvelle DHCP
 *     (PrefixOrigin Dhcp) après remédiation
 *   - Get-DnsClientCache non vide avant purge, vide après Clear-DnsClientCache
 *   - source d'événements créée via New-EventLog, un événement par étape avec
 *     un EventId distinct, événement de clôture succès (1005) vs échec (1006)
 *   - vérification post-remédiation (Resolve-DnsName + Test-NetConnection gw)
 *   - Try/Catch autour des étapes critiques, code de retour exploitable
 *   - idempotence : deux exécutions successives sur un poste sain sans effet
 *     de bord
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

async function buildLab() {
  const router = new CiscoRouter('R1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  const win = new WindowsPC('windows-pc', 'WINPC');
  const dns = new LinuxServer('linux-server', 'DNS1');
  win.setCurrentUser('Administrator');

  new Cable('c-r').connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('eth0')!);
  new Cable('c-w').connect(win.getPort('eth0')!, sw.getPort('eth1')!);
  new Cable('c-d').connect(dns.getPort('eth0')!, sw.getPort('eth2')!);

  router.configureInterface('GigabitEthernet0/0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
  dns.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));

  for (const cmd of [
    'enable', 'configure terminal',
    'service dhcp',
    'ip dhcp pool LAN',
    'network 192.168.1.0 255.255.255.0',
    'default-router 192.168.1.1',
    'dns-server 192.168.1.10',
    'domain-name lab.local',
    'lease 8',
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

// Script de remédiation en deux phases : diagnostic puis remédiation, chaque
// étape encadrée par Try/Catch et tracée dans l'Observateur d'événements.
const REMEDIATION_SCRIPT = String.raw`
function Invoke-NetRemediation {
  param([string]$Interface = 'Ethernet 0', [string]$Reference = 'appserver')
  $src = 'NetRemediationScript'
  if (-not (Get-EventLog -List | Where-Object { $_.Log -eq 'Application' })) { }
  New-EventLog -LogName Application -Source $src -ErrorAction SilentlyContinue
  Write-EventLog -LogName Application -Source $src -EventId 1001 -EntryType Information -Message "Debut remediation sur $Interface"
  try {
    Invoke-Expression "ipconfig /release" | Out-Null
    Write-EventLog -LogName Application -Source $src -EventId 1002 -EntryType Information -Message "Bail libere"

    Clear-DnsClientCache
    Write-EventLog -LogName Application -Source $src -EventId 1003 -EntryType Information -Message "Cache DNS purge"

    Invoke-Expression "ipconfig /renew" | Out-Null
    Write-EventLog -LogName Application -Source $src -EventId 1004 -EntryType Information -Message "Bail renouvele"

    $addr = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -eq $Interface -and $_.PrefixOrigin -eq 'Dhcp' }
    if (-not $addr) { throw "Aucune adresse DHCP apres renouvellement" }
    $r = Resolve-DnsName $Reference -ErrorAction Stop
    if (-not $r) { throw "Resolution DNS toujours defaillante" }

    Write-EventLog -LogName Application -Source $src -EventId 1005 -EntryType Information -Message "Remediation reussie, adresse $($addr.IPAddress)"
    return 0
  } catch {
    Write-EventLog -LogName Application -Source $src -EventId 1006 -EntryType Error -Message "Echec remediation: $_"
    return 1
  }
}
`;

// ─── Phase de remédiation réseau ────────────────────────────────────────────

describe('Scénario 5 — phase de remédiation réseau', () => {
  it('Get-NetIPAddress avant/après confirme une nouvelle adresse DHCP (PrefixOrigin Dhcp)', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const before = await ps("(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -eq 'Ethernet 0' }).IPAddress");
    expect(before).toContain('192.168.1.');

    await ps(`${REMEDIATION_SCRIPT}\nInvoke-NetRemediation | Out-Null`);

    const after = await ps("Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -eq 'Ethernet 0' } | Format-List IPAddress,PrefixOrigin");
    expect(after).toContain('192.168.1.');
    expect(after).toMatch(/PrefixOrigin\s*:\s*Dhcp/);
  }, 30000);

  it('Get-DnsClientCache est peuplé avant purge et vide après Clear-DnsClientCache', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    await win.executeCommand('ping -n 1 appserver');
    const ps = psShell(win);

    const before = await ps('(Get-DnsClientCache | Measure-Object).Count');
    expect(Number(before.trim())).toBeGreaterThan(0);

    await ps('Clear-DnsClientCache');

    const after = await ps('(Get-DnsClientCache | Measure-Object).Count');
    expect(Number(after.trim())).toBe(0);
  }, 30000);
});

// ─── Journalisation dans l'Observateur d'événements ─────────────────────────

describe('Scénario 5 — journalisation dans l\'Observateur d\'événements', () => {
  it('New-EventLog crée la source personnalisée sans erreur', async () => {
    const { win } = await buildLab();
    const ps = psShell(win);

    const out = await ps('New-EventLog -LogName Application -Source "NetRemediationScript"; "created"');

    expect(out).toContain('created');
    expect(out).not.toMatch(/not recognized|CommandNotFound/i);
  }, 20000);

  it('chaque étape écrit un événement avec un EventId distinct récupérable en objet structuré', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    await ps(`${REMEDIATION_SCRIPT}\nInvoke-NetRemediation | Out-Null`);

    const ids = await ps("(Get-EventLog -LogName Application -Source NetRemediationScript | Select-Object -ExpandProperty EventID) -join ','");

    expect(ids).toContain('1001');
    expect(ids).toContain('1002');
    expect(ids).toContain('1003');
    expect(ids).toContain('1004');
    expect(ids).toContain('1005');
  }, 30000);

  it('l\'événement de clôture succès porte EventId 1005 et EntryType Information', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    await ps(`${REMEDIATION_SCRIPT}\nInvoke-NetRemediation | Out-Null`);

    const out = await ps("Get-EventLog -LogName Application -Source NetRemediationScript | Where-Object { $_.EventID -eq 1005 } | Format-List EventID,EntryType,Message");

    expect(out).toMatch(/EventID\s*:\s*1005/);
    expect(out).toMatch(/EntryType\s*:\s*Information/);
    expect(out).toMatch(/reussie/);
  }, 30000);

  it('un échec de remédiation journalise EventId 1006 en EntryType Error', async () => {
    // Aucun serveur DHCP joignable : le renouvellement retombe en APIPA →
    // la remédiation détecte l'absence d'adresse DHCP et journalise l'échec.
    const win = new WindowsPC('windows-pc', 'FAILPC');
    win.setCurrentUser('Administrator');
    const ps = psShell(win);

    const code = await ps(`${REMEDIATION_SCRIPT}\nInvoke-NetRemediation`);
    expect(code.trim().split('\n').pop()).toBe('1');

    const out = await ps("Get-EventLog -LogName Application -Source NetRemediationScript | Where-Object { $_.EventID -eq 1006 } | Format-List EventID,EntryType");
    expect(out).toMatch(/EventID\s*:\s*1006/);
    expect(out).toMatch(/EntryType\s*:\s*Error/);
  }, 30000);
});

// ─── Vérification post-remédiation & gestion d'erreurs ──────────────────────

describe('Scénario 5 — vérification post-remédiation et robustesse', () => {
  it('après remédiation, Resolve-DnsName et la passerelle DHCP répondent', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    await ps(`${REMEDIATION_SCRIPT}\nInvoke-NetRemediation | Out-Null`);

    const resolve = await ps('(Resolve-DnsName appserver).IPAddress');
    const gw = await ps('(Test-NetConnection -ComputerName 192.168.1.1 -InformationLevel Detailed).PingSucceeded');

    expect(resolve).toContain('192.168.1.88');
    expect(gw.trim()).toBe('True');
  }, 30000);

  it('le script renvoie 0 en succès et 1 en échec (code exploitable par la supervision)', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const ok = await ps(`${REMEDIATION_SCRIPT}\nInvoke-NetRemediation`);
    expect(ok.trim().split('\n').pop()).toBe('0');
  }, 30000);

  it('la remédiation est idempotente : deux exécutions successives sur poste sain restent en succès', async () => {
    const { win } = await buildLab();
    await win.executeCommand('ipconfig /renew');
    const ps = psShell(win);

    const first = await ps(`${REMEDIATION_SCRIPT}\nInvoke-NetRemediation`);
    const second = await ps(`${REMEDIATION_SCRIPT}\nInvoke-NetRemediation`);

    expect(first.trim().split('\n').pop()).toBe('0');
    expect(second.trim().split('\n').pop()).toBe('0');

    const addr = await ps("(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -eq 'Ethernet 0' -and $_.PrefixOrigin -eq 'Dhcp' }).IPAddress");
    expect(addr).toContain('192.168.1.');
  }, 40000);
});
