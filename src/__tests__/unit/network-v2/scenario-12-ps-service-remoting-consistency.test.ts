import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function buildLan() {
  const admin = new WindowsPC('windows-pc', 'ADMIN-PC', 0, 0);
  const win1 = new WindowsPC('windows-pc', 'PC-WIN-1', 0, 0);
  const win2 = new WindowsPC('windows-pc', 'PC-WIN-2', 0, 0);
  const win3 = new WindowsPC('windows-pc', 'PC-WIN-3', 0, 0);
  const sw = new GenericSwitch('switch', 'core-sw', 0, 0);
  [admin, win1, win2, win3].forEach((d, i) => new Cable(d.getPorts()[0], sw.getPorts()[i]));
  const mask = new SubnetMask('255.255.255.0');
  admin.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  win1.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  win2.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  win3.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);
  for (const pc of [admin, win1, win2, win3]) pc.setCurrentUser('Administrator');
  return { admin, win1, win2, win3, sw };
}

function createPS(pc: WindowsPC) {
  const sh = PowerShellSubShell.create(pc).subShell;
  return { execute: async (line: string) => (await sh.processLine(line)).output.join('\n') };
}

async function getServicePid(pc: WindowsPC, serviceName: string): Promise<number> {
  const out = await pc.executeCommand(`sc queryex ${serviceName}`);
  const m = /PID\s*:\s*(\d+)/.exec(out);
  return m ? Number(m[1]) : -1;
}

const SERVICE_NAME = 'AppClusterSvc';
const COLLECT_SCRIPT = `
$results = Invoke-Command -ComputerName @("PC-WIN-1","PC-WIN-2","PC-WIN-3") -ScriptBlock { Get-Service -Name "${SERVICE_NAME}" | Select-Object Name, Status, StartType }
$results | ForEach-Object { "$($_.PSComputerName)|$($_.Status)|$($_.StartType)" }
`;

const REMEDIATION_SCRIPT = `
$results = Invoke-Command -ComputerName @("PC-WIN-1","PC-WIN-2","PC-WIN-3") -ScriptBlock { Get-Service -Name "${SERVICE_NAME}" | Select-Object Name, Status, StartType }
$reference = @{ Status = "Running"; StartType = "Automatic" }
$machinesEnEcart = @()
foreach ($r in $results) {
  if ($r.Status -ne $reference.Status -or $r.StartType -ne $reference.StartType) {
    $machinesEnEcart += $r.PSComputerName
  }
}
Invoke-Command -ComputerName $machinesEnEcart -ArgumentList $env:COMPUTERNAME -ScriptBlock {
  param($AdminMachine)
  Set-Service -Name "${SERVICE_NAME}" -StartupType Automatic
  Start-Service -Name "${SERVICE_NAME}"
  Write-EventLog -LogName Application -Source "CentralAdmin" -EventId 7001 -EntryType Information -Message "Remediation applied by $AdminMachine"
}
$machinesEnEcart -join ','
`;

interface Scenario {
  admin: WindowsPC; win1: WindowsPC; win2: WindowsPC; win3: WindowsPC;
  psAdmin: ReturnType<typeof createPS>;
  psWin1: ReturnType<typeof createPS>;
  psWin2: ReturnType<typeof createPS>;
  psWin3: ReturnType<typeof createPS>;
}

/**
 * Three Windows machines host the same application-cluster service; two are
 * nominal (Running / Automatic) and one (PC-WIN-2) has drifted (Stopped /
 * Manual). Remoting is enabled everywhere except on the admin box itself,
 * so Test-WSMan has a genuine negative case.
 */
async function buildScenario(): Promise<Scenario> {
  const { admin, win1, win2, win3 } = buildLan();
  const psAdmin = createPS(admin);
  const psWin1 = createPS(win1);
  const psWin2 = createPS(win2);
  const psWin3 = createPS(win3);

  await psWin1.execute('Enable-PSRemoting');
  await psWin2.execute('Enable-PSRemoting');
  await psWin3.execute('Enable-PSRemoting');

  for (const ps of [psWin1, psWin2, psWin3]) {
    await ps.execute(
      `New-Service -Name "${SERVICE_NAME}" -BinaryPathName "C:\\Services\\${SERVICE_NAME}.exe" -DisplayName "App Cluster Service" -StartupType Automatic`,
    );
    await ps.execute(`Start-Service -Name ${SERVICE_NAME}`);
  }

  // Deliberate drift on PC-WIN-2: stopped + startup type changed.
  await psWin2.execute(`Stop-Service -Name ${SERVICE_NAME}`);
  await psWin2.execute(`Set-Service -Name ${SERVICE_NAME} -StartupType Manual`);

  return { admin, win1, win2, win3, psAdmin, psWin1, psWin2, psWin3 };
}

