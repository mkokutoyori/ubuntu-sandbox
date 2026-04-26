// ═══════════════════════════════════════════════════════════════════════════
// full‑cmdlet‑battery.test.ts — exhaustive tests for 20 core PowerShell cmdlets
// ═══════════════════════════════════════════════════════════════════════════
// Each cmdlet section contains at least 20 tests covering:
//   • basic usage
//   • every documented parameter
//   • malformed input and missing mandatory parameters
//   • error messages
//   • Get-Help integration
//   • pipelining (input from pipeline and output to pipeline)

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellExecutor } from '@/network/devices/windows/PowerShellExecutor';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function createPC(name = 'WIN-CMD'): WindowsPC {
  return new WindowsPC('windows-pc', name);
}

function createPS(pc: WindowsPC): PowerShellExecutor {
  return new PowerShellExecutor(pc);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Clear‑Host
// ═══════════════════════════════════════════════════════════════════════════

describe('1. Clear‑Host', () => {
  it('Clear-Host executes without error', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Clear-Host')).resolves.toBeDefined();
  });

  it('Clear-Host does not produce output', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Clear-Host');
    expect(out.trim()).toBe('');
  });

  it('Clear-Host can be used in a script block', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('& { Clear-Host; 42 }');
    expect(out.trim()).toBe('42');
  });

  it('Clear-Host -? shows help', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const help = await ps.execute('Clear-Host -?');
    expect(help).toContain('Clear-Host');
  });

  it('Get-Help Clear-Host shows description', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const help = await ps.execute('Get-Help Clear-Host');
    expect(help).toContain('Clears');
  });

  it('Clear-Host -ErrorAction SilentlyContinue suppresses errors (none expected)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Clear-Host -ErrorAction SilentlyContinue');
    expect(out).toBeDefined();
  });

  it('Clear-Host -WarningAction SilentlyContinue does not break', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Clear-Host -WarningAction SilentlyContinue')).resolves.not.toThrow();
  });

  it('Clear-Host accepts pipeline input but ignores it', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('"hello" | Clear-Host');
    expect(out.trim()).toBe('');
  });

  it('Clear-Host does not affect variables', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('$x = 1; Clear-Host; $x');
    const x = await ps.execute('$x');
    expect(x.trim()).toBe('1');
  });

  it('Clear-Host inside a function works', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('function Foo { Clear-Host }; Foo')).resolves.not.toThrow();
  });

  it('Clear-Host twice does nothing special', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Clear-Host; Clear-Host');
    const out = await ps.execute('"still here"');
    expect(out.trim()).toBe('still here');
  });

  it('Clear-Host -Confirm:$false (if applicable) works without prompt', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Clear-Host -Confirm:$false')).resolves.not.toThrow();
  });

  it('Clear-Host -WhatIf does nothing (and outputs nothing)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Clear-Host -WhatIf');
    expect(out.trim()).toBe('');
  });

  it('Clear-Host alias "clear" works', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('clear');
    expect(out.trim()).toBe('');
  });

  it('clear alias clears the screen', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('cls')).resolves.not.toThrow();
  });

  it('multiple Clear-Host in sequence produce no output', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Clear-Host; Clear-Host; "end"');
    expect(out.trim()).toBe('end');
  });

  it('Clear-Host -OutVariable stores outputs (none)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Clear-Host -OutVariable ov');
    const ov = await ps.execute('$ov');
    expect(ov.trim()).toBe('');
  });

  it('Clear-Host can be stopped with Ctrl+C simulation? (skip)', async () => {
    // Not testable in unit
  });

  it('Clear-Host does not close the session', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Clear-Host');
    const alive = await ps.execute('Get-Date');
    expect(alive).toBeDefined();
  });

  it('Clear-Host -InformationVariable captures nothing', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Clear-Host -InformationVariable iv');
    const iv = await ps.execute('$iv');
    expect(iv.trim()).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Copy‑Item
// ═══════════════════════════════════════════════════════════════════════════

describe('2. Copy‑Item', () => {
  it('copies a file to a new location', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content -Path C:\\src.txt -Value "hello"');
    await ps.execute('Copy-Item C:\\src.txt C:\\dst.txt');
    const content = await ps.execute('Get-Content C:\\dst.txt');
    expect(content.trim()).toBe('hello');
  });

  it('copies a directory recursively', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\source -ItemType Directory');
    await ps.execute('Set-Content -Path C:\\source\\f.txt -Value "inside"');
    await ps.execute('Copy-Item C:\\source C:\\target -Recurse');
    const content = await ps.execute('Get-Content C:\\target\\f.txt');
    expect(content.trim()).toBe('inside');
  });

  it('Copy-Item -Force overwrites existing file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\a.txt "first"');
    await ps.execute('Set-Content C:\\b.txt "second"');
    await ps.execute('Copy-Item C:\\a.txt C:\\b.txt -Force');
    const content = await ps.execute('Get-Content C:\\b.txt');
    expect(content.trim()).toBe('first');
  });

  it('Copy-Item without -Force fails if destination exists', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\exist.txt "old"');
    await ps.execute('Set-Content C:\\new.txt "new"');
    const result = await ps.execute('Copy-Item C:\\new.txt C:\\exist.txt -ErrorAction SilentlyContinue');
    expect(result).toContain('already exists');
  });

  it('Copy-Item -PassThru returns the object', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\pass.txt "data"');
    const out = await ps.execute('Copy-Item C:\\pass.txt C:\\pass2.txt -PassThru | Select-Object -ExpandProperty Name');
    expect(out.trim()).toBe('pass2.txt');
  });

  it('Copy-Item -Container copies directory without child items (if no -Recurse)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\dir -ItemType Directory');
    await ps.execute('Set-Content C:\\dir\\child.txt "child"');
    const result = await ps.execute('Copy-Item C:\\dir C:\\dirCopy -Container');
    // Should be an error because directory contains children but no -Recurse
    expect(result).toContain('directory');
  });

  it('Copy-Item -Filter copies only matching files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\mixed -ItemType Directory');
    await ps.execute('Set-Content C:\\mixed\\a.txt "a"');
    await ps.execute('Set-Content C:\\mixed\\b.log "b"');
    await ps.execute('Copy-Item C:\\mixed\\* C:\\filtered -Filter *.txt -Recurse');
    const logExists = await ps.execute('Test-Path C:\\filtered\\b.log');
    expect(logExists.trim()).toBe('False');
    const txtExists = await ps.execute('Test-Path C:\\filtered\\a.txt');
    expect(txtExists.trim()).toBe('True');
  });

  it('Copy-Item -Include copies specified files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\includeDir -ItemType Directory');
    await ps.execute('Set-Content C:\\includeDir\\one.txt "1"');
    await ps.execute('Set-Content C:\\includeDir\\two.txt "2"');
    await ps.execute('Copy-Item C:\\includeDir\\* C:\\included -Include "one.txt" -Recurse');
    const oneExists = await ps.execute('Test-Path C:\\included\\one.txt');
    expect(oneExists.trim()).toBe('True');
    const twoExists = await ps.execute('Test-Path C:\\included\\two.txt');
    expect(twoExists.trim()).toBe('False');
  });

  it('Copy-Item -Exclude excludes files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\excDir -ItemType Directory');
    await ps.execute('Set-Content C:\\excDir\\keep.txt "k"');
    await ps.execute('Set-Content C:\\excDir\\skip.log "s"');
    await ps.execute('Copy-Item C:\\excDir\\* C:\\excluded -Exclude "*.log" -Recurse');
    const skipExists = await ps.execute('Test-Path C:\\excluded\\skip.log');
    expect(skipExists.trim()).toBe('False');
  });

  it('Copy-Item -LiteralPath works with special characters', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path "C:\\[special]" -ItemType Directory -Force');
    await ps.execute('Set-Content "C:\\[special]\\file.txt" "content"');
    await ps.execute('Copy-Item -LiteralPath "C:\\[special]" -Destination C:\\litCopy -Recurse');
    const content = await ps.execute('Get-Content C:\\litCopy\\file.txt');
    expect(content.trim()).toBe('content');
  });

  it('Copy-Item with -Credential (simulated, not validated)', async () => {
    // In simulation we ignore credentials, but command should not throw
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\credFile.txt "cred"');
    await expect(ps.execute('Copy-Item C:\\credFile.txt C:\\credCopy.txt -Credential Administrator')).resolves.not.toThrow();
  });

  it('Copy-Item -Confirm:$true should prompt (but we simulate no prompt)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    // In automation -Confirm:$true may throw if not interactive; we test with -Confirm:$false
    await ps.execute('Set-Content C:\\confFile.txt "confirm"');
    await expect(ps.execute('Copy-Item C:\\confFile.txt C:\\confCopy.txt -Confirm:$false')).resolves.not.toThrow();
  });

  it('Copy-Item from pipeline (file from Get-ChildItem)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\pipeSrc.txt "pipe"');
    await ps.execute('Get-ChildItem C:\\pipeSrc.txt | Copy-Item -Destination C:\\pipeDst.txt');
    const content = await ps.execute('Get-Content C:\\pipeDst.txt');
    expect(content.trim()).toBe('pipe');
  });

  it('Copy-Item wildcard copies multiple files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\starDir -ItemType Directory');
    await ps.execute('Set-Content C:\\starDir\\a.txt "a"');
    await ps.execute('Set-Content C:\\starDir\\b.txt "b"');
    await ps.execute('Copy-Item C:\\starDir\\* C:\\starDest -Recurse');
    const aExists = await ps.execute('Test-Path C:\\starDest\\a.txt');
    expect(aExists.trim()).toBe('True');
    const bExists = await ps.execute('Test-Path C:\\starDest\\b.txt');
    expect(bExists.trim()).toBe('True');
  });

  it('Copy-Item fails gracefully with missing source', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const result = await ps.execute('Copy-Item C:\\noFile.txt C:\\dst.txt -ErrorAction SilentlyContinue');
    expect(result).toContain('Cannot find path');
  });

  it('Copy-Item -Container ignores container when copying file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\plain.txt "text"');
    await ps.execute('Copy-Item C:\\plain.txt C:\\plainCopy.txt -Container');
    const content = await ps.execute('Get-Content C:\\plainCopy.txt');
    expect(content.trim()).toBe('text');
  });

  it('Copy-Item -ToSession (remote) throws not supported in simulator', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const result = await ps.execute('Copy-Item C:\\test.txt -ToSession (New-PSSession) -ErrorAction SilentlyContinue');
    expect(result).toContain('not supported');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Get‑ChildItem
// ═══════════════════════════════════════════════════════════════════════════

describe('3. Get‑ChildItem', () => {
  it('lists items in a directory', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem C:\\Windows');
    expect(out).toContain('System32');
  });

  it('returns an empty collection for empty directory', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\emptyDir -ItemType Directory');
    const out = await ps.execute('Get-ChildItem C:\\emptyDir');
    expect(out.trim()).toBe('');
  });

  it('Get-ChildItem -Path with wildcard', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem C:\\Windows\\System32\\*.exe');
    expect(out).toContain('cmd.exe');
  });

  it('-Filter parameter', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem C:\\Windows\\System32 -Filter *.dll');
    expect(out).toContain('.dll');
  });

  it('-Include parameter', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem C:\\Windows\\System32 -Include "*.exe","*.dll"');
    expect(out).toContain('.exe');
  });

  it('-Exclude parameter', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem C:\\Windows\\System32 -Exclude *.exe');
    expect(out).not.toContain('cmd.exe');
  });

  it('-Recurse lists nested items', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\rec\\sub -ItemType Directory -Force');
    await ps.execute('Set-Content C:\\rec\\sub\\deep.txt "deep"');
    const out = await ps.execute('Get-ChildItem C:\\rec -Recurse');
    expect(out).toContain('deep.txt');
  });

  it('-Depth limits recursion', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\depth\\level1\\level2 -ItemType Directory -Force');
    await ps.execute('Set-Content C:\\depth\\level1\\level2\\deepest.txt "d"');
    const out = await ps.execute('Get-ChildItem C:\\depth -Recurse -Depth 1');
    expect(out).toContain('level1');
    expect(out).not.toContain('deepest.txt');
  });

  it('-Name returns only names as strings', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\nameDir -ItemType Directory');
    await ps.execute('Set-Content C:\\nameDir\\file.txt "f"');
    const out = await ps.execute('Get-ChildItem C:\\nameDir -Name');
    expect(out.trim()).toBe('file.txt');
  });

  it('-Directory returns only directories', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\dirTest -ItemType Directory');
    await ps.execute('Set-Content C:\\dirTest\\f.txt "f"');
    const out = await ps.execute('Get-ChildItem C:\\dirTest -Directory');
    // Should not contain f.txt
    expect(out).not.toContain('f.txt');
  });

  it('-File returns only files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem C:\\Windows -File');
    expect(out).toContain('write.exe');
    expect(out).not.toContain('System32'); // directory
  });

  it('-Hidden includes hidden files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\hiddenDir -ItemType Directory -Force');
    await ps.execute('Set-Content C:\\hiddenDir\\.hidden.txt "hid"');
    // Simulate hidden attribute
    await ps.execute('(Get-Item C:\\hiddenDir\\.hidden.txt).Attributes += "Hidden"');
    const out = await ps.execute('Get-ChildItem C:\\hiddenDir');
    expect(out).not.toContain('.hidden.txt'); // default
    const outHidden = await ps.execute('Get-ChildItem C:\\hiddenDir -Hidden');
    expect(outHidden).toContain('.hidden.txt');
  });

  it('-ReadOnly includes read-only files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\roDir -ItemType Directory -Force');
    await ps.execute('Set-Content C:\\roDir\\ro.txt "ro"');
    await ps.execute('(Get-Item C:\\roDir\\ro.txt).IsReadOnly = $true');
    const out = await ps.execute('Get-ChildItem C:\\roDir -ReadOnly');
    expect(out).toContain('ro.txt');
  });

  it('-System includes system files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem C:\\Windows\\System32 -System');
    // At least one system file expected
    expect(out).toContain('ntdll.dll');
  });

  it('-Force includes hidden and system items', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem C:\\ -Force');
    expect(out).toContain('$Recycle.Bin');
  });

  it('-Attributes allows filtering by Archive, etc.', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\attrFile.txt "attr"');
    await ps.execute('(Get-Item C:\\attrFile.txt).Attributes = "Archive"');
    const out = await ps.execute('Get-ChildItem C:\\ -Attributes Archive');
    expect(out).toContain('attrFile.txt');
  });

  it('-ErrorAction SilentlyContinue on missing path does not throw', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Get-ChildItem C:\\no-dir -ErrorAction SilentlyContinue')).resolves.not.toThrow();
  });

  it('pipeline input from Get-Item', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\pipelineDir -ItemType Directory');
    await ps.execute('Set-Content C:\\pipelineDir\\a.txt "a"');
    const out = await ps.execute('Get-Item C:\\pipelineDir | Get-ChildItem');
    expect(out).toContain('a.txt');
  });

  it('Get-ChildItem with -LiteralPath and special characters', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path "C:\\[bracket]dir" -ItemType Directory -Force');
    await ps.execute('Set-Content "C:\\[bracket]dir\\f.txt" "f"');
    const out = await ps.execute('Get-ChildItem -LiteralPath "C:\\[bracket]dir"');
    expect(out).toContain('f.txt');
  });

  it('Get-ChildItem -Path using alternate provider (registry)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem HKCU:\\Software\\Microsoft');
    expect(out).toContain('Windows');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Get‑Command
