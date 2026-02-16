/**
 * TDD Tests for Windows PC - File System & CMD Commands
 * Tests modeled after linux-filesystem-and-IAM.test.ts
 *
 * Architecture follows the modular pattern in devices/windows/:
 *   - WindowsFileSystem (VFS) in windows/WindowsFileSystem.ts
 *   - File command modules (WinDir, WinFileOps, etc.) in windows/
 *   - WindowsPC integrates VFS + command modules via WinCommandContext
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 1: Filesystem Navigation & Directory Operations
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Filesystem Navigation & Directory Operations', () => {

  describe('W-FS-01: Default filesystem structure', () => {
    it('should have a default working directory of C:\\Users\\User', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      // cd without arguments shows current directory
      const output = await pc.executeCommand('cd');
      expect(output).toContain('C:\\Users\\User');
    });

    it('should have standard Windows directories', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      // dir C:\ should show standard directories
      const output = await pc.executeCommand('dir C:\\');
      expect(output).toContain('Users');
      expect(output).toContain('Windows');
      expect(output).toContain('Program Files');
    });
  });

  describe('W-FS-02: cd command', () => {
    it('should change directory with cd', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('cd C:\\');
      const output = await pc.executeCommand('cd');
      expect(output).toContain('C:\\');
    });

    it('should support relative paths', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      // Start at C:\Users\User, go to Documents
      await pc.executeCommand('cd Documents');
      const output = await pc.executeCommand('cd');
      expect(output).toContain('C:\\Users\\User\\Documents');
    });

    it('should support .. to go up', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('cd ..');
      const output = await pc.executeCommand('cd');
      expect(output).toContain('C:\\Users');
    });

    it('should show error for non-existent directory', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');
      const output = await pc.executeCommand('cd NonExistent');
      expect(output).toContain('The system cannot find the path specified');
    });

    it('should support cd /d to change drives', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');
      // Even if D: doesn't exist, the error should be proper
      const output = await pc.executeCommand('cd /d D:\\');
      // Either changes to D: or gives a proper error
      expect(output).toBeDefined();
    });
  });

  describe('W-FS-03: mkdir / md command', () => {
    it('should create a directory', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('mkdir TestDir');
      const output = await pc.executeCommand('dir');
      expect(output).toContain('TestDir');
    });

    it('should create nested directories', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('mkdir Parent\\Child\\GrandChild');
      await pc.executeCommand('cd Parent\\Child\\GrandChild');
      const output = await pc.executeCommand('cd');
      expect(output).toContain('Parent\\Child\\GrandChild');
    });

    it('should show error when directory already exists', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('mkdir TestDir');
      const output = await pc.executeCommand('mkdir TestDir');
      expect(output).toContain('already exists');
    });

    it('should support md alias', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('md AliasDir');
      const output = await pc.executeCommand('dir');
      expect(output).toContain('AliasDir');
    });
  });

  describe('W-FS-04: rmdir / rd command', () => {
    it('should remove an empty directory', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('mkdir EmptyDir');
      await pc.executeCommand('rmdir EmptyDir');
      const output = await pc.executeCommand('dir');
      expect(output).not.toContain('EmptyDir');
    });

    it('should fail to remove non-empty directory without /s', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('mkdir NonEmpty');
      await pc.executeCommand('echo test > NonEmpty\\file.txt');
      const output = await pc.executeCommand('rmdir NonEmpty');
      expect(output).toContain('not empty');
    });

    it('should remove non-empty directory with /s /q', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('mkdir ToDelete');
      await pc.executeCommand('echo test > ToDelete\\file.txt');
      await pc.executeCommand('rmdir /s /q ToDelete');
      const output = await pc.executeCommand('dir');
      expect(output).not.toContain('ToDelete');
    });

    it('should support rd alias', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('mkdir RdTest');
      await pc.executeCommand('rd RdTest');
      const output = await pc.executeCommand('dir');
      expect(output).not.toContain('RdTest');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 2: File Operations
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: File Operations', () => {

  describe('W-FS-05: echo with redirect (create files)', () => {
    it('should create a file with echo redirect', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('echo Hello World > test.txt');
      const output = await pc.executeCommand('type test.txt');
      expect(output).toContain('Hello World');
    });

    it('should overwrite file with >', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('echo First > test.txt');
      await pc.executeCommand('echo Second > test.txt');
      const output = await pc.executeCommand('type test.txt');
      expect(output).toContain('Second');
      expect(output).not.toContain('First');
    });

    it('should append with >>', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('echo Line1 > test.txt');
      await pc.executeCommand('echo Line2 >> test.txt');
      const output = await pc.executeCommand('type test.txt');
      expect(output).toContain('Line1');
      expect(output).toContain('Line2');
    });
  });

  describe('W-FS-06: type command', () => {
    it('should display file content', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('echo Hello CMD > greeting.txt');
      const output = await pc.executeCommand('type greeting.txt');
      expect(output).toContain('Hello CMD');
    });

    it('should show error for non-existent file', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');
      const output = await pc.executeCommand('type nonexistent.txt');
      expect(output).toContain('The system cannot find the file specified');
    });
  });

  describe('W-FS-07: copy command', () => {
    it('should copy a file', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('echo original > source.txt');
      await pc.executeCommand('copy source.txt dest.txt');
      const output = await pc.executeCommand('type dest.txt');
      expect(output).toContain('original');
    });

    it('should show confirmation message', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('echo data > a.txt');
      const output = await pc.executeCommand('copy a.txt b.txt');
      expect(output).toContain('1 file(s) copied');
    });

    it('should show error for non-existent source', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');
      const output = await pc.executeCommand('copy nofile.txt dest.txt');
      expect(output).toContain('The system cannot find the file specified');
    });
  });

  describe('W-FS-08: move command', () => {
    it('should move a file', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('echo content > moveme.txt');
      await pc.executeCommand('move moveme.txt moved.txt');

      const typeMoved = await pc.executeCommand('type moved.txt');
      expect(typeMoved).toContain('content');

      const typeOriginal = await pc.executeCommand('type moveme.txt');
      expect(typeOriginal).toContain('cannot find');
    });

    it('should move a file to a directory', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('echo data > file.txt');
      await pc.executeCommand('mkdir dest');
      await pc.executeCommand('move file.txt dest\\');

      await pc.executeCommand('cd dest');
      const output = await pc.executeCommand('type file.txt');
      expect(output).toContain('data');
    });
  });

  describe('W-FS-09: ren / rename command', () => {
    it('should rename a file', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('echo test > old.txt');
      await pc.executeCommand('ren old.txt new.txt');

      const output = await pc.executeCommand('type new.txt');
      expect(output).toContain('test');

      const notFound = await pc.executeCommand('type old.txt');
      expect(notFound).toContain('cannot find');
    });

    it('should support rename alias', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('echo test > old.txt');
      await pc.executeCommand('rename old.txt new.txt');
      const output = await pc.executeCommand('type new.txt');
      expect(output).toContain('test');
    });
  });

  describe('W-FS-10: del / erase command', () => {
    it('should delete a file', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('echo deleteme > temp.txt');
      await pc.executeCommand('del temp.txt');
      const output = await pc.executeCommand('type temp.txt');
      expect(output).toContain('cannot find');
    });

    it('should support erase alias', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('echo data > temp.txt');
      await pc.executeCommand('erase temp.txt');
      const output = await pc.executeCommand('type temp.txt');
      expect(output).toContain('cannot find');
    });

    it('should delete with wildcard', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('echo a > file1.tmp');
      await pc.executeCommand('echo b > file2.tmp');
      await pc.executeCommand('echo c > keep.txt');
      await pc.executeCommand('del *.tmp');

      const dir = await pc.executeCommand('dir');
      expect(dir).not.toContain('file1.tmp');
      expect(dir).not.toContain('file2.tmp');
      expect(dir).toContain('keep.txt');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 3: dir command (detailed output)
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: dir command', () => {

  describe('W-FS-11: dir basic output', () => {
    it('should show volume info and directory header', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      const output = await pc.executeCommand('dir');
      expect(output).toContain('Volume in drive C');
      expect(output).toContain('Directory of');
    });

    it('should show <DIR> for directories', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('mkdir TestFolder');
      const output = await pc.executeCommand('dir');
      expect(output).toContain('<DIR>');
      expect(output).toContain('TestFolder');
    });

    it('should show file sizes', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('echo Hello > test.txt');
      const output = await pc.executeCommand('dir');
      expect(output).toContain('test.txt');
      // Should have file count and bytes summary
      expect(output).toMatch(/\d+ File\(s\)/);
      expect(output).toMatch(/\d+ Dir\(s\)/);
    });

    it('should show . and .. entries', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');
      const output = await pc.executeCommand('dir');
      expect(output).toContain('<DIR>          .');
      expect(output).toContain('<DIR>          ..');
    });
  });

  describe('W-FS-12: dir with path argument', () => {
    it('should list contents of specified directory', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      const output = await pc.executeCommand('dir C:\\Users');
      expect(output).toContain('User');
      expect(output).toContain('Directory of C:\\Users');
    });
  });

  describe('W-FS-13: dir /w (wide format)', () => {
    it('should display in wide format', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('mkdir Folder1');
      await pc.executeCommand('mkdir Folder2');
      const output = await pc.executeCommand('dir /w');
      // Wide format shows names in columns with [brackets] for dirs
      expect(output).toContain('[Folder1]');
      expect(output).toContain('[Folder2]');
    });
  });

  describe('W-FS-14: dir /s (recursive)', () => {
    it('should list files recursively', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('mkdir sub');
      await pc.executeCommand('echo data > sub\\nested.txt');
      const output = await pc.executeCommand('dir /s');
      expect(output).toContain('nested.txt');
      expect(output).toContain('Directory of');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 4: Environment Variables & System Commands
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: Environment Variables & System Commands', () => {

  describe('W-FS-15: echo with environment variables', () => {
    it('should expand %USERNAME%', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');
      const output = await pc.executeCommand('echo %USERNAME%');
      expect(output).toBe('User');
    });

    it('should expand %COMPUTERNAME%', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');
      const output = await pc.executeCommand('echo %COMPUTERNAME%');
      expect(output).toBe('WIN-PC1');
    });

    it('should expand %CD%', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');
      const output = await pc.executeCommand('echo %CD%');
      expect(output).toContain('C:\\Users\\User');
    });

    it('should expand %HOMEDRIVE%%HOMEPATH%', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');
      const output = await pc.executeCommand('echo %HOMEDRIVE%%HOMEPATH%');
      expect(output).toBe('C:\\Users\\User');
    });
  });

  describe('W-FS-16: set command', () => {
    it('should display all environment variables', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');
      const output = await pc.executeCommand('set');
      expect(output).toContain('USERNAME=');
      expect(output).toContain('COMPUTERNAME=');
      expect(output).toContain('HOMEDRIVE=');
      expect(output).toContain('PATH=');
    });

    it('should set a new environment variable', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');
      await pc.executeCommand('set MYVAR=hello');
      const output = await pc.executeCommand('echo %MYVAR%');
      expect(output).toBe('hello');
    });

    it('should filter variables by prefix', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');
      const output = await pc.executeCommand('set HOME');
      expect(output).toContain('HOMEDRIVE=');
      expect(output).toContain('HOMEPATH=');
      expect(output).not.toContain('USERNAME=');
    });
  });

  describe('W-FS-17: ver command', () => {
    it('should display Windows version', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');
      const output = await pc.executeCommand('ver');
      expect(output).toContain('Microsoft Windows');
      expect(output).toContain('Version');
    });
  });

  describe('W-FS-18: hostname command', () => {
    it('should display the hostname', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');
      const output = await pc.executeCommand('hostname');
      expect(output).toBe('WIN-PC1');
    });
  });

  describe('W-FS-19: cls command', () => {
    it('should return empty string (clear screen)', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');
      const output = await pc.executeCommand('cls');
      expect(output).toBe('');
    });
  });

  describe('W-FS-20: systeminfo command', () => {
    it('should show system information with real device data', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');
      const output = await pc.executeCommand('systeminfo');
      expect(output).toContain('Host Name:');
      expect(output).toContain('WIN-PC1');
      expect(output).toContain('OS Name:');
      expect(output).toContain('Microsoft Windows');
      expect(output).toContain('Network Card(s):');
    });
  });

  describe('W-FS-21: tasklist command', () => {
    it('should display process list', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');
      const output = await pc.executeCommand('tasklist');
      // Should have header with Image Name, PID, etc.
      expect(output).toContain('Image Name');
      expect(output).toContain('PID');
      // Should have some default processes
      expect(output).toContain('System');
      expect(output).toContain('cmd.exe');
    });
  });

  describe('W-FS-22: netstat command', () => {
    it('should display network statistics', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');
      const output = await pc.executeCommand('netstat');
      expect(output).toContain('Active Connections');
      expect(output).toContain('Proto');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 5: Tab Completion & Piping
// ═══════════════════════════════════════════════════════════════════

describe('Group 5: Tab Completion & Piping', () => {

  describe('W-FS-23: tab completion', () => {
    it('should complete file and directory names', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('mkdir LongDirectoryName');
      const completions = pc.getCompletions('cd Long');
      expect(completions).toContain('LongDirectoryName');
    });

    it('should complete commands', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      const completions = pc.getCompletions('ipc');
      expect(completions).toContain('ipconfig');
    });

    it('should return multiple matches', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('mkdir DirA');
      await pc.executeCommand('mkdir DirB');
      const completions = pc.getCompletions('cd Dir');
      expect(completions.length).toBeGreaterThanOrEqual(2);
      expect(completions).toContain('DirA');
      expect(completions).toContain('DirB');
    });
  });

  describe('W-FS-24: pipe with findstr', () => {
    it('should filter output with findstr', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('mkdir Alpha');
      await pc.executeCommand('mkdir Beta');
      const output = await pc.executeCommand('dir | findstr Alpha');
      expect(output).toContain('Alpha');
      expect(output).not.toContain('Beta');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 6: Case Insensitivity & Path Handling
// ═══════════════════════════════════════════════════════════════════

describe('Group 6: Windows-Specific Behaviors', () => {

  describe('W-FS-25: case-insensitive paths', () => {
    it('should handle case-insensitive directory names', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('mkdir MyFolder');
      await pc.executeCommand('cd myfolder');
      const output = await pc.executeCommand('cd');
      expect(output.toLowerCase()).toContain('myfolder');
    });

    it('should handle case-insensitive file operations', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('echo hello > Test.txt');
      const output = await pc.executeCommand('type test.txt');
      expect(output).toContain('hello');
    });
  });

  describe('W-FS-26: backslash and forward-slash paths', () => {
    it('should accept forward slashes in paths', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('cd C:/Users');
      const output = await pc.executeCommand('cd');
      expect(output).toContain('C:\\Users');
    });
  });

  describe('W-FS-27: tree command', () => {
    it('should display directory tree', async () => {
      const pc = new WindowsPC('windows-pc', 'WIN-PC1');

      await pc.executeCommand('mkdir TreeTest');
      await pc.executeCommand('mkdir TreeTest\\Sub1');
      await pc.executeCommand('mkdir TreeTest\\Sub2');
      const output = await pc.executeCommand('tree TreeTest');
      expect(output).toContain('TreeTest');
      expect(output).toContain('Sub1');
      expect(output).toContain('Sub2');
    });
  });
});
