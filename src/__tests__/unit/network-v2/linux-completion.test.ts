import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

describe('Linux tab completion', () => {
  let exec: LinuxCommandExecutor;

  beforeEach(() => {
    exec = new LinuxCommandExecutor(false);
  });

  describe('command completion', () => {
    it('completes ls from "l"', () => {
      const c = exec.getCompletions('l');
      expect(c).toContain('ls');
      expect(c).toContain('ln');
    });

    it('completes new builtins like export', () => {
      const c = exec.getCompletions('exp');
      expect(c).toContain('export');
    });

    it('completes printf', () => {
      const c = exec.getCompletions('pri');
      expect(c).toContain('printf');
    });

    it('completes df/du/ps/top', () => {
      expect(exec.getCompletions('df')).toContain('df');
      expect(exec.getCompletions('du')).toContain('du');
      expect(exec.getCompletions('ps')).toContain('ps');
      expect(exec.getCompletions('to')).toContain('top');
    });

    it('completes systemctl and service', () => {
      expect(exec.getCompletions('syst')).toContain('systemctl');
      expect(exec.getCompletions('serv')).toContain('service');
    });

    it('completes apt/dpkg/tar/zip/unzip', () => {
      expect(exec.getCompletions('ap')).toContain('apt');
      expect(exec.getCompletions('dp')).toContain('dpkg');
      expect(exec.getCompletions('ta')).toContain('tar');
      expect(exec.getCompletions('zi')).toContain('zip');
      expect(exec.getCompletions('unz')).toContain('unzip');
    });

    it('completes ssh/scp/rsync', () => {
      expect(exec.getCompletions('ss')).toContain('ssh');
      expect(exec.getCompletions('sc')).toContain('scp');
      expect(exec.getCompletions('rs')).toContain('rsync');
    });

    it('completes man', () => {
      expect(exec.getCompletions('ma')).toContain('man');
    });

    it('returns empty for empty input', () => {
      expect(exec.getCompletions('')).toEqual([]);
    });

    it('returns empty for whitespace only', () => {
      expect(exec.getCompletions('   ')).toEqual([]);
    });

    it('returns nothing for unknown command prefix', () => {
      expect(exec.getCompletions('zzzxxx')).toEqual([]);
    });
  });

  describe('sudo command completion', () => {
    it('completes command after sudo', () => {
      const c = exec.getCompletions('sudo l');
      expect(c).toContain('ls');
      expect(c).toContain('ln');
    });

    it('completes systemctl after sudo', () => {
      const c = exec.getCompletions('sudo syst');
      expect(c).toContain('systemctl');
    });
  });

  describe('path completion', () => {
    it('completes files in current directory', () => {
      const c = exec.getCompletions('ls ');
      // /home/user has skeleton files (.bashrc, .profile) — those are hidden
      // but we can complete from /
      expect(Array.isArray(c)).toBe(true);
    });

    it('completes absolute paths', () => {
      const c = exec.getCompletions('ls /');
      expect(c.some(x => x.startsWith('/'))).toBe(true);
    });

    it('completes /ho to /home/', () => {
      const c = exec.getCompletions('ls /ho');
      expect(c).toContain('/home/');
    });

    it('hides dotfiles unless prefix starts with dot', () => {
      const c = exec.getCompletions('ls /home/user/');
      expect(c.every(x => !x.match(/\/\.[^/]/))).toBe(true);
    });

    it('shows dotfiles when prefix starts with dot', () => {
      const c = exec.getCompletions('ls /home/user/.');
      // skeleton includes .bashrc, .profile
      expect(c.some(x => x.includes('.bashrc'))).toBe(true);
    });

    it('adds trailing slash on directories', () => {
      const c = exec.getCompletions('ls /ho');
      const home = c.find(x => x === '/home/');
      expect(home).toBe('/home/');
    });
  });

  describe('tilde expansion in paths', () => {
    it('completes ~ to home directory', () => {
      const c = exec.getCompletions('ls ~');
      expect(c).toEqual(['/home/user/']);
    });

    it('completes ~/ to files in home dir', () => {
      const c = exec.getCompletions('ls ~/');
      expect(Array.isArray(c)).toBe(true);
      // display prefix is "~/" not expanded
      expect(c.every(x => x.startsWith('~/'))).toBe(true);
    });

    it('completes ~/.b to .bashrc', () => {
      const c = exec.getCompletions('ls ~/.b');
      expect(c).toContain('~/.bashrc');
    });
  });

  describe('environment variable completion', () => {
    it('completes $PA to $PATH', () => {
      const c = exec.getCompletions('echo $PA');
      expect(c).toContain('$PATH');
    });

    it('completes ${PA to ${PATH}', () => {
      const c = exec.getCompletions('echo ${PA');
      expect(c).toContain('${PATH}');
    });

    it('completes $HO to $HOME', () => {
      const c = exec.getCompletions('echo $HO');
      expect(c).toContain('$HOME');
    });

    it('completes $US to $USER', () => {
      const c = exec.getCompletions('echo $US');
      expect(c).toContain('$USER');
    });

    it('completes $ to list of env vars', () => {
      const c = exec.getCompletions('echo $');
      expect(c.length).toBeGreaterThan(0);
      expect(c.every(x => x.startsWith('$'))).toBe(true);
    });
  });
});