describe('Scénario 5 — Gestion des services multi-machines via PowerShell Remoting', () => {
  describe('Collecte d\'état distribuée (Invoke-Command -ComputerName / -AsJob)', () => {
    it('reflète l\'état RÉEL de chaque machine (pas un no-op local) — les 3 diffèrent selon leur drift', async () => {
      const { psAdmin } = await buildScenario();

      const out = await psAdmin.execute(COLLECT_SCRIPT);
      const lines = out.split('\n').filter(Boolean);
      expect(lines).toHaveLength(3);

      const byMachine: Record<string, { status: string; start: string }> = {};
      for (const line of lines) {
        const [machine, status, start] = line.split('|');
        byMachine[machine] = { status, start };
      }
      expect(byMachine['PC-WIN-1']).toEqual({ status: 'Running', start: 'Automatic' });
      expect(byMachine['PC-WIN-2']).toEqual({ status: 'Stopped', start: 'Manual' });
      expect(byMachine['PC-WIN-3']).toEqual({ status: 'Running', start: 'Automatic' });
    });

    it('-AsJob + Receive-Job renvoie les mêmes données consolidées', async () => {
      const { psAdmin } = await buildScenario();

      const jobScript = `
$job = Invoke-Command -ComputerName @("PC-WIN-1","PC-WIN-2","PC-WIN-3") -ScriptBlock { Get-Service -Name "${SERVICE_NAME}" | Select-Object Name, Status, StartType } -AsJob
$jobResults = Receive-Job -Job $job -Wait
$jobResults | ForEach-Object { "$($_.PSComputerName)|$($_.Status)|$($_.StartType)" }
`;
      const jobOut = await psAdmin.execute(jobScript);
      const jobLines = jobOut.split('\n').filter(Boolean).sort();

      const directOut = await psAdmin.execute(COLLECT_SCRIPT);
      const directLines = directOut.split('\n').filter(Boolean).sort();

      expect(jobLines).toEqual(directLines);
      expect(jobLines).toHaveLength(3);
    });
  });

  describe('Détection des incohérences', () => {
    it('identifie exactement quelle machine et quelle(s) propriété(s) ont dérivé', async () => {
      const { psAdmin } = await buildScenario();

      const script = `
$results = Invoke-Command -ComputerName @("PC-WIN-1","PC-WIN-2","PC-WIN-3") -ScriptBlock { Get-Service -Name "${SERVICE_NAME}" | Select-Object Name, Status, StartType }
$reference = @{ Status = "Running"; StartType = "Automatic" }
$drift = @()
foreach ($r in $results) {
  $badProps = @()
  if ($r.Status -ne $reference.Status) { $badProps += "Status" }
  if ($r.StartType -ne $reference.StartType) { $badProps += "StartType" }
  if ($badProps.Count -gt 0) {
    $drift += "$($r.PSComputerName):$($badProps -join ',')"
  }
}
$drift
`;
      const out = await psAdmin.execute(script);
      const lines = out.split('\n').filter(Boolean);
      expect(lines).toEqual(['PC-WIN-2:Status,StartType']);
    });
  });

  describe('Remédiation ciblée', () => {
    it('corrige uniquement la (les) machine(s) en écart, sans jamais toucher les machines nominales', async () => {
      const { win1, win3, psAdmin } = await buildScenario();

      const pidBefore1 = await getServicePid(win1, SERVICE_NAME);
      const pidBefore3 = await getServicePid(win3, SERVICE_NAME);
      expect(pidBefore1).toBeGreaterThan(0);
      expect(pidBefore3).toBeGreaterThan(0);

      const out = await psAdmin.execute(REMEDIATION_SCRIPT);
      expect(out.trim()).toBe('PC-WIN-2');

      const verifyOut = await psAdmin.execute(COLLECT_SCRIPT);
      const verifyLines = verifyOut.split('\n').filter(Boolean);
      expect(verifyLines).toContain('PC-WIN-1|Running|Automatic');
      expect(verifyLines).toContain('PC-WIN-2|Running|Automatic');
      expect(verifyLines).toContain('PC-WIN-3|Running|Automatic');

      // Nominal machines were never restarted — their service PID is unchanged.
      const pidAfter1 = await getServicePid(win1, SERVICE_NAME);
      const pidAfter3 = await getServicePid(win3, SERVICE_NAME);
      expect(pidAfter1).toBe(pidBefore1);
      expect(pidAfter3).toBe(pidBefore3);
    });
  });

  describe('Journalisation centralisée', () => {
    it('EventId 7001 (Application, source CentralAdmin) apparaît UNIQUEMENT sur la machine corrigée, nommant la machine admin', async () => {
      const { psAdmin, psWin1, psWin2 } = await buildScenario();

      await psAdmin.execute(REMEDIATION_SCRIPT);

      const win2Log = await psWin2.execute(
        `Get-WinEvent -LogName Application | Where-Object { $_.Id -eq 7001 } | Select-Object -First 1`,
      );
      expect(win2Log).toContain('7001');
      expect(win2Log).toContain('ADMIN-PC');
      expect(win2Log.toLowerCase()).toContain('remediation applied by');

      const win1Log = await psWin1.execute(
        `Get-WinEvent -LogName Application | Where-Object { $_.Id -eq 7001 }`,
      );
      expect(win1Log.trim()).toBe('');
    });
  });

  describe('Sécurité du Remoting', () => {
    it('Test-WSMan réussit seulement là où Enable-PSRemoting a été exécuté', async () => {
      const { psAdmin } = await buildScenario();

      const okOut = await psAdmin.execute('Test-WSMan -ComputerName PC-WIN-1');
      expect(okOut).not.toContain('ERROR');
      expect(okOut).toMatch(/wsmid|ProtocolVersion/i);

      const failOut = await psAdmin.execute('Test-WSMan -ComputerName ADMIN-PC');
      expect(failOut).toMatch(/WinRM cannot complete the operation/i);
    });

    it('Get-WSManCredSSP rapporte CredSSP désactivé par défaut (pas de risque de délégation)', async () => {
      const { psAdmin } = await buildScenario();

      const out = await psAdmin.execute('Get-WSManCredSSP');
      expect(out.toLowerCase()).toContain('not configured');
    });
  });
});
