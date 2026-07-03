import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function createPC(name = 'WIN-PC1'): WindowsPC {
  const pc = new WindowsPC('windows-pc', name);
  pc.setCurrentUser('Administrator');
  return pc;
}

function createPS(pc: WindowsPC) {
  const sh = PowerShellSubShell.create(pc).subShell;
  return {
    execute: async (line: string): Promise<string> => {
      const r = await sh.processLine(line);
      return r.output.join('\n');
    },
  };
}

const NOTIFY_SCRIPT = String.raw`
$evtLog = "Application"
if (-not (Test-Path "C:\Scripts")) { New-Item -ItemType Directory -Path "C:\Scripts" | Out-Null }
Write-EventLog -LogName $evtLog -Source "notify-failure" -EventId 9001 -EntryType Warning -Message "MonSuperService recovery notification script executed."
`;

async function setupServiceWithRecovery(pc: WindowsPC): Promise<{ execute: (l: string) => Promise<string> }> {
  const ps = createPS(pc);
  await ps.execute(
    'New-Service -Name "MonSuperService" -BinaryPathName "C:\\Services\\MonSuperService.exe" -DisplayName "Mon Super Service" -StartupType Automatic',
  );
  await ps.execute('Start-Service -Name MonSuperService');

  if (!pc.getFileSystem().exists('C:\\Scripts')) {
    pc.getFileSystem().mkdirp('C:\\Scripts');
  }
  pc.getFileSystem().createFile('C:\\Scripts\\notify-failure.ps1', NOTIFY_SCRIPT);

  await pc.executeCommand(
    'sc failure MonSuperService reset= 60 actions= restart/10000/run/20000/reboot/30000 command= "powershell.exe -File C:\\Scripts\\notify-failure.ps1"',
  );
  return ps;
}

async function getServicePid(pc: WindowsPC, serviceName: string): Promise<number> {
  const out = await pc.executeCommand(`sc queryex ${serviceName}`);
  const m = /PID\s*:\s*(\d+)/.exec(out);
  return m ? Number(m[1]) : -1;
}

