/**
 * Windows Filesystem & Tree Command — TDD Test Suite
 *
 * Tests cover:
 *   Group 1: Filesystem enrichment (realistic files exist)
 *   Group 2: tree command with /F flag
 *   Group 3: tree command structure
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════
// Group 1: Filesystem enrichment — realistic files exist
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Windows filesystem has realistic files', () => {

  it('FS-1: System32 contains common executables', () => {
    const fs = new WindowsFileSystem('PC1');
    const exes = ['cmd.exe', 'notepad.exe', 'ping.exe', 'ipconfig.exe', 'netsh.exe',
                  'tracert.exe', 'hostname.exe', 'regedit.exe', 'taskmgr.exe'];
    for (const exe of exes) {
      expect(fs.exists(`C:\\Windows\\System32\\${exe}`)).toBe(true);
    }
  });

  it('FS-2: hosts file exists in drivers\\etc', () => {
    const fs = new WindowsFileSystem('PC1');
    expect(fs.exists('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe(true);
    const entry = fs.resolve('C:\\Windows\\System32\\drivers\\etc\\hosts');
    expect(entry?.content).toContain('localhost');
  });

  it('FS-3: services file exists in drivers\\etc', () => {
    const fs = new WindowsFileSystem('PC1');
    expect(fs.exists('C:\\Windows\\System32\\drivers\\etc\\services')).toBe(true);
    const entry = fs.resolve('C:\\Windows\\System32\\drivers\\etc\\services');
    expect(entry?.content).toContain('http');
    expect(entry?.content).toContain('80');
  });

  it('FS-4: PowerShell executable exists', () => {
    const fs = new WindowsFileSystem('PC1');
    expect(fs.exists('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(true);
  });

  it('FS-5: User profile has standard folders', () => {
    const fs = new WindowsFileSystem('PC1');
    const folders = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music',
                     'Favorites', 'Contacts', 'OneDrive'];
    for (const folder of folders) {
      expect(fs.isDirectory(`C:\\Users\\User\\${folder}`)).toBe(true);
    }
  });

  it('FS-6: Program Files contains common subdirectories', () => {
    const fs = new WindowsFileSystem('PC1');
    expect(fs.isDirectory('C:\\Program Files\\Common Files')).toBe(true);
    expect(fs.isDirectory('C:\\Program Files\\Internet Explorer')).toBe(true);
    expect(fs.isDirectory('C:\\Program Files\\Windows Defender')).toBe(true);
  });

  it('FS-7: Windows directory has Fonts, INF, Boot subdirectories', () => {
    const fs = new WindowsFileSystem('PC1');
    expect(fs.isDirectory('C:\\Windows\\Fonts')).toBe(true);
    expect(fs.isDirectory('C:\\Windows\\INF')).toBe(true);
    expect(fs.isDirectory('C:\\Windows\\Boot')).toBe(true);
  });

  it('FS-8: NTUSER.DAT exists in user profile', () => {
    const fs = new WindowsFileSystem('PC1');
    expect(fs.exists('C:\\Users\\User\\NTUSER.DAT')).toBe(true);
    const entry = fs.resolve('C:\\Users\\User\\NTUSER.DAT');
    expect(entry?.attributes.has('hidden')).toBe(true);
  });

  it('FS-9: System registry hives exist', () => {
    const fs = new WindowsFileSystem('PC1');
    expect(fs.exists('C:\\Windows\\System32\\config\\SYSTEM')).toBe(true);
    expect(fs.exists('C:\\Windows\\System32\\config\\SOFTWARE')).toBe(true);
    expect(fs.exists('C:\\Windows\\System32\\config\\SAM')).toBe(true);
  });

  it('FS-10: win.ini exists in Windows directory', () => {
    const fs = new WindowsFileSystem('PC1');
    expect(fs.exists('C:\\Windows\\win.ini')).toBe(true);
    const entry = fs.resolve('C:\\Windows\\win.ini');
    expect(entry?.content).toContain('16-bit');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 2: tree command with /F flag
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: tree command /F flag', () => {

  it('FS-11: tree without /F shows only directories', async () => {
    const pc = new WindowsPC('PC1', 100, 100);
    const output = await pc.executeCommand('tree C:\\Windows\\System32\\drivers');

    expect(output).toContain('etc');
    // Should NOT show files like hosts, services
    expect(output).not.toContain('hosts');
    expect(output).not.toContain('services');
  });

  it('FS-12: tree /F shows files and directories', async () => {
    const pc = new WindowsPC('PC1', 100, 100);
    const output = await pc.executeCommand('tree /F C:\\Windows\\System32\\drivers');

    expect(output).toContain('etc');
    // Should show files
    expect(output).toContain('hosts');
    expect(output).toContain('services');
  });

  it('FS-13: tree /F shows files in correct tree structure', () => {
    const fs = new WindowsFileSystem('PC1');
    const output = fs.tree('C:\\Windows\\System32\\drivers', true);

    expect(output).toContain('C:\\Windows\\System32\\drivers');
    expect(output).toContain('├───');
    expect(output).toContain('etc');
    // Files under etc should be indented
    expect(output).toContain('hosts');
    expect(output).toContain('networks');
    expect(output).toContain('protocol');
    expect(output).toContain('services');
  });

  it('FS-14: tree /F with user profile shows user files', async () => {
    const pc = new WindowsPC('PC1', 100, 100);
    const output = await pc.executeCommand('tree /F C:\\Users\\User');

    expect(output).toContain('Desktop');
    expect(output).toContain('Documents');
    expect(output).toContain('desktop.ini');
  });

  it('FS-15: tree command handles current directory', async () => {
    const pc = new WindowsPC('PC1', 100, 100);
    const output = await pc.executeCommand('tree');

    // Default cwd is C:\Users\User, should show subdirectories
    expect(output).toContain('Desktop');
    expect(output).toContain('Documents');
    expect(output).toContain('Downloads');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 3: tree output structure
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: tree output structure is correct', () => {

  it('FS-16: tree uses correct connector characters', () => {
    const fs = new WindowsFileSystem('PC1');
    const output = fs.tree('C:\\Users\\User');

    // Should use tree connectors
    expect(output).toMatch(/[├└]───/);
    expect(output).toMatch(/│\s{3}/);
  });

  it('FS-17: last child uses └─── connector', () => {
    const fs = new WindowsFileSystem('PC1');
    // Create a simple structure
    fs.mkdirp('C:\\Test');
    fs.mkdirp('C:\\Test\\Alpha');
    fs.mkdirp('C:\\Test\\Beta');

    const output = fs.tree('C:\\Test');

    const lines = output.split('\n');
    // First dir uses ├───
    expect(lines[1]).toContain('├───');
    // Last dir uses └───
    expect(lines[2]).toContain('└───');
  });

  it('FS-18: tree /F sorts entries alphabetically', () => {
    const fs = new WindowsFileSystem('PC1');
    fs.mkdirp('C:\\SortTest');
    fs.createFile('C:\\SortTest\\zebra.txt', 'z');
    fs.createFile('C:\\SortTest\\alpha.txt', 'a');
    fs.mkdirp('C:\\SortTest\\middle');

    const output = fs.tree('C:\\SortTest', true);
    const lines = output.split('\n');

    // Should be alphabetically sorted
    const items = lines.slice(1).map(l => l.replace(/[├└│─\s]/g, ''));
    expect(items[0]).toBe('alpha.txt');
    expect(items[1]).toBe('middle');
    expect(items[2]).toBe('zebra.txt');
  });

  it('FS-19: type command reads hosts file correctly', async () => {
    const pc = new WindowsPC('PC1', 100, 100);
    const output = await pc.executeCommand('type C:\\Windows\\System32\\drivers\\etc\\hosts');

    expect(output).toContain('localhost');
    expect(output).toContain('127.0.0.1');
  });

  it('FS-20: dir shows files with sizes', async () => {
    const pc = new WindowsPC('PC1', 100, 100);
    const output = await pc.executeCommand('dir C:\\Windows\\System32\\drivers\\etc');

    expect(output).toContain('hosts');
    expect(output).toContain('services');
  });
});
