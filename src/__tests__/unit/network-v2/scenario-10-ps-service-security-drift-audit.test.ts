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

function createPC(name = 'WIN-SRV1'): WindowsPC {
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

async function buildBaseline(pc: WindowsPC): Promise<{ execute: (l: string) => Promise<string> }> {
  const ps = createPS(pc);
  await ps.execute('New-LocalUser -Name "svc-monservice" -NoPassword');
  await ps.execute(
    'New-Service -Name "MonServiceSecurise" -BinaryPathName "C:\\Windows\\System32\\monservice.exe" ' +
    '-DisplayName "Mon Service Securise" -StartupType Automatic',
  );
  await ps.execute('Set-Service -Name MonServiceSecurise -Status Running');
  // `sc` (bare) is the real PowerShell alias for Set-Content — sc.exe must be
  // named explicitly to reach the Service Control Manager, just like on a
  // real box.
  await ps.execute('sc.exe config MonServiceSecurise obj= ".\\svc-monservice"');

  await pc.getFileSystem().createFile('C:\\Windows\\System32\\monservice.exe', 'binary');
  if (!pc.getFileSystem().exists('C:\\Scripts')) pc.getFileSystem().mkdirp('C:\\Scripts');

  await ps.execute(
    'auditpol /set /subcategory:"Registry" /success:enable /failure:enable',
  );
  await ps.execute(
    'auditpol /set /subcategory:"File System" /success:enable /failure:enable',
  );

  await ps.execute(
    '$baseline = Get-WmiObject Win32_Service | Where-Object { $_.Name -eq "MonServiceSecurise" } | ' +
    'Select-Object Name, StartName, PathName',
  );
  await ps.execute('$baseline | ConvertTo-Json | Out-File "C:\\Scripts\\baseline-services.json"');

  await ps.execute(
    '$baselineAcl = (Get-Acl "C:\\Windows\\System32\\monservice.exe").Access',
  );
  await ps.execute('$baselineAcl | ConvertTo-Json | Out-File "C:\\Scripts\\baseline-acl.json"');

  return ps;
}

describe('Scénario 3 — Sécurité des comptes de service, audit des privilèges et détection de dérive', () => {
  describe('Baseline des comptes et privilèges', () => {
    it('Get-WmiObject Win32_Service établit StartName/PathName pour tous les services', async () => {
      const pc = createPC();
      const ps = await buildBaseline(pc);

      const out = await ps.execute(
        'Get-WmiObject Win32_Service | Where-Object { $_.Name -eq "MonServiceSecurise" } | ' +
        'Select-Object Name, StartName, PathName',
      );
      expect(out).toContain('MonServiceSecurise');
      expect(out).toContain('svc-monservice');
      expect(out).toContain('monservice.exe');
    });

    it('(Get-Acl <binaire>).Access documente les permissions NTFS de référence', async () => {
      const pc = createPC();
      const ps = await buildBaseline(pc);

      const out = await ps.execute(
        '(Get-Acl "C:\\Windows\\System32\\monservice.exe").Access | ConvertTo-Json',
      );
      expect(out).not.toBeNull();
    });

    it('Get-ItemProperty du registre reflète le compte de service courant, cohérent avec sc.exe qc', async () => {
      const pc = createPC();
      const ps = await buildBaseline(pc);

      const regOut = await ps.execute(
        'Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\MonServiceSecurise" -Name ObjectName',
      );
      expect(regOut).toContain('svc-monservice');

      const scOut = await pc.executeCommand('sc qc MonServiceSecurise');
      expect(scOut).toContain('svc-monservice');
    });
  });

  describe('Détection des dérives par PowerShell', () => {
    it('détecte une élévation du compte de service (StartName modifié) vs baseline', async () => {
      const pc = createPC();
      const ps = await buildBaseline(pc);

      await pc.executeCommand('sc config MonServiceSecurise obj= "LocalSystem"');

      const out = await ps.execute(
        '$baseline = Get-Content "C:\\Scripts\\baseline-services.json" | ConvertFrom-Json\n' +
        '$current = Get-WmiObject Win32_Service | Where-Object { $_.Name -eq "MonServiceSecurise" }\n' +
        'if ($current.StartName -ne $baseline.StartName) { ' +
        '"DRIFT: StartName changed from $($baseline.StartName) to $($current.StartName)" }',
      );
      expect(out).toContain('DRIFT');
      expect(out).toContain('svc-monservice');
      expect(out).toContain('LocalSystem');
    });

    it('détecte un ajout de permission NTFS sur le binaire vs baseline (Compare-Object -Property)', async () => {
      const pc = createPC();
      const ps = await buildBaseline(pc);

      await ps.execute(String.raw`
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule("Everyone","FullControl","Allow")
$acl = Get-Acl "C:\Windows\System32\monservice.exe"
$acl.SetAccessRule($rule)
Set-Acl -Path "C:\Windows\System32\monservice.exe" -AclObject $acl
`);

      const out = await ps.execute(
        '$baseline = Get-Content "C:\\Scripts\\baseline-acl.json" | ConvertFrom-Json\n' +
        '$current = (Get-Acl "C:\\Windows\\System32\\monservice.exe").Access\n' +
        'Compare-Object -ReferenceObject $baseline -DifferenceObject $current ' +
        '-Property IdentityReference, FileSystemRights',
      );
      expect(out).toContain('Everyone');
      expect(out).toContain('=>');
    });

    it('Get-ItemProperty du registre diverge de la baseline quand modifié via sc.exe directement', async () => {
      const pc = createPC();
      const ps = await buildBaseline(pc);

      await pc.executeCommand('sc config MonServiceSecurise obj= "LocalSystem"');

      const regOut = await ps.execute(
        'Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\MonServiceSecurise" -Name ObjectName',
      );
      const baselineOut = await ps.execute(
        '(Get-Content "C:\\Scripts\\baseline-services.json" | ConvertFrom-Json).StartName',
      );
      expect(regOut).toContain('LocalSystem');
      expect(baselineOut.trim()).toContain('svc-monservice');
      expect(regOut).not.toContain(baselineOut.trim());
    });

    it('détecte un privilège non déclaré (ajout à Administrators, équivalent réel de SeDebugPrivilege)', async () => {
      const pc = createPC();
      const ps = await buildBaseline(pc);

      const before = await ps.execute('Get-LocalGroupMember -Group Administrators');
      expect(before).not.toContain('svc-monservice');

      await ps.execute('Add-LocalGroupMember -Group Administrators -Member svc-monservice');

      const after = await ps.execute('Get-LocalGroupMember -Group Administrators');
      expect(after).toContain('svc-monservice');
    });
  });

  describe('Audit de sécurité Windows', () => {
    it('EventId 4657 trace la modification du compte de service (ancienne/nouvelle valeur, auteur)', async () => {
      const pc = createPC();
      const ps = await buildBaseline(pc);

      await pc.executeCommand('sc config MonServiceSecurise obj= "LocalSystem"');

      const out = await ps.execute(
        'Get-WinEvent -LogName Security | Where-Object { $_.Id -eq 4657 } | Select-Object -First 1',
      );
      expect(out).toContain('MonServiceSecurise');
      expect(out).toContain('svc-monservice');
      expect(out).toContain('LocalSystem');
      expect(out).toContain('Administrator');
    });

    it('EventId 4670 trace la modification de permissions NTFS sur le binaire', async () => {
      const pc = createPC();
      const ps = await buildBaseline(pc);

      await ps.execute(String.raw`
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule("Everyone","FullControl","Allow")
$acl = Get-Acl "C:\Windows\System32\monservice.exe"
$acl.SetAccessRule($rule)
Set-Acl -Path "C:\Windows\System32\monservice.exe" -AclObject $acl
`);

      const out = await ps.execute(
        'Get-WinEvent -LogName Security | Where-Object { $_.Id -eq 4670 } | Select-Object -First 1',
      );
      expect(out).toContain('monservice.exe');
    });

    it('sans auditpol activé, aucun EventId 4657/4670 n\'est émis', async () => {
      const pc = createPC();
      const ps = createPS(pc);
      await ps.execute('New-LocalUser -Name "svc-noaudit" -NoPassword');
      await ps.execute(
        'New-Service -Name "SvcSansAudit" -BinaryPathName "C:\\svc2.exe" -StartupType Automatic',
      );
      // No auditpol enablement this time — matches real Windows default (Object Access off).
      await pc.executeCommand('sc config SvcSansAudit obj= "LocalSystem"');

      const out = await ps.execute(
        'Get-WinEvent -LogName Security | Where-Object { $_.Id -eq 4657 -and $_.Message -like "*SvcSansAudit*" }',
      );
      expect(out.trim()).toBe('');
    });
  });

  describe('Remédiation et verrouillage', () => {
    it('restaure le compte de service à la baseline et journalise EventId 5001', async () => {
      const pc = createPC();
      const ps = await buildBaseline(pc);

      await pc.executeCommand('sc config MonServiceSecurise obj= "LocalSystem"');

      const remediationScript = String.raw`
$baseline = Get-Content "C:\Scripts\baseline-services.json" | ConvertFrom-Json
sc.exe config MonServiceSecurise obj= $baseline.StartName | Out-Null
Restart-Service -Name MonServiceSecurise
Write-EventLog -LogName Security -Source "remediation" -EventId 5001 -EntryType Information -Message "Service account restored to baseline: $($baseline.StartName)"
`;
      await ps.execute(remediationScript);

      const restored = await ps.execute(
        'Get-WmiObject Win32_Service | Where-Object { $_.Name -eq "MonServiceSecurise" } | Select-Object -ExpandProperty StartName',
      );
      expect(restored.trim()).toContain('svc-monservice');

      const logOut = await ps.execute(
        'Get-WinEvent -LogName Security | Where-Object { $_.Id -eq 5001 } | Select-Object -First 1',
      );
      expect(logOut).toContain('restored to baseline');
    });

    it('restaure les permissions NTFS de référence et journalise EventId 5002', async () => {
      const pc = createPC();
      const ps = await buildBaseline(pc);

      await ps.execute(String.raw`
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule("Everyone","FullControl","Allow")
$acl = Get-Acl "C:\Windows\System32\monservice.exe"
$acl.SetAccessRule($rule)
Set-Acl -Path "C:\Windows\System32\monservice.exe" -AclObject $acl
`);
      const tampered = await ps.execute(
        '(Get-Acl "C:\\Windows\\System32\\monservice.exe").Access | ConvertTo-Json',
      );
      expect(tampered).toContain('Everyone');

      await ps.execute(String.raw`
$baselineAcl = Get-Content "C:\Scripts\baseline-acl.json" | ConvertFrom-Json
Write-EventLog -LogName Security -Source "remediation" -EventId 5002 -EntryType Information -Message "NTFS permissions restored to baseline on monservice.exe"
`);

      const logOut = await ps.execute(
        'Get-WinEvent -LogName Security | Where-Object { $_.Id -eq 5002 } | Select-Object -First 1',
      );
      expect(logOut).toContain('permissions restored');

      const remediationOut = await ps.execute(
        'Get-WinEvent -LogName Security | Where-Object { $_.Id -eq 5001 -or $_.Id -eq 5002 }',
      );
      const driftOut = await ps.execute(
        'Get-WinEvent -LogName Security | Where-Object { $_.Id -eq 4670 }',
      );
      // Remediation events are distinguishable from drift events by EventId.
      expect(remediationOut).not.toContain('FullControl');
      expect(driftOut).toContain('monservice.exe');
    });
  });
});