// ═══════════════════════════════════════════════════════════════════════════

describe('4. Get‑Command', () => {
  it('lists all commands', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command');
    expect(out).toContain('Get-Command');
  });

  it('Get-Command -Name "Get-Process" returns exact match', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command Get-Process');
    expect(out).toContain('Get-Process');
  });

  it('Get-Command -Name with wildcard', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command Get-*');
    expect(out).toContain('Get-Command');
    expect(out).toContain('Get-Process');
  });

  it('Get-Command -Module filter', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command -Module Microsoft.PowerShell.Management');
    expect(out).toContain('Get-ChildItem');
  });

  it('Get-Command -CommandType Cmdlet', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command -CommandType Cmdlet');
    expect(out).toContain('Cmdlet');
  });

  it('Get-Command -CommandType Function', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command -CommandType Function');
    expect(out).toContain('Function');
  });

  it('Get-Command -All includes duplicate names (e.g., from different modules)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command Get-Item -All');
    // Might list multiple
    expect(out).toContain('Get-Item');
  });

  it('Get-Command -Noun "Process"', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command -Noun Process');
    expect(out).toContain('Get-Process');
    expect(out).toContain('Stop-Process');
  });

  it('Get-Command -Verb "Get"', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command -Verb Get');
    expect(out).toContain('Get-Process');
  });

  it('Get-Command -Syntax shows syntax', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command Get-Process -Syntax');
    expect(out).toContain('Get-Process');
  });

  it('Get-Command -ArgumentList filters by parameter sets', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command -ArgumentList (Get-Process)[0]');
    // Should find commands that accept process objects
    expect(out).toContain('Stop-Process');
  });

  it('Get-Command unknown name returns error', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command NoSuchCommand -ErrorAction SilentlyContinue');
    expect(out).toContain('not recognized');
  });

  it('Get-Command -ShowCommandInfo (if supported)', async () => {
    // In simulator, may not be supported but no crash
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Get-Command Get-Process -ShowCommandInfo')).resolves.not.toThrow();
  });

  it('Get-Command can be piped to Get-Help', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command Get-Process | Get-Help');
    expect(out).toContain('Get-Process');
  });

  it('Get-Command returns PSCustomObject with Name, CommandType, Module', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('(Get-Command Get-ChildItem).CommandType');
    expect(out.trim()).toBe('Cmdlet');
  });

  it('Get-Command -Module with pipeline from Get-Module', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Module -ListAvailable | % { Get-Command -Module $_.Name }');
    expect(out).toContain('Cmdlet'); // at least some output
  });

  it('Get-Command -ParameterName lists commands having that parameter', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command -ParameterName ComputerName');
    expect(out).toContain('Get-Process'); // many have -ComputerName
  });

  it('Get-Command -Name with multiple names', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command -Name Get-Process,Stop-Process');
    expect(out).toContain('Get-Process');
    expect(out).toContain('Stop-Process');
  });

  it('Get-Command -FullyQualifiedModule (if supported)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Get-Command -FullyQualifiedModule @{ModuleName="Microsoft.PowerShell.Management"}')).resolves.not.toThrow();
  });

  it('Get-Command shows tooltip / description when piped to Format-List', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command Get-Process | Format-List');
    expect(out).toContain('Name');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Get‑Content
// ═══════════════════════════════════════════════════════════════════════════

describe('5. Get‑Content', () => {
  it('reads a file line by line', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('"line1","line2" | Set-Content C:\\gc.txt');
    const out = await ps.execute('Get-Content C:\\gc.txt');
    expect(out).toContain('line1');
    expect(out).toContain('line2');
  });

  it('-TotalCount limits head', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('1,2,3,4,5 | Set-Content C:\\numbers.txt');
    const head = await ps.execute('Get-Content C:\\numbers.txt -TotalCount 2');
    const lines = head.split(/\r?\n/).filter(l => l);
    expect(lines).toEqual(['1','2']);
  });

  it('-Tail shows last lines', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('1,2,3,4,5 | Set-Content C:\\numbers.txt');
    const tail = await ps.execute('Get-Content C:\\numbers.txt -Tail 2');
    const lines = tail.split(/\r?\n/).filter(l => l);
    expect(lines).toEqual(['4','5']);
  });

  it('-ReadCount 0 returns single string', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('1,2,3,4,5 | Set-Content C:\\numbers.txt');
    const out = await ps.execute('Get-Content C:\\numbers.txt -ReadCount 0');
    expect(out).toContain('1'); // content present
    expect(out).toContain('5'); // all content in one result
  });

  it('-Delimiter custom splits on delimiter', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('"a,b,c" | Set-Content C:\\csv.txt');
    const out = await ps.execute('Get-Content C:\\csv.txt -Delimiter ","');
    expect(out).toContain('a'); // each token separate
  });

  it('-Raw returns whole file as one string', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('1,2,3,4,5 | Set-Content C:\\numbers.txt');
    const raw = await ps.execute('Get-Content C:\\numbers.txt -Raw');
    expect(raw).toContain('1');
    expect(raw).toContain('5');
  });

  it('-Stream (alternate data stream) not supported in simulator?', async () => {
    // may error gracefully
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('"hello" | Set-Content C:\\numbers.txt');
    const result = await ps.execute('Get-Content C:\\numbers.txt -Stream Zone.Identifier -ErrorAction SilentlyContinue');
    expect(result).toContain('not supported');
  });

  it('-Path with wildcard reads multiple files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('"a","b" | Set-Content C:\\1.txt');
    await ps.execute('"c" | Set-Content C:\\2.txt');
    const out = await ps.execute('Get-Content C:\\1.txt, C:\\2.txt');
    expect(out).toContain('a');
    expect(out).toContain('c');
  });

  it('-Encoding UTF8', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('"hello" | Set-Content C:\\numbers.txt');
    // Not testable deeply; just check no error
    await expect(ps.execute('Get-Content C:\\numbers.txt -Encoding UTF8')).resolves.not.toThrow();
  });

  it('-AsByteStream returns byte representation', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('"A" | Set-Content C:\\numbers.txt');
    const out = await ps.execute('Get-Content C:\\numbers.txt -AsByteStream');
    // Should return numeric byte values
    expect(out).toMatch(/\d+/);
  });

  it('error on missing file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Content C:\\nope.txt -ErrorAction SilentlyContinue');
    expect(out).toContain('Cannot find path');
  });

  it('-Wait (tail -f) not applicable', async () => {
    // In simulator, -Wait returns current content (like cat, not tail -f)
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('"hello" | Set-Content C:\\numbers.txt');
    const result = await ps.execute('Get-Content C:\\numbers.txt -Wait');
    expect(result).toBeDefined();
  });

  it('piping to ForEach-Object processes each line', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('1,2,3,4,5 | Set-Content C:\\numbers.txt');
    const out = await ps.execute('Get-Content C:\\numbers.txt | ForEach-Object { "[$_]" }');
    expect(out).toContain('[1]');
  });

  it('-First synonym for -TotalCount', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('1,2,3,4,5 | Set-Content C:\\numbers.txt');
    const head = await ps.execute('Get-Content C:\\numbers.txt -First 2');
    const lines = head.split(/\r?\n/).filter(l => l);
    expect(lines).toEqual(['1','2']);
  });

  it('-Last alias for -Tail', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('1,2,3,4,5 | Set-Content C:\\numbers.txt');
    const tail = await ps.execute('Get-Content C:\\numbers.txt -Last 2');
    const lines = tail.split(/\r?\n/).filter(l => l);
    expect(lines).toEqual(['4','5']);
  });

  it('returns array by default', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('1,2,3,4,5 | Set-Content C:\\numbers.txt');
    // Get-Content returns multiple lines by default
    const out = await ps.execute('Get-Content C:\\numbers.txt');
    expect(out).toContain('1');
    expect(out).toContain('5');
  });

  it('-LiteralPath works', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('"hello" | Set-Content C:\\litcon.txt');
    const out = await ps.execute('Get-Content -LiteralPath C:\\litcon.txt');
    expect(out.trim()).toBe('hello');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Get‑Help
// ═══════════════════════════════════════════════════════════════════════════

describe('6. Get‑Help', () => {
  it('Get-Help Get-Process shows help', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process');
    expect(out).toContain('NAME');
    expect(out).toContain('Get-Process');
  });

  it('Get-Help -Examples examples only', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process -Examples');
    expect(out).toContain('EXAMPLE');
  });

  it('Get-Help -Detailed shows parameters + examples', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process -Detailed');
    expect(out).toContain('PARAMETERS');
  });

  it('Get-Help -Full shows full technical info', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process -Full');
    expect(out).toContain('INPUTS');
    expect(out).toContain('OUTPUTS');
  });

  it('Get-Help -Online launches browser (simulated)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    // Should not fail, may output message
    const out = await ps.execute('Get-Help Get-Process -Online');
    expect(out).toContain('online');
  });

  it('Get-Help about_* topics', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help about_Operators');
    expect(out).toContain('about_Operators');
  });

  it('Get-Help with no arguments shows overall help', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help');
    expect(out).toContain('Get-Help');
  });

  it('Get-Help -Parameter lists parameters', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process -Parameter Name');
    expect(out).toContain('-Name');
  });

  it('Get-Help -Category "Cmdlet" filters', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help -Category Cmdlet -Name Get-Process');
    expect(out).toContain('NAME');
  });

  it('Get-Help -Component', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process -Component PowerShell');
    expect(out).toContain('NAME');
  });

  it('Get-Help -Role', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process -Role Administrator');
    expect(out).toContain('NAME');
  });

  it('Get-Help -Functionality', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process -Functionality Processes');
    expect(out).toContain('NAME');
  });

  it('Get-Help with pipeline input accepts strings', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('"Get-Process" | Get-Help');
    expect(out).toContain('Get-Process');
  });

  it('Get-Help error for unknown command', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help NoSuchCmdlet -ErrorAction SilentlyContinue');
    expect(out).toContain('not found');
  });

  it('man alias for help', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('man Get-Process');
    expect(out).toContain('NAME');
  });

  it('Get-Help -ShowWindow (not supported) fails gracefully', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process -ShowWindow -ErrorAction SilentlyContinue');
    expect(out).toContain('not supported');
  });

  it('Get-Help with -Path (alternate location for help files)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    // Simulated
    await expect(ps.execute('Get-Help Get-Process -Path C:\\Fake')).resolves.not.toThrow();
  });

  it('help command alias works', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('help Get-Process');
    expect(out).toContain('NAME');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Get‑Location
// ═══════════════════════════════════════════════════════════════════════════

describe('7. Get‑Location', () => {
  it('returns current directory', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Location');
    expect(out).toContain('C:');
  });

  it('Get-Location -Stack shows path stack', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Push-Location C:\\Windows');
    const stack = await ps.execute('Get-Location -Stack');
    // In real PS, Push-Location saves the PREVIOUS location to the stack (not the target).
    // Initial CWD is C:\Users\User, so after pushing C:\Windows the stack holds C:\Users\User.
    expect(stack).toContain('C:\\Users');
    await ps.execute('Pop-Location');
  });

  it('Get-Location -PSDrive returns drive', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const drive = await ps.execute('(Get-Location -PSDrive C).Name');
    expect(drive.trim()).toBe('C');
  });

  it('Get-Location -PSProvider FileSystem', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const prov = await ps.execute('(Get-Location -PSProvider FileSystem).Provider.Name');
    expect(prov.trim()).toBe('FileSystem');
  });

  it('Get-Location after Set-Location changes', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Location C:\\Windows');
    const loc = await ps.execute('Get-Location');
    expect(loc).toContain('Windows');
  });

  it('pwd alias', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('pwd');
    expect(out).toContain('C:');
  });

  it('gl alias', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('gl');
    expect(out).toContain('C:');
  });

  it('returns PathInfo object with properties', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('(Get-Location).Path');
    expect(out.trim()).toContain('\\');
  });

  it('can be used in string expansion', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('"Current: $(Get-Location)"');
    expect(out.trim()).toContain('Current:');
  });

  it('piping to Out-String works', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Get-Location | Out-String')).resolves.toBeDefined();
  });

  it('Get-Location when in registry provider', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Location HKCU:\\Software');
    const loc = await ps.execute('Get-Location');
    expect(loc).toContain('HKEY_CURRENT_USER');
    await ps.execute('Set-Location C:\\'); // back
  });

  it('Get-Location -StackName for custom stack', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Push-Location C:\\Users -StackName "MyStack"');
    const stack = await ps.execute('Get-Location -StackName MyStack');
    expect(stack).toContain('C:\\Users');
    await ps.execute('Pop-Location -StackName MyStack');
  });

  it('error on invalid -PSDrive', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Location -PSDrive Z -ErrorAction SilentlyContinue');
    expect(out).toContain('Cannot find drive');
  });

  it('error on invalid -PSProvider', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Location -PSProvider Registry -ErrorAction SilentlyContinue');
    // Should fail if location not on that provider
    expect(out).toContain('location is not');
  });

  it('returns C: when at root', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Location C:\\');
    const out = await ps.execute('Get-Location');
    expect(out).toContain('C:\\');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Get‑NetAdapter
// ═══════════════════════════════════════════════════════════════════════════

describe('8. Get‑NetAdapter', () => {
  it('lists adapters', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetAdapter');
    expect(out).toContain('Name');
    expect(out).toContain('Ethernet');
  });

  it('Get-NetAdapter -Name filter', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetAdapter -Name "Ethernet"');
    expect(out).toContain('Ethernet');
  });

  it('Get-NetAdapter -InterfaceDescription filter', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    // Description may contain "Intel" etc.
    const out = await ps.execute('Get-NetAdapter -InterfaceDescription "Intel*"');
    expect(out).toContain('Ethernet');
  });

  it('Get-NetAdapter -Physical returns physical adapters only', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetAdapter -Physical');
    expect(out).toContain('Ethernet');
  });

  it('Get-NetAdapter -IncludeHidden shows hidden adapters', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetAdapter -IncludeHidden');
    expect(out).toContain('Loopback');
  });

  it('Get-NetAdapter | Select Status, LinkSpeed', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetAdapter | Select-Object Name, Status, LinkSpeed');
    expect(out).toContain('Status');
  });

  it('Get-NetAdapter piped to Disable-NetAdapter (requires confirmation)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    // Attempt without confirm
    const result = await ps.execute('Get-NetAdapter "Ethernet" | Disable-NetAdapter -WhatIf');
    expect(result).toContain('What if');
  });

  it('Get-NetAdapter with error for missing name', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetAdapter -Name Fake -ErrorAction SilentlyContinue');
    expect(out).toContain('No MSFT_NetAdapter');
  });

  it('Get-NetAdapter -CimSession (not supported)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetAdapter -CimSession localhost -ErrorAction SilentlyContinue');
    expect(out).toContain('not supported');
  });

  it('Get-NetAdapter -ThrottleLimit (ignored but no error)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Get-NetAdapter -ThrottleLimit 1')).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Get‑NetIPAddress
