/**
 * Scénario 7 — Surveillance continue de la cohérence DNS et détection de
 * cache poisoning par script PowerShell planifié (Timer Task + journalisation
 * différentielle).
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

const DNS_SERVER = '192.168.20.10';

async function buildLab() {
  const router = new CiscoRouter('R1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  const win = new WindowsPC('windows-pc', 'WINPC');
  const dns = new LinuxServer('DNS1');
  win.setCurrentUser('Administrator');

  new Cable('c-r').connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('eth0')!);
  new Cable('c-w').connect(win.getPort('eth0')!, sw.getPort('eth1')!);
  new Cable('c-d').connect(dns.getPort('eth0')!, sw.getPort('eth2')!);

  router.configureInterface('GigabitEthernet0/0', new IPAddress('192.168.20.1'), new SubnetMask('255.255.255.0'));
  win.configureInterface('eth0', new IPAddress('192.168.20.50'), new SubnetMask('255.255.255.0'));
  win.setDefaultGateway(new IPAddress('192.168.20.1'));
  win.setDnsServers('eth0', [DNS_SERVER]);

  dns.configureInterface('eth0', new IPAddress(DNS_SERVER), new SubnetMask('255.255.255.0'));
  dns.dnsService.addRecord({ name: 'passerelle', type: 'A', value: '192.168.20.1', ttl: 3600 });
  dns.dnsService.addRecord({ name: 'serveur-interne', type: 'A', value: '192.168.20.20', ttl: 3600 });
  dns.dnsService.addRecord({ name: 'intranet', type: 'A', value: '192.168.20.30', ttl: 3600 });
  dns.dnsService.start();

  return { router, sw, win, dns };
}

function psShell(win: WindowsPC) {
  const { subShell } = PowerShellSubShell.create(win);
  return async (script: string) => (await subShell.processLine(script)).output.join('\n');
}

const BASELINE_SCRIPT = String.raw`
function Invoke-DnsBaselineInit {
  param(
    [string[]]$NomsCritiques = @('passerelle','serveur-interne','intranet'),
    [string]$DnsServer = '${DNS_SERVER}',
    [string]$BaselinePath = 'C:\dns-monitor\baseline-dns.json'
  )
  $entries = @()
  foreach ($nom in $NomsCritiques) {
    $r = Resolve-DnsName $nom -Type A -Server $DnsServer
    $premier = $r | Select-Object -First 1
    $entries += [PSCustomObject]@{
      Nom        = $nom
      Adresses   = @($r.IPAddress)
      TTL        = $premier.TTL
      Serveur    = $DnsServer
      Horodatage = (Get-Date).ToString('o')
    }
  }
  New-Item -ItemType Directory -Path (Split-Path $BaselinePath) -Force | Out-Null
  $entries | ConvertTo-Json -Depth 5 | Out-File -FilePath $BaselinePath
  $hash = (Get-FileHash -Path $BaselinePath -Algorithm SHA256).Hash
  Set-Content -Path "$BaselinePath.sha256" -Value $hash
  return $entries
}
`;

const MONITOR_SCRIPT = String.raw`
function Invoke-DnsMonitorCycle {
  param(
    [string]$BaselinePath = 'C:\dns-monitor\baseline-dns.json',
    [string]$StatePath = 'C:\dns-monitor\state.json',
    [string]$CsvPath = 'C:\dns-monitor\dns-drift.csv',
    [string]$DnsServer = '${DNS_SERVER}',
    [int]$TtlSeuilBas = 30
  )
  $src = 'DnsMonitorScript'
  New-EventLog -LogName Application -Source $src -ErrorAction SilentlyContinue

  $baseline = Get-Content $BaselinePath -Raw | ConvertFrom-Json
  $flaggedNoms = @()
  if (Test-Path $StatePath) {
    $prev = @(Get-Content $StatePath -Raw | ConvertFrom-Json)
    $flaggedNoms = @($prev.Nom)
  }

  $nouveauFlagged = @()
  foreach ($entry in $baseline) {
    $nom = $entry.Nom
    $attendues = @($entry.Adresses)
    $ecart = $null
    $localResult = $null
    $serveurResult = $null
    try { $localResult = @(Resolve-DnsName $nom -ErrorAction Stop) } catch { $localResult = @() }
    try { $serveurResult = @(Resolve-DnsName $nom -Server $DnsServer -ErrorAction Stop) } catch { $serveurResult = @() }
    $local = @($localResult.IPAddress)
    $serveur = @($serveurResult.IPAddress)
    $localDiff = @(Compare-Object -ReferenceObject $attendues -DifferenceObject $local).Count -gt 0
    $serveurDiff = @(Compare-Object -ReferenceObject $attendues -DifferenceObject $serveur).Count -gt 0

    if ($local.Count -eq 0 -and $serveur.Count -eq 0) {
      $ecart = 'NomIntrouvable'
    } elseif ($serveurDiff) {
      $ecart = 'AdresseModifieeServeur'
    } elseif ($localDiff) {
      $ecart = 'CachePoisoningLocal'
    } else {
      $ttlActuel = ($serveurResult | Select-Object -First 1).TTL
      if ($ttlActuel -lt $TtlSeuilBas) { $ecart = 'TTLAnormalementBas' }
    }

    if ($ecart) {
      $nouveauFlagged += [PSCustomObject]@{ Nom = $nom; Ecart = $ecart }
      $cache = Get-DnsClientCache -Name $nom -ErrorAction SilentlyContinue
      $msg = "Nom=$nom Type=$ecart AttenduIP=$($attendues -join ',') LocalIP=$($local -join ',') ServeurIP=$($serveur -join ',')"
      Write-EventLog -LogName Application -Source $src -EventId 3001 -EntryType Warning -Message $msg
      "$(Get-Date -Format o),$nom,$ecart,$($attendues -join '|'),$($local -join '|')" | Add-Content -Path $CsvPath
    } elseif ($flaggedNoms -contains $nom) {
      Write-EventLog -LogName Application -Source $src -EventId 3002 -EntryType Information -Message "Nom=$nom retour a la normale"
    }
  }

  $nouveauFlagged | ConvertTo-Json | Set-Content -Path $StatePath
}
`;

async function runCycle(win: WindowsPC): Promise<void> {
  const ps = psShell(win);
  await ps(`${MONITOR_SCRIPT}\nInvoke-DnsMonitorCycle | Out-Null`);
}

describe('Scénario 7 — constitution de la baseline', () => {
  it('Resolve-DnsName -Type A -Server constitue une baseline avec IP, TTL, serveur et horodatage', async () => {
    const { win } = await buildLab();
    const ps = psShell(win);

    await ps(`${BASELINE_SCRIPT}\nInvoke-DnsBaselineInit | Out-Null`);
    const out = await ps('Get-Content C:\\dns-monitor\\baseline-dns.json -Raw | ConvertFrom-Json | Where-Object { $_.Nom -eq "intranet" } | Format-List *');

    expect(out).toContain('192.168.20.30');
    expect(out).toMatch(/TTL\s*:\s*3600/);
    expect(out).toContain(DNS_SERVER);
    expect(out).toMatch(/Horodatage/);
  }, 20000);

  it('Get-FileHash -Algorithm SHA256 signe le fichier de baseline', async () => {
    const { win } = await buildLab();
    const ps = psShell(win);

    await ps(`${BASELINE_SCRIPT}\nInvoke-DnsBaselineInit | Out-Null`);
    const hashFromFile = (await ps('Get-Content C:\\dns-monitor\\baseline-dns.json.sha256')).trim();
    const recomputed = (await ps('(Get-FileHash -Path C:\\dns-monitor\\baseline-dns.json -Algorithm SHA256).Hash')).trim();

    expect(hashFromFile).toMatch(/^[0-9A-Fa-f]{64}$/);
    expect(hashFromFile).toBe(recomputed);
  }, 20000);

  it('une falsification du fichier de baseline change son empreinte SHA256', async () => {
    const { win } = await buildLab();
    const ps = psShell(win);

    await ps(`${BASELINE_SCRIPT}\nInvoke-DnsBaselineInit | Out-Null`);
    const before = (await ps('(Get-FileHash -Path C:\\dns-monitor\\baseline-dns.json -Algorithm SHA256).Hash')).trim();

    await ps('Add-Content -Path C:\\dns-monitor\\baseline-dns.json -Value "tampered"');
    const after = (await ps('(Get-FileHash -Path C:\\dns-monitor\\baseline-dns.json -Algorithm SHA256).Hash')).trim();

    expect(after).not.toBe(before);
  }, 20000);
});

describe('Scénario 7 — surveillance différentielle', () => {
  it('un cycle nominal ne détecte aucun écart', async () => {
    const { win } = await buildLab();
    const ps = psShell(win);
    await ps(`${BASELINE_SCRIPT}\nInvoke-DnsBaselineInit | Out-Null`);

    await runCycle(win);

    const out = await ps('(Get-EventLog -LogName Application -Source DnsMonitorScript -ErrorAction SilentlyContinue | Measure-Object).Count');
    expect(out.trim()).toBe('0');
  }, 30000);

  it('une adresse modifiée directement sur le serveur DNS est détectée comme AdresseModifieeServeur', async () => {
    const { win, dns } = await buildLab();
    const ps = psShell(win);
    await ps(`${BASELINE_SCRIPT}\nInvoke-DnsBaselineInit | Out-Null`);

    dns.dnsService.updateRecord({ name: 'intranet', type: 'A', value: '6.6.6.6', ttl: 3600 });

    await runCycle(win);

    const out = await ps("Get-EventLog -LogName Application -Source DnsMonitorScript | Where-Object { $_.EventID -eq 3001 } | Format-List Message");
    expect(out).toContain('AdresseModifieeServeur');
    expect(out).toContain('6.6.6.6');
  }, 30000);

  it('une entrée corrompue dans le fichier hosts local est détectée comme CachePoisoningLocal', async () => {
    const { win } = await buildLab();
    const ps = psShell(win);
    await ps(`${BASELINE_SCRIPT}\nInvoke-DnsBaselineInit | Out-Null`);

    await win.executeCommand('echo 6.6.6.6 intranet >> C:\\Windows\\System32\\drivers\\etc\\hosts');

    await runCycle(win);

    const out = await ps("Get-EventLog -LogName Application -Source DnsMonitorScript | Where-Object { $_.EventID -eq 3001 } | Format-List Message");
    expect(out).toContain('CachePoisoningLocal');
    expect(out).toMatch(/LocalIP=6\.6\.6\.6/);
    expect(out).toMatch(/ServeurIP=192\.168\.20\.30/);
  }, 30000);

  it('un nom qui ne résout plus est détecté comme NomIntrouvable', async () => {
    const { win, dns } = await buildLab();
    const ps = psShell(win);
    await ps(`${BASELINE_SCRIPT}\nInvoke-DnsBaselineInit | Out-Null`);

    await ps('Clear-DnsClientCache');
    dns.dnsService.stop();

    await runCycle(win);

    const out = await ps("Get-EventLog -LogName Application -Source DnsMonitorScript | Where-Object { $_.EventID -eq 3001 } | Format-List Message");
    expect(out).toContain('NomIntrouvable');
  }, 30000);

  it('un TTL anormalement bas est détecté (manipulation active du cache)', async () => {
    const { win, dns } = await buildLab();
    const ps = psShell(win);
    await ps(`${BASELINE_SCRIPT}\nInvoke-DnsBaselineInit | Out-Null`);

    dns.dnsService.updateRecord({ name: 'intranet', type: 'A', value: '192.168.20.30', ttl: 5 });

    await runCycle(win);

    const out = await ps("Get-EventLog -LogName Application -Source DnsMonitorScript | Where-Object { $_.EventID -eq 3001 } | Format-List Message");
    expect(out).toContain('TTLAnormalementBas');
  }, 30000);
});

describe('Scénario 7 — journalisation différentielle sans bruit', () => {
  it("un retour à la normale après une dérive émet un événement 3002 mais pas d'alerte parasite ensuite", async () => {
    const { win, dns } = await buildLab();
    const ps = psShell(win);
    await ps(`${BASELINE_SCRIPT}\nInvoke-DnsBaselineInit | Out-Null`);

    dns.dnsService.updateRecord({ name: 'intranet', type: 'A', value: '6.6.6.6', ttl: 3600 });
    await runCycle(win);

    dns.dnsService.updateRecord({ name: 'intranet', type: 'A', value: '192.168.20.30', ttl: 3600 });
    await ps('Clear-DnsClientCache');
    await runCycle(win);

    const retour = await ps("Get-EventLog -LogName Application -Source DnsMonitorScript | Where-Object { $_.EventID -eq 3002 } | Format-List Message");
    expect(retour).toContain('retour a la normale');

    await runCycle(win);
    await runCycle(win);

    const count3002 = await ps('(Get-EventLog -LogName Application -Source DnsMonitorScript | Where-Object { $_.EventID -eq 3002 } | Measure-Object).Count');
    expect(count3002.trim()).toBe('1');
  }, 40000);

  it("des cycles stables répétés ne produisent aucun événement supplémentaire", async () => {
    const { win } = await buildLab();
    const ps = psShell(win);
    await ps(`${BASELINE_SCRIPT}\nInvoke-DnsBaselineInit | Out-Null`);

    await runCycle(win);
    await runCycle(win);
    await runCycle(win);

    const out = await ps('(Get-EventLog -LogName Application -Source DnsMonitorScript -ErrorAction SilentlyContinue | Measure-Object).Count');
    expect(out.trim()).toBe('0');
  }, 40000);

  it('export CSV cumulatif des écarts horodatés', async () => {
    const { win, dns } = await buildLab();
    const ps = psShell(win);
    await ps(`${BASELINE_SCRIPT}\nInvoke-DnsBaselineInit | Out-Null`);

    dns.dnsService.updateRecord({ name: 'intranet', type: 'A', value: '6.6.6.6', ttl: 3600 });
    await runCycle(win);
    dns.dnsService.updateRecord({ name: 'serveur-interne', type: 'A', value: '7.7.7.7', ttl: 3600 });
    await runCycle(win);

    const csv = await ps('Get-Content C:\\dns-monitor\\dns-drift.csv');
    expect(csv).toContain('intranet');
    expect(csv).toContain('serveur-interne');
    expect(csv.trim().split('\n').length).toBeGreaterThanOrEqual(2);
  }, 40000);
});

describe('Scénario 7 — intégration avec le Planificateur de tâches', () => {
  it('Register-ScheduledTask crée une tâche récurrente toutes les 5 minutes sous SYSTEM avec RunLevel Highest', async () => {
    const { win } = await buildLab();
    const ps = psShell(win);
    await ps(`${BASELINE_SCRIPT}\nInvoke-DnsBaselineInit | Out-Null`);
    await ps(`Set-Content -Path C:\\dns-monitor\\monitor.ps1 -Value @'\n${MONITOR_SCRIPT}\nInvoke-DnsMonitorCycle\n'@`);

    await ps(String.raw`
      $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-File C:\dns-monitor\monitor.ps1'
      $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::MaxValue)
      $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
      Register-ScheduledTask -TaskName 'DNS-Monitor' -Action $action -Trigger $trigger -Principal $principal | Out-Null
    `);

    const state = (await ps('(Get-ScheduledTask -TaskName "DNS-Monitor").State')).trim();
    expect(state).toBe('Ready');
  }, 30000);

  it('la tâche planifiée exécute réellement le script de surveillance au tic suivant', async () => {
    const { win, dns } = await buildLab();
    const ps = psShell(win);
    await ps(`${BASELINE_SCRIPT}\nInvoke-DnsBaselineInit | Out-Null`);
    await ps(`Set-Content -Path C:\\dns-monitor\\monitor.ps1 -Value @'\n${MONITOR_SCRIPT}\nInvoke-DnsMonitorCycle\n'@`);
    await ps(String.raw`
      $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-File C:\dns-monitor\monitor.ps1'
      $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::MaxValue)
      $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
      Register-ScheduledTask -TaskName 'DNS-Monitor' -Action $action -Trigger $trigger -Principal $principal | Out-Null
    `);

    await win.executeCommand('echo 6.6.6.6 intranet >> C:\\Windows\\System32\\drivers\\etc\\hosts');
    win.advanceTime(5 * 60 * 1000 + 1000);

    const out = await ps("Get-EventLog -LogName Application -Source DnsMonitorScript -ErrorAction SilentlyContinue | Where-Object { $_.EventID -eq 3001 } | Format-List Message");
    expect(out).toContain('CachePoisoningLocal');
    expect(out).toContain('intranet');
  }, 30000);

  it('la tâche planifiée survit à un redémarrage du poste et reprend sa surveillance', async () => {
    const { win, dns } = await buildLab();
    const ps = psShell(win);
    await ps(`${BASELINE_SCRIPT}\nInvoke-DnsBaselineInit | Out-Null`);
    await ps(`Set-Content -Path C:\\dns-monitor\\monitor.ps1 -Value @'\n${MONITOR_SCRIPT}\nInvoke-DnsMonitorCycle\n'@`);
    await ps(String.raw`
      $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-File C:\dns-monitor\monitor.ps1'
      $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::MaxValue)
      $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
      Register-ScheduledTask -TaskName 'DNS-Monitor' -Action $action -Trigger $trigger -Principal $principal | Out-Null
    `);

    win.powerOff();
    win.powerOn();

    const state = (await ps('(Get-ScheduledTask -TaskName "DNS-Monitor").State')).trim();
    expect(state).toBe('Ready');

    dns.dnsService.updateRecord({ name: 'intranet', type: 'A', value: '6.6.6.6', ttl: 3600 });
    win.advanceTime(5 * 60 * 1000 + 1000);

    const out = await ps("(Get-EventLog -LogName Application -Source DnsMonitorScript -ErrorAction SilentlyContinue | Where-Object { $_.EventID -eq 3001 } | Measure-Object).Count");
    expect(Number(out.trim())).toBeGreaterThan(0);
  }, 30000);
});
