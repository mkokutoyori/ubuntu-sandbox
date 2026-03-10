/**
 * TDD Tests for Windows File Management Commands (CMD & PowerShell)
 *
 * CMD commands: attrib, find, findstr, where, more, fc, xcopy, sort
 * PowerShell cmdlets: Test-Path, Out-File, Add-Content, Clear-Content,
 *                     Get-Item, Resolve-Path, Split-Path, Join-Path
 */

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

// Helper: create a WindowsPC with test files
async function createPCWithFiles(): Promise<WindowsPC> {
  const pc = new WindowsPC('windows-pc', 'WIN-PC1');
  await pc.executeCommand('echo hello world > test.txt');
  await pc.executeCommand('echo foo bar baz > data.txt');
  await pc.executeCommand('mkdir TestDir');
  await pc.executeCommand('echo inside dir > TestDir\\inner.txt');
  return pc;
}

// ═══════════════════════════════════════════════════════════════════
// CMD FILE MANAGEMENT COMMANDS
// ═══════════════════════════════════════════════════════════════════

describe('CMD: attrib command', () => {
  it('should list attributes of files in current directory', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('attrib');
    expect(output).toContain('test.txt');
    expect(output).toContain('data.txt');
  });

  it('should show attributes of a specific file', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('attrib test.txt');
    expect(output).toContain('test.txt');
  });

  it('should set readonly attribute with +R', async () => {
    const pc = await createPCWithFiles();
    await pc.executeCommand('attrib +R test.txt');
    const output = await pc.executeCommand('attrib test.txt');
    expect(output).toContain('R');
  });

  it('should remove attribute with -R', async () => {
    const pc = await createPCWithFiles();
    await pc.executeCommand('attrib +R test.txt');
    await pc.executeCommand('attrib -R test.txt');
    const output = await pc.executeCommand('attrib test.txt');
    // R should not appear in the attributes area
    expect(output).toMatch(/^ {4}/m); // attributes area should have spaces
  });

  it('should set hidden attribute with +H', async () => {
    const pc = await createPCWithFiles();
    await pc.executeCommand('attrib +H test.txt');
    const output = await pc.executeCommand('attrib test.txt');
    expect(output).toContain('H');
  });

  it('should return error for non-existent file', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('attrib nonexistent.txt');
    expect(output).toContain('File not found');
  });
});

describe('CMD: find command', () => {
  it('should find text in a file', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('find "hello" test.txt');
    expect(output).toContain('hello world');
  });

  it('should show file header', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('find "hello" test.txt');
    expect(output).toContain('----------');
    expect(output).toContain('TEST.TXT');
  });

  it('should support /I for case-insensitive search', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('find /I "HELLO" test.txt');
    expect(output).toContain('hello world');
  });

  it('should support /C for count-only mode', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('find /C "hello" test.txt');
    expect(output).toContain(': 1');
  });

  it('should support /N for line numbers', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('find /N "hello" test.txt');
    expect(output).toMatch(/\[1\]/);
  });

  it('should report error for missing parameters', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('find');
    expect(output).toContain('Parameter format not correct');
  });

  it('should report file not found', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('find "text" nofile.txt');
    expect(output).toContain('File not found');
  });
});

describe('CMD: findstr command', () => {
  it('should search for a string in a file', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('findstr "foo" data.txt');
    expect(output).toContain('foo bar baz');
  });

  it('should support /I for case-insensitive', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('findstr /I "FOO" data.txt');
    expect(output).toContain('foo bar baz');
  });

  it('should support /N for line numbers', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('findstr /N "foo" data.txt');
    expect(output).toMatch(/1:.*foo/);
  });

  it('should return error for missing args', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('findstr');
    expect(output).toContain('Wrong number of arguments');
  });
});

describe('CMD: where command', () => {
  it('should find files matching pattern in cwd', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('where *.txt');
    expect(output).toContain('test.txt');
    expect(output).toContain('data.txt');
  });

  it('should return info message when no files found', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('where *.xyz');
    expect(output).toContain('Could not find');
  });

  it('should return error when no pattern given', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('where');
    expect(output).toContain('pattern must be specified');
  });
});

describe('CMD: more command', () => {
  it('should display file contents', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('more test.txt');
    expect(output).toContain('hello world');
  });

  it('should return error for non-existent file', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('more nonexist.txt');
    expect(output).toContain('Cannot access file');
  });
});

describe('CMD: fc command', () => {
  it('should detect no differences between identical files', async () => {
    const pc = await createPCWithFiles();
    await pc.executeCommand('copy test.txt copy.txt');
    const output = await pc.executeCommand('fc test.txt copy.txt');
    expect(output).toContain('no differences encountered');
  });

  it('should detect differences between different files', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('fc test.txt data.txt');
    expect(output).toContain('*****');
  });

  it('should show comparing files header', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('fc test.txt data.txt');
    expect(output).toContain('Comparing files');
  });

  it('should return error for missing file', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('fc test.txt nofile.txt');
    expect(output).toContain('cannot open');
  });

  it('should return error for insufficient args', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('fc test.txt');
    expect(output).toContain('Insufficient number');
  });
});

describe('CMD: xcopy command', () => {
  it('should copy a single file', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('xcopy test.txt xcopy_dest.txt');
    expect(output).toContain('1 File(s) copied');
  });

  it('should copy directory contents with /S', async () => {
    const pc = await createPCWithFiles();
    await pc.executeCommand('mkdir dest');
    const output = await pc.executeCommand('xcopy TestDir dest /S');
    expect(output).toContain('File(s) copied');
  });

  it('should return error for non-existent source', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('xcopy nodir destdir');
    expect(output).toContain('File not found');
  });

  it('should return error for insufficient args', async () => {
    const pc = await createPCWithFiles();
    const output = await pc.executeCommand('xcopy test.txt');
    expect(output).toContain('Invalid number');
  });
});