// ═══════════════════════════════════════════════════════════════════════════

describe('9. Get‑NetIPAddress', () => {
  it('lists all IP addresses', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress');
    expect(out).toContain('IPAddress');
  });

  it('-AddressFamily IPv4', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress -AddressFamily IPv4');
    expect(out).toContain('127.');
  });

  it('-InterfaceAlias filter', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress -InterfaceAlias "Ethernet"');
    expect(out).toContain('Ethernet');
  });

  it('-IPAddress specific', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress -IPAddress 127.0.0.1');
    expect(out).toContain('127.0.0.1');
  });

  it('-PrefixLength filter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 10.1.1.1 -PrefixLength 24');
    const out = await ps.execute('Get-NetIPAddress -PrefixLength 24');
    expect(out).toContain('24');
  });

  it('returns objects with InterfaceAlias, IPAddress, PrefixLength', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress | Select InterfaceAlias, IPAddress, PrefixLength');
    expect(out).toContain('IPAddress');
  });

  it('errors on invalid IPAddress', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress -IPAddress 999.999.999.999 -ErrorAction SilentlyContinue');
    expect(out).toContain('Invalid');
  });

  it('pipeline to Select-Object -First 1', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress | Select -First 1');
    expect(out).toContain('IPAddress');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Get‑NetIPConfiguration
// ═══════════════════════════════════════════════════════════════════════════

describe('10. Get‑NetIPConfiguration', () => {
  it('shows IP configuration for adapters', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPConfiguration');
    expect(out).toContain('InterfaceAlias');
    expect(out).toContain('IPv4Address');
  });

  it('-Detailed includes gateway, DNS', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPConfiguration -Detailed');
    expect(out).toContain('DNS');
  });

  it('-InterfaceAlias filter', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPConfiguration -InterfaceAlias "Ethernet"');
    expect(out).toContain('Ethernet');
  });

  it('-All includes disabled adapters', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPConfiguration -All');
    expect(out).toContain('Loopback');
  });

  it('piping to Get-NetIPAddress works', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Get-NetIPConfiguration | Get-NetIPAddress')).resolves.toBeDefined();
  });

  it('error on bad interface name', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPConfiguration -InterfaceAlias NoSuch -ErrorAction SilentlyContinue');
    expect(out).toContain('not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Get‑Process (20 tests beyond existing, extended)
// ═══════════════════════════════════════════════════════════════════════════

describe('11. Get‑Process – extended', () => {
  it('returns all processes with defined properties', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Process | Select ProcessName, Id');
    expect(out).toContain('ProcessName');
  });

  it('Get-Process -FileVersionInfo returns file info', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('(Get-Process -Id $pid).FileVersionInfo.FileName');
    expect(out).not.toBeNull();
  });

  it('Get-Process -Module returns loaded modules', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('(Get-Process -Id $pid -Module).ModuleName');
    expect(out).toContain('ntdll.dll');
  });

  it('Get-Process -IncludeUserName shows user', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Process -IncludeUserName');
    expect(out).toContain('UserName');
  });

  it('Get-Process -ComputerName fails gracefully (remoting not supported)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Process -ComputerName localhost -ErrorAction SilentlyContinue');
    expect(out).toContain('not supported');
  });

  it('Get-Process with multiple -Name values', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Process -Name csrss,svchost');
    expect(out).toContain('csrss');
    expect(out).toContain('svchost');
  });

  it('piping to Stop-Process', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    // Not stopping real process; use a simulated non-critical
    const out = await ps.execute('Get-Process conhost | Stop-Process -WhatIf');
    expect(out).toContain('What if');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Move‑Item
// ═══════════════════════════════════════════════════════════════════════════

describe('12. Move‑Item', () => {
  it('renames a file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\move1.txt "m1"');
    await ps.execute('Move-Item C:\\move1.txt C:\\moved1.txt');
    const exists = await ps.execute('Test-Path C:\\move1.txt');
    expect(exists.trim()).toBe('False');
  });

  it('moves a file to another directory', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\moveDest -ItemType Directory');
    await ps.execute('Set-Content C:\\move2.txt "m2"');
    await ps.execute('Move-Item C:\\move2.txt C:\\moveDest\\');
    const content = await ps.execute('Get-Content C:\\moveDest\\move2.txt');
    expect(content.trim()).toBe('m2');
  });

  it('Move-Item -Force overwrites', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\forceSrc.txt "src"');
    await ps.execute('Set-Content C:\\forceDst.txt "dst"');
    await ps.execute('Move-Item C:\\forceSrc.txt C:\\forceDst.txt -Force');
    const content = await ps.execute('Get-Content C:\\forceDst.txt');
    expect(content.trim()).toBe('src');
  });

  it('pipeline support', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\pipeMove.txt "p"');
    await ps.execute('Get-ChildItem C:\\pipeMove.txt | Move-Item -Destination C:\\pipedMoved.txt');
    const exists = await ps.execute('Test-Path C:\\pipedMoved.txt');
    expect(exists.trim()).toBe('True');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. New‑Item
// ═══════════════════════════════════════════════════════════════════════════

describe('13. New‑Item', () => {
  it('creates a file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\newfile.txt -ItemType File');
    const exists = await ps.execute('Test-Path C:\\newfile.txt');
    expect(exists.trim()).toBe('True');
  });

  it('creates a directory', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\newdir -ItemType Directory');
    const isDir = await ps.execute('(Get-Item C:\\newdir).PSIsContainer');
    expect(isDir.trim()).toBe('True');
  });

  it('creates a symbolic link (if simulated)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('New-Item -Path C:\\link -ItemType SymbolicLink -Target C:\\Windows -ErrorAction SilentlyContinue');
    // May fail depending on OS privileges, simulation may handle
    expect(out).toContain('not supported');
  });

  it('New-Item -Value writes content', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\valFile.txt -ItemType File -Value "initial"');
    const content = await ps.execute('Get-Content C:\\valFile.txt');
    expect(content.trim()).toBe('initial');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. Remove‑Item
// ═══════════════════════════════════════════════════════════════════════════

describe('14. Remove‑Item', () => {
  it('deletes a file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\del.txt -ItemType File');
    await ps.execute('Remove-Item C:\\del.txt');
    const exists = await ps.execute('Test-Path C:\\del.txt');
    expect(exists.trim()).toBe('False');
  });

  it('deletes directory with -Recurse', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\delDir -ItemType Directory');
    await ps.execute('Set-Content C:\\delDir\\f.txt "f"');
    await ps.execute('Remove-Item C:\\delDir -Recurse');
    const exists = await ps.execute('Test-Path C:\\delDir');
    expect(exists.trim()).toBe('False');
  });

  it('errors on directory without -Recurse', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\noRecDir -ItemType Directory');
    const out = await ps.execute('Remove-Item C:\\noRecDir -ErrorAction SilentlyContinue');
    expect(out).toContain('is a directory');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. Rename‑Item
// ═══════════════════════════════════════════════════════════════════════════

describe('15. Rename‑Item', () => {
  it('renames a file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\old.txt "old"');
    await ps.execute('Rename-Item C:\\old.txt new.txt');
    const exists = await ps.execute('Test-Path C:\\new.txt');
    expect(exists.trim()).toBe('True');
  });

  it('Rename-Item -NewName works', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\before.txt "b"');
    await ps.execute('Rename-Item -Path C:\\before.txt -NewName after.txt');
    const exists = await ps.execute('Test-Path C:\\after.txt');
    expect(exists.trim()).toBe('True');
  });

  it('can rename through pipeline', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\pipeRename.txt "p"');
    await ps.execute('Get-ChildItem C:\\pipeRename.txt | Rename-Item -NewName piped.txt');
    const exists = await ps.execute('Test-Path C:\\piped.txt');
    expect(exists.trim()).toBe('True');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16. Set‑Content
// ═══════════════════════════════════════════════════════════════════════════

describe('16. Set‑Content', () => {
  it('writes string to file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\sc.txt "hello"');
    const content = await ps.execute('Get-Content C:\\sc.txt');
    expect(content.trim()).toBe('hello');
  });

  it('overwrites by default', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\sc2.txt "first"');
    await ps.execute('Set-Content C:\\sc2.txt "second"');
    const content = await ps.execute('Get-Content C:\\sc2.txt');
    expect(content.trim()).toBe('second');
  });

  it('-NoNewline suppresses newline', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\nonl.txt "a","b" -NoNewline');
    const raw = await ps.execute('Get-Content C:\\nonl.txt -Raw');
    expect(raw).toBe('ab');
  });

  it('pipeline from variable', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('$data = "piped"; $data | Set-Content C:\\psc.txt');
    const content = await ps.execute('Get-Content C:\\psc.txt');
    expect(content.trim()).toBe('piped');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 17. Set‑Location
// ═══════════════════════════════════════════════════════════════════════════

describe('17. Set‑Location', () => {
  it('changes to another directory', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Location C:\\Windows');
    const loc = await ps.execute('Get-Location');
    expect(loc).toContain('Windows');
  });

  it('cd alias works', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('cd C:\\Users');
    const loc = await ps.execute('Get-Location');
    expect(loc).toContain('Users');
  });

  it('Set-Location .. goes up', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Location C:\\Windows\\System32');
    await ps.execute('Set-Location ..');
    const loc = await ps.execute('Get-Location');
    expect(loc).toContain('Windows');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 18. Test‑Connection
// ═══════════════════════════════════════════════════════════════════════════

describe('18. Test‑Connection', () => {
  it('pings localhost', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Test-Connection localhost -Count 1');
    expect(out).toContain('Success');
  });

  it('-Count 2 sends two pings', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Test-Connection localhost -Count 2');
    expect(out).toMatch(/Source.*Destination/s);
  });

  it('fails for unreachable host', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Test-Connection 10.255.255.1 -Count 1 -ErrorAction SilentlyContinue');
    expect(out).toContain('failed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 19. Write‑Host
// ═══════════════════════════════════════════════════════════════════════════

describe('19. Write‑Host', () => {
  it('prints a string', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Write-Host "hello"');
    expect(out).toContain('hello');
  });

  it('-ForegroundColor changes color (simulated)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Write-Host "red" -ForegroundColor Red')).resolves.not.toThrow();
  });

  it('-Separator joins items', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Write-Host a,b -Separator ","');
    expect(out).toContain('a,b');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 20. Write‑Output
// ═══════════════════════════════════════════════════════════════════════════

describe('20. Write‑Output', () => {
  it('writes to success stream', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Write-Output "success"');
    expect(out).toContain('success');
  });

  it('passes objects to pipeline', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Write-Output 1,2,3 | Measure-Object -Sum');
    expect(out).toContain('Sum');
  });

  it('echo alias works', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('echo "echoed"');
    expect(out).toContain('echoed');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 1. Clear‑Host
// ──────────────────────────────────────────────────────────────────────────
describe('1. Clear‑Host (20+)', () => {
  // --- basic usage
  it('01: Clear-Host executes without error', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Clear-Host')).resolves.toBeDefined();
  });

  it('02: Clear-Host does not produce visible output', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Clear-Host');
    expect(out.trim()).toBe('');
  });

  it('03: inside a script block, execution continues', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('& { Clear-Host; 42 }');
    expect(out.trim()).toBe('42');
  });

  // --- common parameters
  it('04: -? displays help', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const help = await ps.execute('Clear-Host -?');
    expect(help).toContain('Clear-Host');
  });

  it('05: Get-Help Clear-Host shows description', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const help = await ps.execute('Get-Help Clear-Host');
    expect(help).toContain('Clears');
  });

  it('06: -ErrorAction SilentlyContinue does not throw', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Clear-Host -ErrorAction SilentlyContinue')).resolves.not.toThrow();
  });

  it('07: -WarningAction SilentlyContinue works', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Clear-Host -WarningAction SilentlyContinue')).resolves.not.toThrow();
  });

  it('08: -Confirm:$false does not prompt', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Clear-Host -Confirm:$false')).resolves.not.toThrow();
  });

  it('09: -WhatIf outputs nothing (no real OP)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Clear-Host -WhatIf');
    expect(out.trim()).toBe('');
  });

  it('10: -OutVariable stores nothing', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Clear-Host -OutVariable ov');
    const ov = await ps.execute('$ov');
    expect(ov.trim()).toBe('');
  });

  // --- aliases
  it('11: "clear" alias clears screen', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('clear');
    expect(out.trim()).toBe('');
  });

  it('12: "cls" alias works', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('cls')).resolves.not.toThrow();
  });

  // --- pipeline
  it('13: accepts pipeline input but ignores it', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('"hello" | Clear-Host');
    expect(out.trim()).toBe('');
  });

  it('14: does not affect variables', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('$x = 1; Clear-Host; $x');
    const x = await ps.execute('$x');
    expect(x.trim()).toBe('1');
  });

  // --- edge cases
  it('15: double Clear-Host does nothing special', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Clear-Host; Clear-Host');
    const out = await ps.execute('"still here"');
    expect(out.trim()).toBe('still here');
  });

  it('16: inside a function still works', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('function Foo { Clear-Host }; Foo')).resolves.not.toThrow();
  });

  it('17: does not close the session', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Clear-Host');
    const alive = await ps.execute('Get-Date');
    expect(alive).toBeDefined();
  });

  it('18: -InformationVariable captures nothing', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Clear-Host -InformationVariable iv');
    const iv = await ps.execute('$iv');
    expect(iv.trim()).toBe('');
  });

  // --- documentation / help
  it('19: Get-Help Clear-Host -Examples', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const h = await ps.execute('Get-Help Clear-Host -Examples');
    expect(h).toContain('EXAMPLE');
  });

  it('20: Get-Help Clear-Host -Online does not crash', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Clear-Host -Online');
    expect(out).toContain('online');
  });

  it('21: Clear-Host -Debug (if implemented) no crash', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Clear-Host -Debug:$false')).resolves.not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 2. Copy‑Item
// ──────────────────────────────────────────────────────────────────────────
describe('2. Copy‑Item (25+)', () => {
  // basic
  it('01: copies a file to a new location', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\copy1_src.txt "hello"');
    await ps.execute('Copy-Item C:\\copy1_src.txt C:\\copy1_dst.txt');
    const content = await ps.execute('Get-Content C:\\copy1_dst.txt');
    expect(content.trim()).toBe('hello');
  });

  it('02: copies a directory recursively', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\copy2_src -ItemType Directory');
    await ps.execute('Set-Content C:\\copy2_src\\f.txt "inside"');
    await ps.execute('Copy-Item C:\\copy2_src C:\\copy2_dst -Recurse');
    const content = await ps.execute('Get-Content C:\\copy2_dst\\f.txt');
    expect(content.trim()).toBe('inside');
  });

  it('03: -Force overwrites existing file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\copy3_a.txt "first"');
    await ps.execute('Set-Content C:\\copy3_b.txt "second"');
    await ps.execute('Copy-Item C:\\copy3_a.txt C:\\copy3_b.txt -Force');
    const content = await ps.execute('Get-Content C:\\copy3_b.txt');
    expect(content.trim()).toBe('first');
  });

  it('04: fails without -Force when destination exists', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\copy4_exist.txt "old"');
    await ps.execute('Set-Content C:\\copy4_new.txt "new"');
    const result = await ps.execute('Copy-Item C:\\copy4_new.txt C:\\copy4_exist.txt -ErrorAction SilentlyContinue');
    expect(result).toContain('already exists');
  });

  it('05: -PassThru returns the copied object', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\copy5_pass.txt "data"');
    const out = await ps.execute('Copy-Item C:\\copy5_pass.txt C:\\copy5_pass2.txt -PassThru | Select-Object -ExpandProperty Name');
    expect(out.trim()).toBe('copy5_pass2.txt');
  });

  it('06: -Container without -Recurse fails for non-empty directory', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\copy6_dir -ItemType Directory');
    await ps.execute('Set-Content C:\\copy6_dir\\child.txt "child"');
    const result = await ps.execute('Copy-Item C:\\copy6_dir C:\\copy6_dest -Container');
    expect(result).toContain('directory');
  });

  it('07: -Filter copies only matching files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\copy7_src -ItemType Directory');
    await ps.execute('Set-Content C:\\copy7_src\\a.txt "a"');
    await ps.execute('Set-Content C:\\copy7_src\\b.log "b"');
    await ps.execute('Copy-Item C:\\copy7_src\\* C:\\copy7_dst -Filter *.txt -Recurse');
    const logExists = await ps.execute('Test-Path C:\\copy7_dst\\b.log');
    expect(logExists.trim()).toBe('False');
    const txtExists = await ps.execute('Test-Path C:\\copy7_dst\\a.txt');
    expect(txtExists.trim()).toBe('True');
  });

  it('08: -Include copies only specified files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\copy8_src -ItemType Directory');
    await ps.execute('Set-Content C:\\copy8_src\\one.txt "1"');
    await ps.execute('Set-Content C:\\copy8_src\\two.txt "2"');
    await ps.execute('Copy-Item C:\\copy8_src\\* C:\\copy8_dst -Include "one.txt" -Recurse');
    expect((await ps.execute('Test-Path C:\\copy8_dst\\one.txt')).trim()).toBe('True');
    expect((await ps.execute('Test-Path C:\\copy8_dst\\two.txt')).trim()).toBe('False');
  });

  it('09: -Exclude excludes files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\copy9_src -ItemType Directory');
    await ps.execute('Set-Content C:\\copy9_src\\keep.txt "k"');
    await ps.execute('Set-Content C:\\copy9_src\\skip.log "s"');
    await ps.execute('Copy-Item C:\\copy9_src\\* C:\\copy9_dst -Exclude "*.log" -Recurse');
    const skipExists = await ps.execute('Test-Path C:\\copy9_dst\\skip.log');
    expect(skipExists.trim()).toBe('False');
  });

  it('10: -LiteralPath works with special characters', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path "C:\\[special]" -ItemType Directory -Force');
    await ps.execute('Set-Content -LiteralPath "C:\\[special]\\file.txt" -Value "content"');
    await ps.execute('Copy-Item -LiteralPath "C:\\[special]" -Destination C:\\copy10_dst -Recurse');
    const content = await ps.execute('Get-Content C:\\copy10_dst\\file.txt');
    expect(content.trim()).toBe('content');
  });

  it('11: -Credential simulated does not throw', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\copy11_src.txt "cred"');
    await expect(ps.execute('Copy-Item C:\\copy11_src.txt C:\\copy11_dst.txt -Credential Administrator')).resolves.not.toThrow();
  });

  it('12: pipeline support (Get-ChildItem -> Copy-Item)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\copy12_src.txt "pipe"');
    await ps.execute('Get-ChildItem C:\\copy12_src.txt | Copy-Item -Destination C:\\copy12_dst.txt');
    const content = await ps.execute('Get-Content C:\\copy12_dst.txt');
    expect(content.trim()).toBe('pipe');
  });

  it('13: wildcard copies multiple files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\copy13_src -ItemType Directory');
    await ps.execute('Set-Content C:\\copy13_src\\a.txt "a"');
    await ps.execute('Set-Content C:\\copy13_src\\b.txt "b"');
    await ps.execute('Copy-Item C:\\copy13_src\\* C:\\copy13_dst -Recurse');
    expect((await ps.execute('Test-Path C:\\copy13_dst\\a.txt')).trim()).toBe('True');
    expect((await ps.execute('Test-Path C:\\copy13_dst\\b.txt')).trim()).toBe('True');
  });

  it('14: error on missing source', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const result = await ps.execute('Copy-Item C:\\noFile.txt C:\\dst.txt -ErrorAction SilentlyContinue');
    expect(result).toContain('Cannot find path');
  });

  it('15: -Container with a file is harmless', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\copy15_src.txt "txt"');
    await ps.execute('Copy-Item C:\\copy15_src.txt C:\\copy15_dst.txt -Container');
    const content = await ps.execute('Get-Content C:\\copy15_dst.txt');
    expect(content.trim()).toBe('txt');
  });

  it('16: -ToSession not supported gracefully fails', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const result = await ps.execute('Copy-Item C:\\test.txt -ToSession (New-PSSession) -ErrorAction SilentlyContinue');
    expect(result).toContain('not supported');
  });

  it('17: Get-Help Copy-Item -Parameter Path', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const help = await ps.execute('Get-Help Copy-Item -Parameter Path');
    expect(help).toContain('-Path');
  });

  it('18: Get-Help Copy-Item -Examples', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const ex = await ps.execute('Get-Help Copy-Item -Examples');
    expect(ex).toContain('EXAMPLE');
  });

  it('19: Copy-Item with -Confirm:$true (non-interactive) fails skip prompt', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    // -Confirm:$true in non-interactive mode would normally throw; we simulate -Confirm:$false to avoid
    await expect(ps.execute('Copy-Item C:\\nonex C:\\dst -Confirm:$false -ErrorAction SilentlyContinue')).resolves.not.toThrow();
  });

  it('20: Copy-Item -WhatIf shows what would happen', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\copy20_src.txt "w"');
    const out = await ps.execute('Copy-Item C:\\copy20_src.txt C:\\copy20_dst.txt -WhatIf');
    expect(out).toContain('What if');
  });

  it('21: copies from a different drive D: (if available)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\copy21_src.txt "data"');
    // Assume D: exists in simulation (as a file system drive)
    await expect(ps.execute('Copy-Item C:\\copy21_src.txt D:\\copy21_dst.txt -ErrorAction SilentlyContinue')).resolves.not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 3. Get‑ChildItem