describe('Scénario 2 — Récupération automatique après échec et audit PowerShell (Recovery Actions)', () => {
  describe('Configuration des Recovery Actions', () => {
    it('sc.exe failure configure les trois niveaux, sc.exe qfailure confirme', async () => {
      const pc = createPC();
      await setupServiceWithRecovery(pc);

      const out = await pc.executeCommand('sc qfailure MonSuperService');
      expect(out).toContain('RESET_PERIOD (in seconds)');
      expect(out).toContain('60');
      expect(out).toMatch(/RESTART.*Delay = 10000/);
      expect(out).toMatch(/RUN.*Delay = 20000/i);
      expect(out).toMatch(/REBOOT.*Delay = 30000/);
      expect(out).toContain('notify-failure.ps1');
    });
  });

  describe('Comportement par rang d\'échec', () => {
    it('premier échec: redémarrage automatique après 10 secondes (nouveau PID + EventId 7036)', async () => {
      const pc = createPC();
      const ps = await setupServiceWithRecovery(pc);

      const pidBefore = await getServicePid(pc, 'MonSuperService');
      expect(pidBefore).toBeGreaterThan(0);

      await pc.executeCommand(`taskkill /F /PID ${pidBefore}`);

      const crashedOut = await ps.execute(
        'Get-WinEvent -LogName System | Where-Object { $_.Id -eq 7034 } | Select-Object -First 1',
      );
      // Real SCM 7034 messages name the service by its DisplayName, not the
      // short `sc` key.
      expect(crashedOut).toContain('Mon Super Service');

      pc.advanceTime(9_000);
      const statusMid = (await ps.execute('(Get-Service -Name MonSuperService).Status')).trim();
      expect(statusMid).toBe('Stopped');

      pc.advanceTime(2_000);
      const statusAfter = (await ps.execute('(Get-Service -Name MonSuperService).Status')).trim();
      expect(statusAfter).toBe('Running');

      const pidAfter = await getServicePid(pc, 'MonSuperService');
      expect(pidAfter).toBeGreaterThan(0);
      expect(pidAfter).not.toBe(pidBefore);

      const restartOut = await ps.execute(
        'Get-WinEvent -LogName System | Where-Object { $_.Id -eq 7036 -and $_.Message -like "*Mon Super Service*" } | Select-Object -First 1',
      );
      expect(restartOut.toLowerCase()).toContain('running');
    });

    it('deuxième échec (dans la fenêtre reset): exécution du script de notification', async () => {
      const pc = createPC();
      const ps = await setupServiceWithRecovery(pc);

      const pid1 = await getServicePid(pc, 'MonSuperService');
      await pc.executeCommand(`taskkill /F /PID ${pid1}`);
      pc.advanceTime(10_000);

      const pid2 = await getServicePid(pc, 'MonSuperService');
      expect(pid2).toBeGreaterThan(0);
      await pc.executeCommand(`taskkill /F /PID ${pid2}`);

      pc.advanceTime(20_000);

      const appLog = await ps.execute(
        'Get-WinEvent -LogName Application | Where-Object { $_.Id -eq 9001 } | Select-Object -First 1',
      );
      expect(appLog).toContain('notify-failure');
      expect(appLog).toContain('recovery notification script executed');

      // Second failure is a RUN action, not a restart — the service must not
      // have been silently brought back up by the wrong recovery tier.
      const statusAfter = (await ps.execute('(Get-Service -Name MonSuperService).Status')).trim();
      expect(statusAfter).toBe('Stopped');
    });

    it('compteur de réinitialisation: après la fenêtre reset=60s, le rang repart à 1', async () => {
      const pc = createPC();
      const ps = await setupServiceWithRecovery(pc);

      const pid1 = await getServicePid(pc, 'MonSuperService');
      await pc.executeCommand(`taskkill /F /PID ${pid1}`);
      pc.advanceTime(10_000);

      pc.advanceTime(65_000);

      const pid2 = await getServicePid(pc, 'MonSuperService');
      await pc.executeCommand(`taskkill /F /PID ${pid2}`);
      pc.advanceTime(10_000);

      const status = (await ps.execute('(Get-Service -Name MonSuperService).Status')).trim();
      expect(status).toBe('Running');

      const pid3 = await getServicePid(pc, 'MonSuperService');
      expect(pid3).toBeGreaterThan(0);
    });
  });

  describe('Script PowerShell de surveillance temps réel (Register-WmiEvent)', () => {
    it('détecte chaque transition d\'état sans polling et journalise EventId 4001', async () => {
      const pc = createPC();
      const ps = await setupServiceWithRecovery(pc);

      const monitorScript = String.raw`
$Global:FailureRank = 0
Register-WmiEvent -Query "SELECT * FROM __InstanceModificationEvent WITHIN 2 WHERE TargetInstance ISA 'Win32_Service' AND TargetInstance.Name = 'MonSuperService'" -Action {
  $prev = $Event.SourceEventArgs.NewEvent.TargetInstance.PreviousState
  $new  = $Event.SourceEventArgs.NewEvent.TargetInstance.State
  if ($new -eq "Stopped") { $Global:FailureRank = $Global:FailureRank + 1 }
  $msg = "MonSuperService transitioned from $prev to $new (rank $Global:FailureRank) at $(Get-Date)"
  Write-EventLog -LogName System -Source "wmi-monitor" -EventId 4001 -EntryType Warning -Message $msg
}
`;
      await ps.execute(monitorScript);

      const pidBefore = await getServicePid(pc, 'MonSuperService');
      await pc.executeCommand(`taskkill /F /PID ${pidBefore}`);

      const out = await ps.execute(
        'Get-WinEvent -LogName System | Where-Object { $_.Id -eq 4001 } | Select-Object -First 1',
      );
      expect(out).toContain('MonSuperService');
      expect(out).toContain('rank 1');
      expect(out.toLowerCase()).toContain('stopped');
    });
  });
});