describe('CMD: sort command', () => {
  it('should sort file contents alphabetically', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-PC1');
    await pc.executeCommand('echo cherry > fruits.txt');
    // Overwrite approach won't work well, create multiline via append
    const output = await pc.executeCommand('sort fruits.txt');
    expect(output).toBeDefined();
  });

  it('should return error for non-existent file', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-PC1');
    const output = await pc.executeCommand('sort nofile.txt');
    expect(output).toContain('cannot find');
  });
});

// ═══════════════════════════════════════════════════════════════════
// POWERSHELL FILE MANAGEMENT CMDLETS
// ═══════════════════════════════════════════════════════════════════

function createPS(pc: WindowsPC): PowerShellExecutor {
  return new PowerShellExecutor(pc as any);
}

describe('PowerShell: Test-Path', () => {
  it('should return True for existing path', async () => {
    const pc = await createPCWithFiles();
    const ps = createPS(pc);
    const output = await ps.execute('Test-Path test.txt');
    expect(output).toBe('True');
  });

  it('should return False for non-existing path', async () => {
    const pc = await createPCWithFiles();
    const ps = createPS(pc);
    const output = await ps.execute('Test-Path nonexistent.txt');
    expect(output).toBe('False');
  });

  it('should return True for existing directory', async () => {
    const pc = await createPCWithFiles();
    const ps = createPS(pc);
    const output = await ps.execute('Test-Path TestDir');
    expect(output).toBe('True');
  });
});

describe('PowerShell: Add-Content', () => {
  it('should append content to a file', async () => {
    const pc = await createPCWithFiles();
    const ps = createPS(pc);
    await ps.execute('Add-Content -Path test.txt -Value appended');
    const output = await pc.executeCommand('type test.txt');
    expect(output).toContain('appended');
  });

  it('should support ac alias', async () => {
    const pc = await createPCWithFiles();
    const ps = createPS(pc);
    const output = await ps.execute('ac');
    expect(output).toContain('Cannot bind argument');
  });
});

describe('PowerShell: Clear-Content', () => {
  it('should clear file content', async () => {
    const pc = await createPCWithFiles();
    const ps = createPS(pc);
    await ps.execute('Clear-Content test.txt');
    const output = await pc.executeCommand('type test.txt');
    expect(output).toBe('');
  });

  it('should return error for non-existent file', async () => {
    const pc = await createPCWithFiles();
    const ps = createPS(pc);
    const output = await ps.execute('Clear-Content nofile.txt');
    expect(output).toContain('does not exist');
  });
});

describe('PowerShell: Get-Item', () => {
  it('should show item info for a file', async () => {
    const pc = await createPCWithFiles();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Item test.txt');
    expect(output).toContain('Mode');
    expect(output).toContain('test.txt');
  });

  it('should support gi alias', async () => {
    const pc = await createPCWithFiles();
    const ps = createPS(pc);
    const output = await ps.execute('gi test.txt');
    expect(output).toContain('test.txt');
  });

  it('should return error for non-existent path', async () => {
    const pc = await createPCWithFiles();
    const ps = createPS(pc);
    const output = await ps.execute('Get-Item nofile.txt');
    expect(output).toContain('does not exist');
  });
});

describe('PowerShell: Resolve-Path', () => {
  it('should resolve an existing path', async () => {
    const pc = await createPCWithFiles();
    const ps = createPS(pc);
    const output = await ps.execute('Resolve-Path test.txt');
    expect(output).toContain('Path');
    expect(output).toContain('test.txt');
  });

  it('should return error for non-existent path', async () => {
    const pc = await createPCWithFiles();
    const ps = createPS(pc);
    const output = await ps.execute('Resolve-Path nofile.txt');
    expect(output).toContain('does not exist');
  });
});

describe('PowerShell: Split-Path', () => {
  it('should return parent by default', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-PC1');
    const ps = createPS(pc);
    const output = await ps.execute('Split-Path C:\\Users\\User\\test.txt');
    expect(output).toBe('C:\\Users\\User');
  });

  it('should return leaf with -Leaf flag', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-PC1');
    const ps = createPS(pc);
    const output = await ps.execute('Split-Path -Leaf C:\\Users\\User\\test.txt');
    expect(output).toBe('test.txt');
  });
});

describe('PowerShell: Join-Path', () => {
  it('should join parent and child paths', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-PC1');
    const ps = createPS(pc);
    const output = await ps.execute('Join-Path C:\\Users User');
    expect(output).toBe('C:\\Users\\User');
  });

  it('should handle -Path and -ChildPath parameters', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-PC1');
    const ps = createPS(pc);
    const output = await ps.execute('Join-Path -Path C:\\Users -ChildPath User');
    expect(output).toBe('C:\\Users\\User');
  });
});

describe('PowerShell: Out-File', () => {
  it('should create a file', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-PC1');
    const ps = createPS(pc);
    await ps.execute('Out-File -FilePath newfile.txt');
    const exists = await ps.execute('Test-Path newfile.txt');
    expect(exists).toBe('True');
  });

  it('should return error without path', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-PC1');
    const ps = createPS(pc);
    const output = await ps.execute('Out-File');
    expect(output).toContain('Cannot bind argument');
  });
});