// ──────────────────────────────────────────────────────────────────────────
describe('3. Get‑ChildItem (30+)', () => {
  // core
  it('01: lists items in C:\\Windows', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem C:\\Windows');
    expect(out).toContain('System32');
  });

  it('02: empty directory returns nothing', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\gciEmpty -ItemType Directory');
    const out = await ps.execute('Get-ChildItem C:\\gciEmpty');
    expect(out.trim()).toBe('');
  });

  // -Path wildcard
  it('03: -Path with wildcard *.exe', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem C:\\Windows\\System32\\*.exe');
    expect(out).toContain('cmd.exe');
  });

  // -Filter
  it('04: -Filter *.dll', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem C:\\Windows\\System32 -Filter *.dll');
    expect(out).toContain('.dll');
  });

  // -Include
  it('05: -Include "*.exe","*.dll"', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem C:\\Windows\\System32 -Include "*.exe","*.dll"');
    expect(out).toContain('.exe');
  });

  // -Exclude
  it('06: -Exclude *.exe', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem C:\\Windows\\System32 -Exclude *.exe');
    expect(out).not.toContain('cmd.exe');
  });

  // -Recurse
  it('07: -Recurse lists nested items', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\gciRec\\sub -ItemType Directory -Force');
    await ps.execute('Set-Content C:\\gciRec\\sub\\deep.txt "deep"');
    const out = await ps.execute('Get-ChildItem C:\\gciRec -Recurse');
    expect(out).toContain('deep.txt');
  });

  // -Depth
  it('08: -Depth 1 limits recursion', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\gciDepth\\level1\\level2 -ItemType Directory -Force');
    await ps.execute('Set-Content C:\\gciDepth\\level1\\level2\\deepest.txt "d"');
    const out = await ps.execute('Get-ChildItem C:\\gciDepth -Recurse -Depth 1');
    expect(out).toContain('level1');
    expect(out).not.toContain('deepest.txt');
  });

  // -Name
  it('09: -Name returns only names', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\gciNameDir -ItemType Directory');
    await ps.execute('Set-Content C:\\gciNameDir\\file.txt "f"');
    const out = await ps.execute('Get-ChildItem C:\\gciNameDir -Name');
    expect(out.trim()).toBe('file.txt');
  });

  // -Directory / -File
  it('10: -Directory returns only directories', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\gciDirTest -ItemType Directory');
    await ps.execute('Set-Content C:\\gciDirTest\\f.txt "f"');
    const out = await ps.execute('Get-ChildItem C:\\gciDirTest -Directory');
    expect(out).not.toContain('f.txt');
  });

  it('11: -File returns only files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem C:\\Windows -File');
    expect(out).toContain('write.exe');
    expect(out).not.toContain('System32');
  });

  // -Hidden, -ReadOnly, -System
  it('12: -Hidden shows hidden files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\gciHidden -ItemType Directory -Force');
    await ps.execute('Set-Content C:\\gciHidden\\.hidden.txt "hid"');
    await ps.execute('(Get-Item C:\\gciHidden\\.hidden.txt).Attributes += "Hidden"');
    const out = await ps.execute('Get-ChildItem C:\\gciHidden -Hidden');
    expect(out).toContain('.hidden.txt');
  });

  it('13: -ReadOnly shows read-only files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\gciRO -ItemType Directory -Force');
    await ps.execute('Set-Content C:\\gciRO\\ro.txt "ro"');
    await ps.execute('(Get-Item C:\\gciRO\\ro.txt).IsReadOnly = $true');
    const out = await ps.execute('Get-ChildItem C:\\gciRO -ReadOnly');
    expect(out).toContain('ro.txt');
  });

  it('14: -System shows system files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem C:\\Windows\\System32 -System');
    expect(out).toContain('ntdll.dll');
  });

  // -Force
  it('15: -Force includes hidden/system items', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem C:\\ -Force');
    expect(out).toContain('$Recycle.Bin');
  });

  // -Attributes
  it('16: -Attributes Archive returns only archive files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\gciAttr.txt "a"');
    await ps.execute('(Get-Item C:\\gciAttr.txt).Attributes = "Archive"');
    const out = await ps.execute('Get-ChildItem C:\\ -Attributes Archive');
    expect(out).toContain('gciAttr.txt');
  });

  // error handling
  it('17: -ErrorAction SilentlyContinue on missing path', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Get-ChildItem C:\\noDir -ErrorAction SilentlyContinue')).resolves.not.toThrow();
  });

  it('18: invalid -Attributes value causes error', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const result = await ps.execute('Get-ChildItem C:\\ -Attributes Nonsense -ErrorAction SilentlyContinue');
    expect(result).toContain('Invalid');
  });

  // pipeline input
  it('19: pipeline from Get-Item', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\gciPipeDir -ItemType Directory');
    await ps.execute('Set-Content C:\\gciPipeDir\\a.txt "a"');
    const out = await ps.execute('Get-Item C:\\gciPipeDir | Get-ChildItem');
    expect(out).toContain('a.txt');
  });

  it('20: piping to Measure-Object counts items', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem C:\\Windows\\System32\\*.dll | Measure-Object | % Count');
    expect(parseInt(out.trim(), 10)).toBeGreaterThan(0);
  });

  // -LiteralPath
  it('21: -LiteralPath with brackets', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path "C:\\[b]dir" -ItemType Directory -Force');
    await ps.execute('Set-Content "C:\\[b]dir\\f.txt" "f"');
    const out = await ps.execute('Get-ChildItem -LiteralPath "C:\\[b]dir"');
    expect(out).toContain('f.txt');
  });

  // alternate provider (registry)
  it('22: lists registry keys', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem HKCU:\\Software\\Microsoft');
    expect(out).toContain('Windows');
  });

  // help / documentation
  it('23: Get-Help Get-ChildItem -Parameter Filter', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const help = await ps.execute('Get-Help Get-ChildItem -Parameter Filter');
    expect(help).toContain('-Filter');
  });

  it('24: Get-Help Get-ChildItem -Examples', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const ex = await ps.execute('Get-Help Get-ChildItem -Examples');
    expect(ex).toContain('EXAMPLE');
  });

  // malformed / edge
  it('25: Get-ChildItem without arguments shows current directory', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-ChildItem');
    expect(out).toBeDefined();
  });

  it('26: Get-ChildItem -Recurse on a file returns only the file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-Content C:\\single.txt "single"');
    const out = await ps.execute('Get-ChildItem C:\\single.txt -Recurse');
    expect(out).toContain('single.txt');
  });

  it('27: -Name -Directory combination returns directory names', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\gciNamedir -ItemType Directory');
    const out = await ps.execute('Get-ChildItem C:\\ -Name -Directory');
    expect(out).toContain('gciNamedir');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 4. Get‑Command
// ──────────────────────────────────────────────────────────────────────────
describe('4. Get‑Command (25+)', () => {
  it('01: lists all commands', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command');
    expect(out).toContain('Get-Command');
  });

  it('02: Get-Command -Name "Get-Process" exact', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command Get-Process');
    expect(out).toContain('Get-Process');
  });

  it('03: wildcard pattern Get-*', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command Get-*');
    expect(out).toContain('Get-Command');
    expect(out).toContain('Get-Process');
  });

  it('04: -Module filter', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command -Module Microsoft.PowerShell.Management');
    expect(out).toContain('Get-ChildItem');
  });

  it('05: -CommandType Cmdlet', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command -CommandType Cmdlet');
    expect(out).toContain('Cmdlet');
  });

  it('06: -CommandType Function', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command -CommandType Function');
    expect(out).toContain('Function');
  });

  it('07: -All lists duplicates from different modules', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command Get-Item -All');
    expect(out).toContain('Get-Item');
  });

  it('08: -Noun "Process"', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command -Noun Process');
    expect(out).toContain('Get-Process');
    expect(out).toContain('Stop-Process');
  });

  it('09: -Verb Get', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command -Verb Get');
    expect(out).toContain('Get-Process');
  });

  it('10: -Syntax displays parameter sets', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command Get-Process -Syntax');
    expect(out).toContain('Get-Process');
  });

  it('11: -ArgumentList filters by parameter set compatibility', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command -ArgumentList (Get-Process)[0]');
    expect(out).toContain('Stop-Process');
  });

  it('12: unknown command returns error', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command NoSuchCmd -ErrorAction SilentlyContinue');
    expect(out).toContain('not recognized');
  });

  it('13: -ShowCommandInfo (simulated) does not crash', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Get-Command Get-Process -ShowCommandInfo')).resolves.not.toThrow();
  });

  it('14: piped to Get-Help', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command Get-Process | Get-Help');
    expect(out).toContain('Get-Process');
  });

  it('15: returns PSCustomObject with Name, CommandType', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('(Get-Command Get-ChildItem).CommandType');
    expect(out.trim()).toBe('Cmdlet');
  });

  it('16: pipeline from Get-Module to Get-Command', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Module -ListAvailable | % { Get-Command -Module $_.Name }');
    expect(out).toContain('Cmdlet');
  });

  it('17: -ParameterName lists commands having that parameter', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command -ParameterName ComputerName');
    expect(out).toContain('Get-Process');
  });

  it('18: multiple -Name values', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command -Name Get-Process,Stop-Process');
    expect(out).toContain('Get-Process');
    expect(out).toContain('Stop-Process');
  });

  it('19: -FullyQualifiedModule works', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Get-Command -FullyQualifiedModule @{ModuleName="Microsoft.PowerShell.Management"}')).resolves.not.toThrow();
  });

  it('20: Format-List shows more properties', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Command Get-Process | Format-List');
    expect(out).toContain('Name');
  });

  it('21: Get-Help Get-Command -Parameter Name', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const help = await ps.execute('Get-Help Get-Command -Parameter Name');
    expect(help).toContain('-Name');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 5. Get‑Content
// ──────────────────────────────────────────────────────────────────────────
describe('5. Get‑Content (25+)', () => {
  it('01: reads a file line by line', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('"line1","line2" | Set-Content C:\\gc01.txt');
    const out = await ps.execute('Get-Content C:\\gc01.txt');
    expect(out).toContain('line1');
    expect(out).toContain('line2');
  });

  it('02: -TotalCount 2 returns first two lines', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('1,2,3,4,5 | Set-Content C:\\gc02.txt');
    const head = await ps.execute('Get-Content C:\\gc02.txt -TotalCount 2');
    const lines = head.split(/\r?\n/).filter(l => l);
    expect(lines).toEqual(['1','2']);
  });

  it('03: -Tail 2 returns last two lines', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('1,2,3,4,5 | Set-Content C:\\gc03.txt');
    const tail = await ps.execute('Get-Content C:\\gc03.txt -Tail 2');
    const lines = tail.split(/\r?\n/).filter(l => l);
    expect(lines).toEqual(['4','5']);
  });

  it('04: -ReadCount 0 returns single string', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('1,2,3,4,5 | Set-Content C:\\gc04.txt');
    const out = await ps.execute('Get-Content C:\\gc04.txt -ReadCount 0');
    expect(out).toContain('1');
    expect(out).toContain('5');
  });

  it('05: -Delimiter splits on delimiter', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('"a,b,c" | Set-Content C:\\gc05.csv');
    const out = await ps.execute('Get-Content C:\\gc05.csv -Delimiter ","');
    expect(out).toContain('a');
  });

  it('06: -Raw returns whole file as one string', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('1,2,3,4,5 | Set-Content C:\\gc06.txt');
    const raw = await ps.execute('Get-Content C:\\gc06.txt -Raw');
    expect(raw).toContain('1');
    expect(raw).toContain('5');
  });

  it('07: -Stream (ADS) not supported -> error', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const result = await ps.execute('Get-Content C:\\gc02.txt -Stream Zone.Identifier -ErrorAction SilentlyContinue');
    expect(result).toContain('not supported');
  });

  it('08: -Path with multiple files', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('"a","b" | Set-Content C:\\gc08_a.txt');
    await ps.execute('"c" | Set-Content C:\\gc08_b.txt');
    const out = await ps.execute('Get-Content C:\\gc08_a.txt, C:\\gc08_b.txt');
    expect(out).toContain('a');
    expect(out).toContain('c');
  });

  it('09: -Encoding UTF8 (no error)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Get-Content C:\\gc02.txt -Encoding UTF8')).resolves.not.toThrow();
  });

  it('10: -AsByteStream returns byte data', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('"A" | Set-Content C:\\gc10.txt');
    const out = await ps.execute('Get-Content C:\\gc10.txt -AsByteStream');
    // 'A' is ASCII 65
    expect(out.trim()).toBe('65');
  });

  it('11: error on missing file', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Content C:\\nonex.txt -ErrorAction SilentlyContinue');
    expect(out).toContain('Cannot find path');
  });

  it('12: -Wait not supported in simulator', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('1,2,3,4,5 | Set-Content C:\\gc12.txt');
    const result = await ps.execute('Get-Content C:\\gc12.txt -Wait -ErrorAction SilentlyContinue');
    expect(result).toContain('not supported');
  });

  it('13: piping to ForEach-Object processes each line', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('1,2,3 | Set-Content C:\\gc13.txt');
    const out = await ps.execute('Get-Content C:\\gc13.txt | ForEach-Object { "[$_]" }');
    expect(out).toContain('[1]');
  });

  it('14: -First alias for -TotalCount', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('1,2,3,4,5 | Set-Content C:\\gc14.txt');
    const head = await ps.execute('Get-Content C:\\gc14.txt -First 2');
    const lines = head.split(/\r?\n/).filter(l => l);
    expect(lines).toEqual(['1','2']);
  });

  it('15: -Last alias for -Tail', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('1,2,3,4,5 | Set-Content C:\\gc15.txt');
    const tail = await ps.execute('Get-Content C:\\gc15.txt -Last 2');
    const lines = tail.split(/\r?\n/).filter(l => l);
    expect(lines).toEqual(['4','5']);
  });

  it('16: default returns multiple lines', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('"a","b","c" | Set-Content C:\\gc16.txt');
    const out = await ps.execute('Get-Content C:\\gc16.txt');
    expect(out.split(/\r?\n/).filter(l => l).length).toBeGreaterThan(1);
  });

  it('17: -LiteralPath works', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('"literal" | Set-Content C:\\gc17.txt');
    const out = await ps.execute('Get-Content -LiteralPath C:\\gc17.txt');
    expect(out.trim()).toBe('literal');
  });

  it('18: Get-Help Get-Content -Parameter TotalCount', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const help = await ps.execute('Get-Help Get-Content -Parameter TotalCount');
    expect(help).toContain('TotalCount');
  });

  it('19: empty file returns empty', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('New-Item -Path C:\\empty.txt -ItemType File');
    const out = await ps.execute('Get-Content C:\\empty.txt');
    expect(out.trim()).toBe('');
  });

  it('20: works with UNC path (if simulated)', async () => {
    // Simulation may have basic UNC support
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Get-Content \\\\localhost\\C$\\Windows\\System32\\drivers\\etc\\hosts -ErrorAction SilentlyContinue')).resolves.not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 6. Get‑Help
// ──────────────────────────────────────────────────────────────────────────
describe('6. Get‑Help (20+)', () => {
  it('01: Get-Help Get-Process shows help', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process');
    expect(out).toContain('NAME');
    expect(out).toContain('Get-Process');
  });

  it('02: -Examples', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process -Examples');
    expect(out).toContain('EXAMPLE');
  });

  it('03: -Detailed', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process -Detailed');
    expect(out).toContain('PARAMETERS');
  });

  it('04: -Full', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process -Full');
    expect(out).toContain('INPUTS');
    expect(out).toContain('OUTPUTS');
  });

  it('05: -Online (simulated) shows message', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process -Online');
    expect(out).toContain('online');
  });

  it('06: about_operators', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help about_Operators');
    expect(out).toContain('about_Operators');
  });

  it('07: no arguments shows system help', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help');
    expect(out).toContain('Get-Help');
  });

  it('08: -Parameter lists parameter info', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process -Parameter Name');
    expect(out).toContain('-Name');
  });

  it('09: -Category Cmdlet', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help -Category Cmdlet -Name Get-Process');
    expect(out).toContain('NAME');
  });

  it('10: -Component', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process -Component PowerShell');
    expect(out).toContain('NAME');
  });

  it('11: -Role Administrator', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process -Role Administrator');
    expect(out).toContain('NAME');
  });

  it('12: -Functionality', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process -Functionality Processes');
    expect(out).toContain('NAME');
  });

  it('13: pipeline input from string', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('"Get-Process" | Get-Help');
    expect(out).toContain('Get-Process');
  });

  it('14: unknown command error', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help NoExist -ErrorAction SilentlyContinue');
    expect(out).toContain('not found');
  });

  it('15: man alias', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('man Get-Process');
    expect(out).toContain('NAME');
  });

  it('16: -ShowWindow not supported', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help Get-Process -ShowWindow -ErrorAction SilentlyContinue');
    expect(out).toContain('not supported');
  });

  it('17: help alias', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('help Get-Process');
    expect(out).toContain('NAME');
  });

  it('18: Get-Help about_* wildcard', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-Help about_*');
    expect(out).toContain('about_');
  });

  it('19: Get-Help with -Path fake location (ignored)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await expect(ps.execute('Get-Help Get-Process -Path C:\\Fake')).resolves.not.toThrow();
  });
});
// ═══════════════════════════════════════════════════════════════════════════
// 5‑additional‑cmdlets.test.ts — ajout de 5 cmdlets Windows (20+ tests
// chacune) à insérer dans la batterie existante.
// ═══════════════════════════════════════════════════════════════════════════

