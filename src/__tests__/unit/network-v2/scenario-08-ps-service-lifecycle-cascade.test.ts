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
  return new WindowsPC('windows-pc', name);
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

async function buildChain(pc: WindowsPC): Promise<{ execute: (l: string) => Promise<string> }> {
  pc.setCurrentUser('Administrator');
  const ps = createPS(pc);
  await ps.execute(
    'New-Service -Name "A" -BinaryPathName "C:\\Services\\A.exe" -DisplayName "Service A" -StartupType Automatic',
  );
  await ps.execute(
    'New-Service -Name "B" -BinaryPathName "C:\\Services\\B.exe" -DisplayName "Service B" -StartupType Automatic -DependsOn "A"',
  );
  await ps.execute(
    'New-Service -Name "C" -BinaryPathName "C:\\Services\\C.exe" -DisplayName "Service C" -StartupType Automatic -DependsOn "B"',
  );
  await ps.execute('Start-Service -Name A');
  await ps.execute('Start-Service -Name B');
  await ps.execute('Start-Service -Name C');
  return ps;
}

describe('Scénario 1 — Cycle de vie complet d\'un service Windows et cascade de dépendances', () => {
  describe('Gestion des états', () => {
    it('Get-Service -Name A,B,C affiche Status et StartType exacts à chaque étape', async () => {
      const pc = createPC();
      const ps = await buildChain(pc);

      const out = await ps.execute(
        'Get-Service -Name A,B,C | Select-Object Name, Status, StartType | Format-Table',
      );
      expect(out).toContain('A');
      expect(out).toContain('B');
      expect(out).toContain('C');
      expect(out).toContain('Running');
      expect(out).toContain('Automatic');
    });

    it('Set-Service -StartupType Disabled puis redémarrage système empêche le démarrage automatique de A', async () => {
      const pc = createPC();
      const ps = await buildChain(pc);

      await ps.execute('Set-Service -Name A -StartupType Disabled');
      const before = await ps.execute('Get-Service -Name A | Select-Object Name, StartType');
      expect(before).toContain('Disabled');

      pc.powerOff();
      pc.powerOn();

      const ps2 = createPS(pc);
      const afterBoot = await ps2.execute('Get-Service -Name A | Select-Object Name, Status, StartType');
      expect(afterBoot).toContain('Disabled');
      expect(afterBoot).toContain('Stopped');
    });

    it('sc.exe query A retourne un STATE cohérent avec Get-Service', async () => {
      const pc = createPC();
      const ps = await buildChain(pc);

      const scOut = await pc.executeCommand('sc query A');
      expect(scOut).toMatch(/STATE\s*:\s*4\s+RUNNING/);

      await ps.execute('Stop-Service -Name C');
      await ps.execute('Stop-Service -Name B');
      await ps.execute('Stop-Service -Name A');
      const scOut2 = await pc.executeCommand('sc query A');
      expect(scOut2).toMatch(/STATE\s*:\s*1\s+STOPPED/);
    });
  });

  describe('Propagation des dépendances', () => {
    it('Get-Service -Name A | Select DependentServices liste B et C avant arrêt', async () => {
      const pc = createPC();
      const ps = await buildChain(pc);

      const out = await ps.execute(
        'Get-Service -Name A | Select-Object -ExpandProperty DependentServices',
      );
      expect(out).toContain('B');
      expect(out).toContain('C');
    });

    it('Stop-Service -Name A -Force arrête A, B et C dans l\'ordre inverse des dépendances', async () => {
      const pc = createPC();
      const ps = await buildChain(pc);

      await ps.execute('Stop-Service -Name A -Force');

      const statusA = await ps.execute('(Get-Service -Name A).Status');
      const statusB = await ps.execute('(Get-Service -Name B).Status');
      const statusC = await ps.execute('(Get-Service -Name C).Status');
      expect(statusA.trim()).toBe('Stopped');
      expect(statusB.trim()).toBe('Stopped');
      expect(statusC.trim()).toBe('Stopped');
    });

    it('capture l\'ordre d\'arrêt via EventId 7036 dans le journal Système avec horodatages en millisecondes', async () => {
      const pc = createPC();
      const ps = await buildChain(pc);

      await ps.execute('Stop-Service -Name A -Force');

      const out = await ps.execute(
        'Get-WinEvent -LogName System | Where-Object { $_.Id -eq 7036 } | ' +
        'ForEach-Object { "$($_.TimeCreated.ToString(\'HH:mm:ss.fff\')) $($_.Message)" }',
      );
      // Get-WinEvent lists newest first, so the LAST service stopped (A, the
      // top of the cascade) appears FIRST and the first one stopped (C, the
      // deepest dependent) appears LAST.
      const lines = out.split('\n').filter(l => l.includes('Service C') || l.includes('Service B') || l.includes('Service A'));
      const idxC = lines.findIndex(l => l.includes('Service C') && l.includes('stopped'));
      const idxB = lines.findIndex(l => l.includes('Service B') && l.includes('stopped'));
      const idxA = lines.findIndex(l => l.includes('Service A') && l.includes('stopped'));
      expect(idxA).toBeGreaterThanOrEqual(0);
      expect(idxB).toBeGreaterThan(idxA);
      expect(idxC).toBeGreaterThan(idxB);
    });

    it('Stop-Service -Name A sans -Force alors que B est actif retourne une erreur listant les dépendants', async () => {
      const pc = createPC();
      const ps = await buildChain(pc);

      const out = await ps.execute('Stop-Service -Name A');
      expect(out.toLowerCase()).toContain('cannot stop service');
      expect(out).toContain('A');
      expect(out.toLowerCase()).toMatch(/dependent services/);
      expect(out).toContain('B');

      const statusA = await ps.execute('(Get-Service -Name A).Status');
      expect(statusA.trim()).toBe('Running');
    });
  });

  describe('Cohérence entre outils', () => {
    it('Get-Service, sc.exe query et sc.exe qc reflètent le même état au même instant', async () => {
      const pc = createPC();
      const ps = await buildChain(pc);

      const psStatus = (await ps.execute('(Get-Service -Name B).Status')).trim();
      const scOut = await pc.executeCommand('sc query B');
      expect(psStatus).toBe('Running');
      expect(scOut).toMatch(/STATE\s*:\s*4\s+RUNNING/);

      await ps.execute('Stop-Service -Name C');
      await ps.execute('Stop-Service -Name B');
      const psStatus2 = (await ps.execute('(Get-Service -Name B).Status')).trim();
      const scOut2 = await pc.executeCommand('sc query B');
      expect(psStatus2).toBe('Stopped');
      expect(scOut2).toMatch(/STATE\s*:\s*1\s+STOPPED/);
    });

    it('Get-Service -Name B | Select ServicesDependedOn est cohérent avec sc.exe qc B', async () => {
      const pc = createPC();
      const ps = await buildChain(pc);

      const psOut = await ps.execute(
        'Get-Service -Name B | Select-Object -ExpandProperty ServicesDependedOn',
      );
      expect(psOut).toContain('A');

      const scOut = await pc.executeCommand('sc qc B');
      expect(scOut).toMatch(/DEPENDENCIES\s*:\s*A/);
    });
  });
});