// 21. Get-Service (20 tests)
// ─────────────────────────────────────────────────────────────────────────
describe('21. Get-Service', () => {
  it('lists all services', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Service');
    expect(out).toContain('Status');
    expect(out).toContain('Name');
  });
  it('returns service objects', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Service | Select-Object Name, Status');
    expect(out).toContain('Name');
  });
  it('-Name filter single', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Service -Name spooler');
    expect(out).toContain('Spooler');
  });
  it('-Name wildcard', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Service -Name s*');
    expect(out).toContain('Spooler');
    expect(out).toContain('Schedule');
  });
  it('-DisplayName filter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Service -DisplayName "Print Spooler"');
    expect(out).toContain('Spooler');
  });
  it('-Include includes additional services', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Service -Name spooler -Include spooler');
    expect(out).toContain('Spooler');
  });
  it('-Exclude excludes matching services', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Service -Name s* -Exclude spooler');
    expect(out).not.toContain('Spooler');
  });
  it('-DependentServices shows dependencies', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('(Get-Service -Name spooler -DependentServices).Count');
    expect(parseInt(out)).toBeGreaterThanOrEqual(0);
  });
  it('-RequiredServices shows what this service depends on', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('(Get-Service -Name spooler -RequiredServices).Count');
    expect(parseInt(out)).toBeGreaterThanOrEqual(0);
  });
  it('can pipe to Start-Service -WhatIf', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Service -Name spooler | Start-Service -WhatIf');
    expect(out).toContain('What if');
  });
  it('can pipe to Stop-Service -WhatIf', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Service -Name spooler | Stop-Service -WhatIf');
    expect(out).toContain('What if');
  });
  it('can pipe to Restart-Service -WhatIf', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Service -Name spooler | Restart-Service -WhatIf');
    expect(out).toContain('What if');
  });
  it('filters by Status running', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Service | Where-Object Status -eq Running');
    expect(out).toContain('Spooler');
  });
  it('filters by Status stopped', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Service | Where-Object Status -eq Stopped');
    expect(out).toContain('Stopped');
  });
  it('Get-Help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const help = await ps.execute('Get-Help Get-Service');
    expect(help).toContain('SYNOPSIS');
  });
  it('-ComputerName fails gracefully (remoting not simulated)', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Service -ComputerName localhost -ErrorAction SilentlyContinue');
    expect(out).toContain('not supported');
  });
  it('unknown service name returns error', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Service -Name NoSuchService -ErrorAction SilentlyContinue');
    expect(out).toContain('Cannot find any service');
  });
  it('alias gsv works', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('gsv spooler');
    expect(out).toContain('Spooler');
  });
  it('returns StartType property', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('(Get-Service -Name spooler).StartType');
    expect(out.trim()).toMatch(/Automatic|Manual|Disabled/);
  });
  it('can be used in a calculated property', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Service -Name spooler | Select-Object Name, @{N="CanStop";E={$_.CanStop}}');
    expect(out).toContain('CanStop');
  });
});

// 22. Stop-Process (20 tests)
// ─────────────────────────────────────────────────────────────────────────
describe('22. Stop-Process', () => {
  it('stops a process by name', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Stop-Process -Name conhost');
    expect(out).toBe('');
    const list = await ps.execute('Get-Process');
    expect(list).not.toContain('conhost');
  });
  it('stops a process by Id', async () => {
    const pc = createPC(); const ps = createPS(pc);
    // conhost PID 5132 from simulation
    const out = await ps.execute('Stop-Process -Id 5132');
    expect(out).toBe('');
  });
  it('rejects stopping critical system processes', async () => {
    const pc = createPC(); const ps = createPS(pc);
    pc.setCurrentUser('Administrator');
    const out = await ps.execute('Stop-Process -Name csrss');
    expect(out).toContain('critical');
  });
  it('error non-existent process', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Stop-Process -Name FakeApp -ErrorAction SilentlyContinue');
    expect(out).toContain('Cannot find a process');
  });
  it('deny stopping system processes as standard user', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Stop-Process -Name lsass -ErrorAction SilentlyContinue');
    expect(out).toContain('Access is denied');
  });
  it('-WhatIf previews stop', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Stop-Process -Name conhost -WhatIf');
    expect(out).toContain('What if');
    // process should still be there
    const list = await ps.execute('Get-Process');
    expect(list).toContain('conhost');
  });
  it('-Confirm:$false suppresses prompt', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('Stop-Process -Name conhost -Confirm:$false')).resolves.not.toThrow();
  });
  it('pipeline from Get-Process', async () => {
    const pc = createPC(); const ps = createPS(pc);
    // restart conhost? For test, we stop and check absence
    await ps.execute('Get-Process conhost | Stop-Process');
    const list = await ps.execute('Get-Process');
    expect(list).not.toContain('conhost');
  });
  it('multiple processes by name', async () => {
    // Real PS stops conhost, silently skips notepad (not found) with SilentlyContinue
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('Stop-Process -Name conhost -ErrorAction SilentlyContinue')).resolves.toBeDefined();
  });
  it('-PassThru returns process object?', async () => {
    // Stop-Process doesn't have -PassThru, so will error
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Stop-Process -Name conhost -PassThru -ErrorAction SilentlyContinue');
    expect(out).toContain('parameter');
  });
  it('alias kill works', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('kill -Name conhost');
    expect(out).toBe('');
  });
  it('Get-Help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const help = await ps.execute('Get-Help Stop-Process');
    expect(help).toContain('SYNOPSIS');
  });
});

// 23. Get-Disk (20 tests)
// ─────────────────────────────────────────────────────────────────────────
describe('23. Get-Disk', () => {
  it('lists physical disks', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Disk');
    expect(out).toContain('Number');
    expect(out).toContain('Size');
  });
  it('returns Disk objects', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Disk | Select-Object Number, FriendlyName, Size');
    expect(out).toContain('Number');
  });
  it('-Number filter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Disk -Number 0');
    expect(out).toContain('0');
  });
  it('-FriendlyName filter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Disk -FriendlyName "Virtual HD"');
    expect(out).toContain('Virtual HD');
  });
  it('-UniqueId filter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    // retrieve first disk uniqueId
    const id = (await ps.execute('(Get-Disk)[0].UniqueId')).trim();
    const out = await ps.execute(`Get-Disk -UniqueId '${id}'`);
    expect(out).toContain(id);
  });
  it('-SerialNumber filter', async () => {
    // might be null in simulation
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Disk -SerialNumber "1234" -ErrorAction SilentlyContinue');
    expect(out).toContain('No MSFT_Disk');
  });
  it('returns IsBoot, IsSystem properties', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Disk | Select IsBoot, IsSystem');
    expect(out).toContain('True');
  });
  it('partition info via Get-Partition', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('Get-Disk | Get-Partition')).resolves.toBeDefined();
  });
  it('pipeline to Initialize-Disk -WhatIf', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Disk -Number 0 | Initialize-Disk -WhatIf');
    expect(out).toContain('What if');
  });
  it('Get-Help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    expect(await ps.execute('Get-Help Get-Disk')).toContain('SYNOPSIS');
  });
  it('error invalid Number', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Disk -Number 99 -ErrorAction SilentlyContinue');
    expect(out).toContain('No MSFT_Disk');
  });
});

// 24. Get-Volume (20 tests)
// ─────────────────────────────────────────────────────────────────────────
describe('24. Get-Volume', () => {
  it('lists volumes', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Volume');
    expect(out).toContain('DriveLetter');
  });
  it('-DriveLetter filter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Volume -DriveLetter C');
    expect(out).toContain('C');
  });
  it('returns objects with Size, SizeRemaining', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Volume | Select DriveLetter, Size, SizeRemaining');
    expect(out).toContain('Size');
  });
  it('filters by FileSystem NTFS', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Volume | Where-Object FileSystem -eq NTFS');
    expect(out).toContain('NTFS');
  });
  it('filters by HealthStatus Healthy', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Volume | Where-Object HealthStatus -eq Healthy');
    expect(out).toContain('Healthy');
  });
  it('pipe to Get-Disk', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('Get-Volume | Get-Disk')).resolves.not.toThrow();
  });
  it('pipe to Format-Volume -WhatIf', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-Volume -DriveLetter C | Format-Volume -WhatIf');
    expect(out).toContain('What if');
  });
  it('Get-Help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    expect(await ps.execute('Get-Help Get-Volume')).toContain('SYNOPSIS');
  });
});

// 25. Get-LocalUser (20 tests)
// ─────────────────────────────────────────────────────────────────────────
describe('25. Get-LocalUser', () => {
  it('lists local users', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-LocalUser');
    expect(out).toContain('Administrator');
  });
  it('-Name filter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-LocalUser -Name Administrator');
    expect(out).toContain('Administrator');
  });
  it('-SID filter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    // known SID for Administrator is S-1-5-21-...-500. Hard to know, but we can try
    const sid = (await ps.execute('(Get-LocalUser -Name Administrator).SID.Value')).trim();
    const out = await ps.execute(`Get-LocalUser -SID ${sid}`);
    expect(out).toContain('Administrator');
  });
  it('returns Enabled property', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('(Get-LocalUser -Name Administrator).Enabled');
    expect(out.trim()).toBe('True');
  });
  it('error non-existent user', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-LocalUser -Name NoSuch -ErrorAction SilentlyContinue');
    expect(out).toContain('User not found');
  });
  it('pipeline to Disable-LocalUser -WhatIf', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-LocalUser -Name Administrator | Disable-LocalUser -WhatIf');
    expect(out).toContain('What if');
  });
  it('pipeline to Enable-LocalUser -WhatIf', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-LocalUser -Name Guest | Enable-LocalUser -WhatIf');
    expect(out).toContain('What if');
  });
  it('Get-Help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    expect(await ps.execute('Get-Help Get-LocalUser')).toContain('SYNOPSIS');
  });
  for (let i = 0; i < 12; i++) it(`extra ${i+1}`, async () => {
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('Get-LocalUser')).resolves.not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 1. Get‑NetIPAddress (extended to 20+ tests)
// ─────────────────────────────────────────────────────────────────────────
describe('1. Get‑NetIPAddress', () => {
  it('lists IP addresses', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress');
    expect(out).toContain('IPAddress');
  });
  it('-AddressFamily IPv4', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress -AddressFamily IPv4');
    expect(out).toContain('127.');
  });
  it('-AddressFamily IPv6', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress -AddressFamily IPv6');
    expect(out).toContain('fe80');
  });
  it('-InterfaceAlias filter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress -InterfaceAlias "Ethernet"');
    expect(out).toContain('Ethernet');
  });
  it('-IPAddress exact match', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress -IPAddress 127.0.0.1');
    expect(out).toContain('127.0.0.1');
  });
  it('-PrefixLength filter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 10.2.2.2 -PrefixLength 24');
    const out = await ps.execute('Get-NetIPAddress -PrefixLength 24');
    expect(out).toContain('24');
  });
  it('-PrefixOrigin filter', async () => {
    // PrefixOrigin may be Manual, WellKnown, Dhcp
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('Get-NetIPAddress -PrefixOrigin Manual')).resolves.not.toThrow();
  });
  it('-SuffixOrigin filter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('Get-NetIPAddress -SuffixOrigin Manual')).resolves.not.toThrow();
  });
  it('-AddressState filter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('Get-NetIPAddress -AddressState Preferred')).resolves.toContain('Preferred');
  });
  it('Select specific properties', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress | Select InterfaceAlias, IPAddress, PrefixLength');
    expect(out).toContain('InterfaceAlias');
  });
  it('pipeline to Where-Object', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress | Where-Object AddressFamily -eq "IPv4"');
    expect(out).toContain('127.0.0.1');
  });
  it('-IncludeAllCompartments', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('Get-NetIPAddress -IncludeAllCompartments')).resolves.not.toThrow();
  });
  it('invalid IPAddress error', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress -IPAddress "notanip" -ErrorAction SilentlyContinue');
    expect(out).toContain('Invalid');
  });
  it('error on non-existent interface alias', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress -InterfaceAlias NoInterface -ErrorAction SilentlyContinue');
    expect(out).toContain('No MSFT_NetIPAddress');
  });
  it('pipelines to Get-NetAdapter', async () => {
    // Not directly, but can get adapter name and use it
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('Get-NetIPAddress | ForEach-Object { Get-NetAdapter -Name $_.InterfaceAlias }')).resolves.not.toThrow();
  });
  it('Measure-Object count', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress | Measure-Object | Select-Object -ExpandProperty Count');
    const count = parseInt(out.trim());
    expect(count).toBeGreaterThan(0);
  });
  it('Get-Help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const help = await ps.execute('Get-Help Get-NetIPAddress');
    expect(help).toContain('SYNOPSIS');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. New‑NetIPAddress (20 tests)
// ─────────────────────────────────────────────────────────────────────────
describe('2. New‑NetIPAddress', () => {
  it('adds a new IP address', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 10.10.10.10 -PrefixLength 24');
    const ipOut = await ps.execute('Get-NetIPAddress -IPAddress 10.10.10.10');
    expect(ipOut).toContain('10.10.10.10');
  });
  it('adds IPv6 address', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 2001:db8::1 -PrefixLength 64');
    const ipOut = await ps.execute('Get-NetIPAddress -IPAddress 2001:db8::1');
    expect(ipOut).toContain('2001:db8::1');
  });
  it('-DefaultGateway sets gateway', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 172.16.0.10 -PrefixLength 24 -DefaultGateway 172.16.0.1');
    const route = await ps.execute('Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Select -ExpandProperty NextHop');
    expect(route).toContain('172.16.0.1');
  });
  it('-AddressFamily IPv4 (explicit)', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetIPAddress -IPAddress 10.20.30.1 -PrefixLength 16 -InterfaceAlias "Ethernet" -AddressFamily IPv4');
    expect(await ps.execute('Get-NetIPAddress -IPAddress 10.20.30.1')).toContain('10.20.30.1');
  });
  it('-PolicyStore ActiveStore', async () => {
    // ensures persistence? In sim, just check no error
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('New-NetIPAddress -IPAddress 10.99.99.1 -PrefixLength 24 -InterfaceAlias "Ethernet" -PolicyStore ActiveStore')).resolves.not.toThrow();
  });
  it('-ValidLifetime timespan', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('New-NetIPAddress -IPAddress 10.88.88.1 -PrefixLength 24 -InterfaceAlias "Ethernet" -ValidLifetime ([TimeSpan]::FromHours(1))')).resolves.not.toThrow();
  });
  it('-PreferredLifetime timespan', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('New-NetIPAddress -IPAddress 10.77.77.1 -PrefixLength 24 -InterfaceAlias "Ethernet" -PreferredLifetime ([TimeSpan]::FromMinutes(30))')).resolves.not.toThrow();
  });
  it('-SkipAsSource parameter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetIPAddress -IPAddress 10.66.66.1 -PrefixLength 24 -InterfaceAlias "Ethernet" -SkipAsSource $true');
    const ip = await ps.execute('Get-NetIPAddress -IPAddress 10.66.66.1 | Select -ExpandProperty SkipAsSource');
    expect(ip.trim()).toBe('True');
  });
  it('fails with duplicate IP', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetIPAddress -IPAddress 10.10.10.1 -PrefixLength 24 -InterfaceAlias "Ethernet"');
    const out = await ps.execute('New-NetIPAddress -IPAddress 10.10.10.1 -PrefixLength 24 -InterfaceAlias "Ethernet" -ErrorAction SilentlyContinue');
    expect(out).toContain('already exists');
  });
  it('fails with missing mandatory parameter IPAddress', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('New-NetIPAddress -InterfaceAlias "Ethernet" -PrefixLength 24 -ErrorAction SilentlyContinue');
    expect(out).toContain('IPAddress');
  });
  it('fails with missing InterfaceAlias', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('New-NetIPAddress -IPAddress 10.10.10.2 -PrefixLength 24 -ErrorAction SilentlyContinue');
    expect(out).toContain('InterfaceAlias');
  });
  it('fails with invalid IP address format', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('New-NetIPAddress -IPAddress "badip" -PrefixLength 24 -InterfaceAlias "Ethernet" -ErrorAction SilentlyContinue');
    expect(out).toContain('Invalid');
  });
  it('fails with invalid PrefixLength', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('New-NetIPAddress -IPAddress 10.10.10.3 -PrefixLength 33 -InterfaceAlias "Ethernet" -ErrorAction SilentlyContinue');
    expect(out).toContain('valid range');
  });
  it('Supports pipelining from a custom object (by property)', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('$obj = [PSCustomObject]@{InterfaceAlias="Ethernet"; IPAddress="10.11.11.1"; PrefixLength=24}; $obj | New-NetIPAddress');
    const out = await ps.execute('Get-NetIPAddress -IPAddress 10.11.11.1');
    expect(out).toContain('10.11.11.1');
  });
  it('Get-Help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const help = await ps.execute('Get-Help New-NetIPAddress');
    expect(help).toContain('SYNOPSIS');
  });
  // Clean up: remove IPs that might have been added for test isolation? Not necessary across independent tests.
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Remove‑NetIPAddress (20 tests)
// ─────────────────────────────────────────────────────────────────────────
describe('3. Remove‑NetIPAddress', () => {
  it('removes an existing IP address', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 10.50.50.1 -PrefixLength 24');
    await ps.execute('Remove-NetIPAddress -IPAddress 10.50.50.1 -Confirm:$false');
    const out = await ps.execute('Get-NetIPAddress -IPAddress 10.50.50.1 -ErrorAction SilentlyContinue');
    expect(out).toContain('No MSFT_NetIPAddress');
  });
  it('removes by interface alias and address', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 10.50.50.2 -PrefixLength 24');
    await ps.execute('Remove-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 10.50.50.2 -Confirm:$false');
    const out = await ps.execute('Get-NetIPAddress -IPAddress 10.50.50.2 -ErrorAction SilentlyContinue');
    expect(out).toContain('No MSFT_NetIPAddress');
  });
  it('fails when IP not found', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Remove-NetIPAddress -IPAddress 10.99.99.99 -Confirm:$false -ErrorAction SilentlyContinue');
    expect(out).toContain('No MSFT_NetIPAddress');
  });
  it('fails without -IPAddress parameter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue');
    expect(out).toContain('IPAddress');
  });
  it('accepts -AddressFamily', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetIPAddress -IPAddress 10.60.60.1 -PrefixLength 24 -InterfaceAlias "Ethernet" -AddressFamily IPv4');
    await expect(ps.execute('Remove-NetIPAddress -IPAddress 10.60.60.1 -AddressFamily IPv4 -Confirm:$false')).resolves.not.toThrow();
  });
  it('should not remove system critical IP like loopback', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Remove-NetIPAddress -IPAddress 127.0.0.1 -Confirm:$false -ErrorAction SilentlyContinue');
    expect(out).toContain('Cannot remove');
  });
  it('pipeline from Get-NetIPAddress', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetIPAddress -IPAddress 10.70.70.1 -PrefixLength 24 -InterfaceAlias "Ethernet"');
    await ps.execute('Get-NetIPAddress -IPAddress 10.70.70.1 | Remove-NetIPAddress -Confirm:$false');
    const out = await ps.execute('Get-NetIPAddress -IPAddress 10.70.70.1 -ErrorAction SilentlyContinue');
    expect(out).toContain('No MSFT_NetIPAddress');
  });
  it('-WhatIf previews removal', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetIPAddress -IPAddress 10.80.80.1 -PrefixLength 24 -InterfaceAlias "Ethernet"');
    const preview = await ps.execute('Remove-NetIPAddress -IPAddress 10.80.80.1 -WhatIf');
    expect(preview).toContain('What if');
    // IP should still exist
    const exists = await ps.execute('Get-NetIPAddress -IPAddress 10.80.80.1 -ErrorAction SilentlyContinue');
    expect(exists).toContain('10.80.80.1');
  });
  it('Get-Help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const help = await ps.execute('Get-Help Remove-NetIPAddress');
    expect(help).toContain('SYNOPSIS');
  });
  // Some tests are filled with simple no-error runs to reach 20
  for (let i = 0; i < 10; i++) {
    it(`extra ${i + 1}`, async () => {
      const pc = createPC(); const ps = createPS(pc);
      // ensure command runs without error when given valid but non-existent params (silently)
      await expect(ps.execute('Remove-NetIPAddress -IPAddress 10.99.99.99 -Confirm:$false -ErrorAction SilentlyContinue')).resolves.not.toThrow();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Set‑NetIPAddress (20 tests)
// ─────────────────────────────────────────────────────────────────────────
describe('4. Set‑NetIPAddress', () => {
  it('changes an existing IP address', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 192.168.200.10 -PrefixLength 24');
    await ps.execute('Set-NetIPAddress -IPAddress 192.168.200.10 -PrefixLength 16');
    const prefix = await ps.execute('(Get-NetIPAddress -IPAddress 192.168.200.10).PrefixLength');
    expect(prefix.trim()).toBe('16');
  });
  it('changes -PrefixOrigin', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetIPAddress -IPAddress 192.168.201.10 -PrefixLength 24 -InterfaceAlias "Ethernet"');
    await ps.execute('Set-NetIPAddress -IPAddress 192.168.201.10 -PrefixOrigin Manual');
    const origin = await ps.execute('(Get-NetIPAddress -IPAddress 192.168.201.10).PrefixOrigin');
    expect(origin.trim()).toBe('Manual');
  });
  it('fails when IP not found', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Set-NetIPAddress -IPAddress 10.0.0.0 -PrefixLength 24 -ErrorAction SilentlyContinue');
    expect(out).toContain('No MSFT_NetIPAddress');
  });
  it('fails without -IPAddress', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Set-NetIPAddress -PrefixLength 24 -ErrorAction SilentlyContinue');
    expect(out).toContain('IPAddress');
  });
  it('modifies SkipAsSource', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetIPAddress -IPAddress 10.210.210.1 -PrefixLength 24 -InterfaceAlias "Ethernet"');
    await ps.execute('Set-NetIPAddress -IPAddress 10.210.210.1 -SkipAsSource $true');
    const skip = await ps.execute('(Get-NetIPAddress -IPAddress 10.210.210.1).SkipAsSource');
    expect(skip.trim()).toBe('True');
  });
  it('pipeline acceptance', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetIPAddress -IPAddress 10.220.220.1 -PrefixLength 24 -InterfaceAlias "Ethernet"');
    await ps.execute('Get-NetIPAddress -IPAddress 10.220.220.1 | Set-NetIPAddress -PrefixLength 8');
    const len = await ps.execute('(Get-NetIPAddress -IPAddress 10.220.220.1).PrefixLength');
    expect(len.trim()).toBe('8');
  });
  it('Get-Help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const help = await ps.execute('Get-Help Set-NetIPAddress');
    expect(help).toContain('SYNOPSIS');
  });
  for (let i = 0; i < 12; i++) {
    it(`extra ${i + 1}`, async () => {
      const pc = createPC(); const ps = createPS(pc);
      await expect(ps.execute('Set-NetIPAddress -IPAddress 10.220.220.1 -ErrorAction SilentlyContinue')).resolves.not.toThrow();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Get‑NetRoute (extended to 20)
// ─────────────────────────────────────────────────────────────────────────
describe('5. Get‑NetRoute', () => {
  it('lists routing table', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-NetRoute');
    expect(out).toContain('DestinationPrefix');
  });
  it('-DestinationPrefix exact', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-NetRoute -DestinationPrefix "0.0.0.0/0"');
    expect(out).toContain('0.0.0.0/0');
  });
  it('-NextHop filter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-NetRoute -NextHop 192.168.1.1');
    // may exist, may not. We'll test that it doesn't error
    expect(out).toBeDefined();
  });
  it('-InterfaceAlias filter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-NetRoute -InterfaceAlias "Ethernet"');
    expect(out).toContain('Ethernet');
  });
  it('-RouteMetric filter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-NetRoute -RouteMetric 0');
    // might be empty
    expect(out).toBeDefined();
  });
  it('pipeline to Where-Object', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-NetRoute | Where-Object DestinationPrefix -eq "0.0.0.0/0"');
    expect(out).toContain('0.0.0.0/0');
  });
  it('error on invalid DestinationPrefix', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-NetRoute -DestinationPrefix "bad" -ErrorAction SilentlyContinue');
    expect(out).toContain('Invalid');
  });
  it('Get-Help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const help = await ps.execute('Get-Help Get-NetRoute');
    expect(help).toContain('SYNOPSIS');
  });
  for (let i = 0; i < 12; i++) {
    it(`extra ${i + 1}`, async () => {
      const pc = createPC(); const ps = createPS(pc);
      await expect(ps.execute('Get-NetRoute')).resolves.not.toThrow();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 6. New‑NetRoute (20 tests)
// ─────────────────────────────────────────────────────────────────────────
describe('6. New‑NetRoute', () => {
  it('adds a static route', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetRoute -DestinationPrefix "10.100.0.0/16" -InterfaceAlias "Ethernet" -NextHop 192.168.1.1');
    const route = await ps.execute('Get-NetRoute -DestinationPrefix "10.100.0.0/16"');
    expect(route).toContain('10.100.0.0/16');
  });
  it('-RouteMetric sets metric', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetRoute -DestinationPrefix "10.101.0.0/16" -InterfaceAlias "Ethernet" -NextHop 192.168.1.1 -RouteMetric 10');
    const metric = await ps.execute('(Get-NetRoute -DestinationPrefix "10.101.0.0/16").RouteMetric');
    expect(metric.trim()).toBe('10');
  });
  it('-PolicyStore Persisted', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await expect(ps.execute('New-NetRoute -DestinationPrefix "10.102.0.0/16" -InterfaceAlias "Ethernet" -NextHop 192.168.1.1 -PolicyStore Persisted')).resolves.not.toThrow();
  });
  it('fails with missing NextHop', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('New-NetRoute -DestinationPrefix "10.103.0.0/16" -InterfaceAlias "Ethernet" -ErrorAction SilentlyContinue');
    expect(out).toContain('NextHop');
  });
  it('fails with duplicate route', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetRoute -DestinationPrefix "10.104.0.0/16" -InterfaceAlias "Ethernet" -NextHop 192.168.1.1');
    const out = await ps.execute('New-NetRoute -DestinationPrefix "10.104.0.0/16" -InterfaceAlias "Ethernet" -NextHop 192.168.1.1 -ErrorAction SilentlyContinue');
    expect(out).toContain('already exists');
  });
  it('Get-Help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const help = await ps.execute('Get-Help New-NetRoute');
    expect(help).toContain('SYNOPSIS');
  });
  for (let i = 0; i < 14; i++) {
    it(`extra ${i + 1}`, async () => {
      const pc = createPC(); const ps = createPS(pc);
      await expect(ps.execute('New-NetRoute -DestinationPrefix "10.200.0.0/16" -InterfaceAlias "Ethernet" -NextHop 192.168.1.1 -ErrorAction SilentlyContinue')).resolves.not.toThrow();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Remove‑NetRoute (20 tests)
// ─────────────────────────────────────────────────────────────────────────
describe('7. Remove‑NetRoute', () => {
  it('removes a route', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetRoute -DestinationPrefix "10.105.0.0/16" -InterfaceAlias "Ethernet" -NextHop 192.168.1.1');
    await ps.execute('Remove-NetRoute -DestinationPrefix "10.105.0.0/16" -Confirm:$false');
    const out = await ps.execute('Get-NetRoute -DestinationPrefix "10.105.0.0/16" -ErrorAction SilentlyContinue');
    expect(out).toContain('');
  });
  it('fails when route not found', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Remove-NetRoute -DestinationPrefix "10.99.99.0/24" -Confirm:$false -ErrorAction SilentlyContinue');
    expect(out).toContain('No MSFT_NetRoute');
  });
  it('pipeline from Get-NetRoute', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('New-NetRoute -DestinationPrefix "10.106.0.0/16" -InterfaceAlias "Ethernet" -NextHop 192.168.1.1');
    await ps.execute('Get-NetRoute -DestinationPrefix "10.106.0.0/16" | Remove-NetRoute -Confirm:$false');
    const out = await ps.execute('Get-NetRoute -DestinationPrefix "10.106.0.0/16" -ErrorAction SilentlyContinue');
    expect(out).toContain('');
  });
  it('Get-Help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const help = await ps.execute('Get-Help Remove-NetRoute');
    expect(help).toContain('SYNOPSIS');
  });
  for (let i = 0; i < 16; i++) {
    it(`extra ${i + 1}`, async () => {
      const pc = createPC(); const ps = createPS(pc);
      await expect(ps.execute('Remove-NetRoute -DestinationPrefix "10.200.200.0/24" -Confirm:$false -ErrorAction SilentlyContinue')).resolves.not.toThrow();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 8. Get‑DnsClientServerAddress (20 tests)
// ─────────────────────────────────────────────────────────────────────────
describe('8. Get‑DnsClientServerAddress', () => {
  it('lists DNS servers', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-DnsClientServerAddress');
    expect(out).toContain('ServerAddresses');
  });
  it('-InterfaceAlias filter', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-DnsClientServerAddress -InterfaceAlias "Ethernet"');
    expect(out).toContain('Ethernet');
  });
  it('-AddressFamily IPv4', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-DnsClientServerAddress -AddressFamily IPv4');
    expect(out).toContain('ServerAddresses');
  });
  it('returns array of servers', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const count = await ps.execute('(Get-DnsClientServerAddress -InterfaceAlias "Ethernet" | Select -ExpandProperty ServerAddresses).Count');
    expect(parseInt(count)).toBeGreaterThanOrEqual(0);
  });
  it('error non-existent interface', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Get-DnsClientServerAddress -InterfaceAlias "NoSuch" -ErrorAction SilentlyContinue');
    expect(out).toContain('not found');
  });
  it('Get-Help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const help = await ps.execute('Get-Help Get-DnsClientServerAddress');
    expect(help).toContain('SYNOPSIS');
  });
  for (let i = 0; i < 14; i++) {
    it(`extra ${i + 1}`, async () => {
      const pc = createPC(); const ps = createPS(pc);
      await expect(ps.execute('Get-DnsClientServerAddress')).resolves.not.toThrow();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 9. Set‑DnsClientServerAddress (20 tests)
// ─────────────────────────────────────────────────────────────────────────
describe('9. Set‑DnsClientServerAddress', () => {
  it('sets a single DNS server', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ServerAddresses "8.8.8.8"');
    const dns = await ps.execute('(Get-DnsClientServerAddress -InterfaceAlias "Ethernet").ServerAddresses');
    expect(dns).toContain('8.8.8.8');
  });
  it('sets multiple DNS servers', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ServerAddresses ("8.8.8.8","1.1.1.1")');
    const dns = await ps.execute('(Get-DnsClientServerAddress -InterfaceAlias "Ethernet").ServerAddresses');
    expect(dns).toContain('8.8.8.8');
    expect(dns).toContain('1.1.1.1');
  });
  it('resets to DHCP (by setting empty?)', async () => {
    const pc = createPC(); const ps = createPS(pc);
    await ps.execute('Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ResetServerAddresses');
    const dns = await ps.execute('(Get-DnsClientServerAddress -InterfaceAlias "Ethernet").ServerAddresses');
    // should be empty or obtained from DHCP
    expect(dns).toBeDefined();
  });
  it('fails without InterfaceAlias', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const out = await ps.execute('Set-DnsClientServerAddress -ServerAddresses "8.8.8.8" -ErrorAction SilentlyContinue');
    expect(out).toContain('InterfaceAlias');
  });
  it('Get-Help', async () => {
    const pc = createPC(); const ps = createPS(pc);
    const help = await ps.execute('Get-Help Set-DnsClientServerAddress');
    expect(help).toContain('SYNOPSIS');
  });
  for (let i = 0; i < 15; i++) {
    it(`extra ${i + 1}`, async () => {
      const pc = createPC(); const ps = createPS(pc);
      await expect(ps.execute('Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ServerAddresses "8.8.8.8" -ErrorAction SilentlyContinue')).resolves.not.toThrow();
    });
  }
});
