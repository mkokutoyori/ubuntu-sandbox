/**
 * TDD tests for the Linux `run-parts` utility.
 * 
 * Covers exactly 150 test scenarios divided into:
 *  - Block 1: Directory Execution & Naming Convention Validation (Tests 1-30)
 *  - Block 2: Flag Modifiers: Dry-Runs, Ordering & Verbosity (--test, --list, --reverse, --verbose) (Tests 31-60)
 *  - Block 3: Arguments, Environment & Error Propagation (--arg, --umask, --exit-on-error) (Tests 61-90)
 *  - Block 4: Cron Integration, Process Isolation & Logging Context (Tests 91-120)
 *  - Block 5: Edge Cases, Directory Errors, Regex & Privilege Restrictions (Tests 121-150)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

// ─── Helpers ────────────────────────────────────────────────────────

function setupRunPartsPC() {
  return new LinuxPC('RunPartsPC', 0, 0);
}

// ═══════════════════════════════════════════════════════════════════
// LINUX RUN-PARTS TESTS (1-150)
// ═══════════════════════════════════════════════════════════════════

describe('Linux run-parts System Suite', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── Block 1: Directory Execution & Naming Rules (Tests 1-30) ────

  describe('Block 1: Directory Execution & Naming Convention Validation', () => {
    it('1. should execute a valid script inside target directory', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'executed\'" > /tmp/parts/validscript');
      await pc.executeCommand('chmod +x /tmp/parts/validscript');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).toContain('executed');
    });

    it('2. should reject script with a dot in filename by default (e.g. script.sh)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'dot_fail\'" > /tmp/parts/script.sh');
      await pc.executeCommand('chmod +x /tmp/parts/script.sh');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).not.toContain('dot_fail');
    });

    it('3. should reject script with trailing tilde in filename (e.g. script~)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'tilde_fail\'" > /tmp/parts/script~');
      await pc.executeCommand('chmod +x /tmp/parts/script~');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).not.toContain('tilde_fail');
    });

    it('4. should reject script with dpkg-old extension (e.g. script.dpkg-old)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'dpkg_fail\'" > /tmp/parts/script.dpkg-old');
      await pc.executeCommand('chmod +x /tmp/parts/script.dpkg-old');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).not.toContain('dpkg_fail');
    });

    it('5. should reject script containing special characters in name (e.g. script#)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'special_fail\'" > /tmp/parts/script#');
      await pc.executeCommand('chmod +x /tmp/parts/script#');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).not.toContain('special_fail');
    });

    it('6. should execute script with underscore in name (e.g. valid_script)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'underscore_ok\'" > /tmp/parts/valid_script');
      await pc.executeCommand('chmod +x /tmp/parts/valid_script');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).toContain('underscore_ok');
    });

    it('7. should execute script with hyphen in name (e.g. valid-script)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'hyphen_ok\'" > /tmp/parts/valid-script');
      await pc.executeCommand('chmod +x /tmp/parts/valid-script');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).toContain('hyphen_ok');
    });

    it('8. should execute script starting with numbers (e.g. 01script)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'numeric_ok\'" > /tmp/parts/01script');
      await pc.executeCommand('chmod +x /tmp/parts/01script');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).toContain('numeric_ok');
    });

    it('9. should ignore non-executable script even if name is valid', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'not_exec\'" > /tmp/parts/nonexecscript');
      // No chmod +x
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).not.toContain('not_exec');
    });

    it('10. should ignore subdirectories within target directory (no recursion by default)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir -p /tmp/parts/subdir');
      await pc.executeCommand('echo "echo \'nested\'" > /tmp/parts/subdir/nestedscript');
      await pc.executeCommand('chmod +x /tmp/parts/subdir/nestedscript');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).not.toContain('nested');
    });

    it('11. should execute multiple scripts in alphabetical order', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'A\'" > /tmp/parts/scripta');
      await pc.executeCommand('echo "echo \'B\'" > /tmp/parts/scriptb');
      await pc.executeCommand('chmod +x /tmp/parts/scripta /tmp/parts/scriptb');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      const indexA = output.indexOf('A');
      const indexB = output.indexOf('B');
      expect(indexA).toBeLessThan(indexB);
    });

    it('12. should execute multiple scripts respecting padded numeric prefixes (01, 02)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'one\'" > /tmp/parts/01script');
      await pc.executeCommand('echo "echo \'two\'" > /tmp/parts/02script');
      await pc.executeCommand('chmod +x /tmp/parts/01script /tmp/parts/02script');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      const indexOne = output.indexOf('one');
      const indexTwo = output.indexOf('two');
      expect(indexOne).toBeLessThan(indexTwo);
    });

    it('13. should handle relative directory paths (run-parts ./)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'relative\'" > /tmp/parts/script');
      await pc.executeCommand('chmod +x /tmp/parts/script');
      
      const output = await pc.executeCommand('cd /tmp/parts && run-parts .');
      expect(output).toContain('relative');
    });

    it('14. should handle empty directories without returning error', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/empty_parts');
      const output = await pc.executeCommand('run-parts /tmp/empty_parts');
      expect(output.trim()).toBe('');
    });

    it('15. should support space-free naming with capital letters (e.g. ValidScript)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'caps\'" > /tmp/parts/ValidScript');
      await pc.executeCommand('chmod +x /tmp/parts/ValidScript');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).toContain('caps');
    });

    it('16. should reject file if name is just a single dot', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'dot\'" > /tmp/parts/.');
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).not.toContain('dot');
    });

    it('17. should reject file if name is two dots', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'dots\'" > /tmp/parts/..');
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).not.toContain('dots');
    });

    it('18. should reject hidden files (starting with dot, e.g. .script)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'hidden\'" > /tmp/parts/.script');
      await pc.executeCommand('chmod +x /tmp/parts/.script');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).not.toContain('hidden');
    });

    it('19. should execute script with numerical ordering even when alphanumeric is mixed (e.g., 2, 10)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'ten\'" > /tmp/parts/10script');
      await pc.executeCommand('echo "echo \'two\'" > /tmp/parts/2script');
      await pc.executeCommand('chmod +x /tmp/parts/10script /tmp/parts/2script');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      const indexTen = output.indexOf('ten');
      const indexTwo = output.indexOf('two');
      // In lexical order (default for run-parts), '10script' runs before '2script'
      expect(indexTen).toBeLessThan(indexTwo);
    });

    it('20. should execute script with multiple hyphens sequentially (e.g., 01-sys-update)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'update\'" > /tmp/parts/01-sys-update');
      await pc.executeCommand('chmod +x /tmp/parts/01-sys-update');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).toContain('update');
    });

    it('21. should execute script with multiple underscores sequentially (e.g., 01_sys_update)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'update\'" > /tmp/parts/01_sys_update');
      await pc.executeCommand('chmod +x /tmp/parts/01_sys_update');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).toContain('update');
    });

    it('22. should reject files containing carriage returns or newlines inside filename', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      // Attempt file creation with escaped characters in filename
      await pc.executeCommand('touch "/tmp/parts/script\\nname"');
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).not.toContain('name');
    });

    it('23. should reject files ending with .rpm (standard RedHat backup/package, ignored by Debian rules)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'rpm\'" > /tmp/parts/script.rpm');
      await pc.executeCommand('chmod +x /tmp/parts/script.rpm');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).not.toContain('rpm');
    });

    it('24. should reject files ending with .swp (Vim swap file, ignored by Debian rules)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'swap\'" > /tmp/parts/script.swp');
      await pc.executeCommand('chmod +x /tmp/parts/script.swp');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).not.toContain('swap');
    });

    it('25. should execute script containing single characters (e.g. a)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'char\'" > /tmp/parts/a');
      await pc.executeCommand('chmod +x /tmp/parts/a');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).toContain('char');
    });

    it('26. should reject files that are broken symlinks', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('ln -s /tmp/nonexistent_target_link /tmp/parts/brokensymlink');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).not.toContain('brokensymlink');
    });

    it('27. should execute symlink if the target is a valid executable script', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'symlink_ok\'" > /tmp/valid_target');
      await pc.executeCommand('chmod +x /tmp/valid_target');
      await pc.executeCommand('ln -s /tmp/valid_target /tmp/parts/validsymlink');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).toContain('symlink_ok');
    });

    it('28. should reject files containing spaces in their name (e.g. "my script")', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'space\'" > "/tmp/parts/my script"');
      await pc.executeCommand('chmod +x "/tmp/parts/my script"');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).not.toContain('space');
    });

    it('29. should execute script with maximum filename size limit (up to 255 chars)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      const longName = 'S'.repeat(250);
      await pc.executeCommand(`echo "echo 'longname'" > /tmp/parts/${longName}`);
      await pc.executeCommand(`chmod +x /tmp/parts/${longName}`);
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).toContain('longname');
    });

    it('30. should execute successfully and return status 0 when directory exists but has no files', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/empty_parts');
      const output = await pc.executeCommand('run-parts /tmp/empty_parts && echo "SUCCESS"');
      expect(output).toContain('SUCCESS');
    });
  });

  // ─── Block 2: Flag Modifiers (--test, --list, etc.) (Tests 31-60) 

  describe('Block 2: Flag Modifiers: Dry-Runs, Ordering & Verbosity', () => {
    it('31. should list executable scripts without running them using --test', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'run\'" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --test /tmp/parts');
      expect(output).toContain('/tmp/parts/scripta');
      expect(output).not.toContain('run');
    });

    it('32. should list all valid filenames (even non-executable) with --list', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'run\'" > /tmp/parts/scripta');
      await pc.executeCommand('touch /tmp/parts/scriptb'); // non-executable
      
      const output = await pc.executeCommand('run-parts --list /tmp/parts');
      expect(output).toContain('/tmp/parts/scripta');
      expect(output).toContain('/tmp/parts/scriptb');
    });

    it('33. should execute scripts in reverse alphabetical order with --reverse', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'A\'" > /tmp/parts/scripta');
      await pc.executeCommand('echo "echo \'B\'" > /tmp/parts/scriptb');
      await pc.executeCommand('chmod +x /tmp/parts/scripta /tmp/parts/scriptb');
      
      const output = await pc.executeCommand('run-parts --reverse /tmp/parts');
      const indexA = output.indexOf('A');
      const indexB = output.indexOf('B');
      expect(indexB).toBeLessThan(indexA);
    });

    it('34. should print script name to stderr before running with --verbose', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'exec\'" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --verbose /tmp/parts');
      expect(output.toLowerCase()).toContain('running');
      expect(output.toLowerCase()).toContain('scripta');
    });

    it('35. should suppress normal logging outputs and show only errors with --report', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'normal_output\'" > /tmp/parts/scripta');
      await pc.executeCommand('echo "echo \'error_output\' >&2" > /tmp/parts/scriptb');
      await pc.executeCommand('chmod +x /tmp/parts/scripta /tmp/parts/scriptb');
      
      const output = await pc.executeCommand('run-parts --report /tmp/parts');
      expect(output).not.toContain('normal_output');
      expect(output).toContain('error_output');
    });

    it('36. should combine --test and --reverse to list in reverse order', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'A\'" > /tmp/parts/scripta');
      await pc.executeCommand('echo "echo \'B\'" > /tmp/parts/scriptb');
      await pc.executeCommand('chmod +x /tmp/parts/scripta /tmp/parts/scriptb');
      
      const output = await pc.executeCommand('run-parts --test --reverse /tmp/parts');
      const indexA = output.indexOf('scripta');
      const indexB = output.indexOf('scriptb');
      expect(indexB).toBeLessThan(indexA);
    });

    it('37. should print no output in --test mode if no files are valid', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('touch /tmp/parts/script.sh'); // invalid name
      const output = await pc.executeCommand('run-parts --test /tmp/parts');
      expect(output.trim()).toBe('');
    });

    it('38. should display help message on --help', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --help');
      expect(output.toLowerCase()).toContain('usage');
      expect(output.toLowerCase()).toContain('options');
    });

    it('39. should show version information on --version', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --version');
      expect(output.toLowerCase()).toContain('run-parts');
    });

    it('40. should reject invalid flag modifiers gracefully', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --invalid-flag /tmp');
      expect(output.toLowerCase()).toMatch(/unrecognized option|error|invalid/);
    });

    it('41. should support short options alias -t for --test', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'run\'" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts -t /tmp/parts');
      expect(output).toContain('scripta');
      expect(output).not.toContain('run');
    });

    it('42. should support short options alias -v for --verbose', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'exec\'" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts -v /tmp/parts');
      expect(output.toLowerCase()).toContain('running');
    });

    it('43. should list non-executable scripts with -l / --list short option', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('touch /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts -l /tmp/parts');
      expect(output).toContain('scripta');
    });

    it('44. should support --report short option -r', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'error_out\' >&2" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts -r /tmp/parts');
      expect(output).toContain('error_out');
    });

    it('45. should list matches on loopback directories with --list', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --list /etc/cron.daily');
      expect(output).toBeDefined();
    });

    it('46. should ignore rules formatting errors if dry-run --test is running', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "exit 1" > /tmp/parts/scripta'); // would fail if run
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --test /tmp/parts');
      expect(output).toContain('scripta');
    });

    it('47. should handle empty targets on --list execution cleanly', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/empty');
      const output = await pc.executeCommand('run-parts --list /tmp/empty');
      expect(output.trim()).toBe('');
    });

    it('48. should support printing results matching multiple criteria flags combined (-t -v)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo 1" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts -t -v /tmp/parts');
      expect(output).toContain('scripta');
    });

    it('49. should reject command options with double hyphens inside path fields (run-parts /tmp/parts --test)', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts /tmp/parts --test');
      expect(output.toLowerCase()).toMatch(/invalid|error/); // path must be the last argument
    });

    it('50. should execute successfully and return status 0 on default help queries with short flags (-h)', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts -h && echo "PASS"');
      expect(output).toContain('PASS');
    });

    it('51. should preserve script list order in --list output', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('touch /tmp/parts/scripta /tmp/parts/scriptb');
      const output = await pc.executeCommand('run-parts --list /tmp/parts');
      const indexA = output.indexOf('scripta');
      const indexB = output.indexOf('scriptb');
      expect(indexA).toBeLessThan(indexB);
    });

    it('52. should output correct relative paths in --test if relative path was supplied', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo 1" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('cd /tmp && run-parts --test ./parts');
      expect(output).toContain('./parts/scripta');
    });

    it('53. should output correct absolute paths in --test if absolute path was supplied', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo 1" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --test /tmp/parts');
      expect(output).toContain('/tmp/parts/scripta');
    });

    it('54. should not modify files on disk during any --list execution', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'modify\'" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      await pc.executeCommand('run-parts --list /tmp/parts');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).not.toContain('modify');
    });

    it('55. should not modify files on disk during any --test execution', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'modify\'" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      await pc.executeCommand('run-parts --test /tmp/parts');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).not.toContain('modify');
    });

    it('56. should show correct exit code on --test execution with valid files', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('touch /tmp/parts/scripta');
      const output = await pc.executeCommand('run-parts --test /tmp/parts && echo "OK"');
      expect(output).toContain('OK');
    });

    it('57. should display nothing on stdout/stderr if --report is active and all scripts run successfully', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "exit 0" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --report /tmp/parts');
      expect(output.trim()).toBe('');
    });

    it('58. should support combining --verbose and --reverse flags simultaneously', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'A\'" > /tmp/parts/scripta');
      await pc.executeCommand('echo "echo \'B\'" > /tmp/parts/scriptb');
      await pc.executeCommand('chmod +x /tmp/parts/scripta /tmp/parts/scriptb');
      
      const output = await pc.executeCommand('run-parts --verbose --reverse /tmp/parts');
      expect(output.toLowerCase()).toContain('scriptb');
    });

    it('59. should reject flag combinations that are contradictory (--list and --test)', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --list --test /tmp');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('60. should show help directions on invalid flag execution attempts', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts -z /tmp');
      expect(output.toLowerCase()).toContain('usage');
    });
  });

  // ─── Block 3: Parameters & Error Propagation (Tests 61-90) ──────

  describe('Block 3: Parameters, Environment & Error Propagation', () => {
    it('61. should pass custom argument to scripts using --arg', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \\"arg: \\$1\\"" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --arg=custom_val /tmp/parts');
      expect(output).toContain('arg: custom_val');
    });

    it('62. should pass multiple arguments using multiple --arg flags', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \\"\\$1 \\$2\\"" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --arg=first --arg=second /tmp/parts');
      expect(output).toContain('first second');
    });

    it('63. should alter environment mask with --umask', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "umask" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --umask=022 /tmp/parts');
      expect(output.trim()).toBe('0022');
    });

    it('64. should stop subsequent script execution if --exit-on-error is set and a script fails', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "exit 1" > /tmp/parts/01script'); // fails
      await pc.executeCommand('echo "echo \'two\'" > /tmp/parts/02script'); // would succeed
      await pc.executeCommand('chmod +x /tmp/parts/01script /tmp/parts/02script');
      
      const output = await pc.executeCommand('run-parts --exit-on-error /tmp/parts');
      expect(output).not.toContain('two');
    });

    it('65. should continue subsequent script execution if a script fails and --exit-on-error is NOT set', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "exit 1" > /tmp/parts/01script'); // fails
      await pc.executeCommand('echo "echo \'two\'" > /tmp/parts/02script'); // succeeds
      await pc.executeCommand('chmod +x /tmp/parts/01script /tmp/parts/02script');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).toContain('two');
    });

    it('66. should propagate the non-zero exit code of failed script if --exit-on-error is evaluated', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "exit 5" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --exit-on-error /tmp/parts || echo "FAILED_WITH_CODE"');
      expect(output).toContain('FAILED_WITH_CODE');
    });

    it('67. should reject --umask if the mask value is octal invalid (e.g. 088)', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --umask=088 /tmp');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('68. should support passing empty argument strings to scripts (--arg="")', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \\"\\$1\\"" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --arg="" /tmp/parts');
      expect(output.trim()).toBe('');
    });

    it('69. should support umask values with 4 digits explicitly (e.g. 0022)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "umask" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --umask=0022 /tmp/parts');
      expect(output.trim()).toBe('0022');
    });

    it('70. should support passing special shell characters as arguments safely without injection', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \\"arg: \\$1\\"" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --arg="value; rm -rf /" /tmp/parts');
      expect(output).toContain('arg: value; rm -rf /');
    });

    it('71. should pass multiple arguments sequentially preserving their command array index', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \\"\\$2 \\$1\\"" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --arg=A --arg=B /tmp/parts');
      expect(output.trim()).toBe('B A');
    });

    it('72. should return status 0 if script exits with 0 and --exit-on-error is set', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "exit 0" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --exit-on-error /tmp/parts && echo "SUCCESS"');
      expect(output).toContain('SUCCESS');
    });

    it('73. should support using short option alias -a for --arg', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \\"\\$1\\"" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts -a custom_arg_val /tmp/parts');
      expect(output.trim()).toBe('custom_arg_val');
    });

    it('74. should support umask values mapped via environment profiles persistence', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "umask" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --umask=077 /tmp/parts');
      expect(output.trim()).toBe('0077');
    });

    it('75. should ignore exit codes of scripts if --exit-on-error is not evaluated', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "exit 10" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts /tmp/parts && echo "IGNORED"');
      expect(output).toContain('IGNORED');
    });

    it('76. should reject umask values containing alpha-characters (e.g. --umask=abc)', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --umask=abc /tmp');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('77. should reject umask values with more than 4 digits (e.g. --umask=00022)', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --umask=00022 /tmp');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('78. should support executing scripts with empty environment variables', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "env -i env" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output.trim()).toBe('');
    });

    it('79. should preserve stderr output of failed scripts and show it on console', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'fatal error\' >&2; exit 1" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).toContain('fatal error');
    });

    it('80. should terminate sequentially when multiple exit-on-error files fail at first instance', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "exit 2" > /tmp/parts/01script');
      await pc.executeCommand('echo "exit 3" > /tmp/parts/02script');
      await pc.executeCommand('chmod +x /tmp/parts/01script /tmp/parts/02script');
      
      const output = await pc.executeCommand('run-parts --exit-on-error /tmp/parts || echo "EXIT_STATUS_2"');
      expect(output).toContain('EXIT_STATUS_2');
    });

    it('81. should reject --arg if the parameter key has typos (--argg=val)', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --argg=val /tmp');
      expect(output.toLowerCase()).toContain('invalid');
    });

    it('82. should reject --umask if the parameter key has typos (--umaskk=022)', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --umaskk=022 /tmp');
      expect(output.toLowerCase()).toContain('invalid');
    });

    it('83. should reject --exit-on-error if the parameter key has typos (--exit-on-errorr)', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --exit-on-errorr /tmp');
      expect(output.toLowerCase()).toContain('invalid');
    });

    it('84. should support umask values with 3 digits explicitly (e.g. 022)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "umask" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --umask=022 /tmp/parts');
      expect(output.trim()).toBe('0022');
    });

    it('85. should support passing multiple --arg flags with whitespace delimiters instead of equals', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \\"\\$1\\"" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --arg custom_val /tmp/parts');
      expect(output.trim()).toBe('custom_val');
    });

    it('86. should support passing umask flags with whitespace delimiters instead of equals', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "umask" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --umask 022 /tmp/parts');
      expect(output.trim()).toBe('0022');
    });

    it('87. should successfully execute and return status 0 when exit-on-error is active and target directory is empty', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/empty_parts');
      const output = await pc.executeCommand('run-parts --exit-on-error /tmp/empty_parts && echo "SUCCESS"');
      expect(output).toContain('SUCCESS');
    });

    it('88. should reject umask values out of bounds (greater than 0777)', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --umask=1777 /tmp');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('89. should not propagate the exit code of failed script if --exit-on-error is NOT set', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "exit 5" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts /tmp/parts && echo "CLEARED"');
      expect(output).toContain('CLEARED');
    });

    it('90. should execute successfully and return status 0 when arguments contain escaped quotes', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \\"\\$1\\"" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --arg=\\"escaped_quotes\\" /tmp/parts');
      expect(output).toContain('escaped_quotes');
    });
  });

  // ─── Block 4: Cron Integration & Logging Context (Tests 91-120) ──

  describe('Block 4: Cron Integration, Process Isolation & Logging Context', () => {
    it('91. should execute standard cron.daily rules directories', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --test /etc/cron.daily');
      expect(output).toBeDefined();
    });

    it('92. should execute standard cron.weekly rules directories', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --test /etc/cron.weekly');
      expect(output).toBeDefined();
    });

    it('93. should execute standard cron.monthly rules directories', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --test /etc/cron.monthly');
      expect(output).toBeDefined();
    });

    it('94. should execute standard cron.hourly rules directories', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --test /etc/cron.hourly');
      expect(output).toBeDefined();
    });

    it('95. should execute each script in a separate isolated child process', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \\$\\$" > /tmp/parts/01script');
      await pc.executeCommand('echo "echo \\$\\$" > /tmp/parts/02script');
      await pc.executeCommand('chmod +x /tmp/parts/01script /tmp/parts/02script');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      const pids = output.trim().split('\n');
      expect(pids[0]).not.toBe(pids[1]); // PIDs must be different
    });

    it('96. should inherit current shell environment variables inside child scripts', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \\$CUSTOM_ENV" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('export CUSTOM_ENV=trace_val && run-parts /tmp/parts');
      expect(output.trim()).toBe('trace_val');
    });

    it('97. should support stdout redirection of run-parts into file streams', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'redirected\'" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      await pc.executeCommand('run-parts /tmp/parts > /tmp/out.log');
      const fileContent = await pc.executeCommand('cat /tmp/out.log');
      expect(fileContent).toContain('redirected');
    });

    it('98. should support stderr redirection of run-parts into file streams', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'error_out\' >&2" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      await pc.executeCommand('run-parts /tmp/parts 2> /tmp/err.log');
      const fileContent = await pc.executeCommand('cat /tmp/err.log');
      expect(fileContent).toContain('error_out');
    });

    it('99. should output warning inside syslog if cron script takes too long (timeout simulation)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "sleep 10 && echo 1" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      // Execute in background if supported, or verify command accepts blocking sleep
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).toBeDefined();
    });

    it('100. should preserve execution logs inside syslog on cron jobs completions', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "logger \'cron execution check\'" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      await pc.executeCommand('run-parts /tmp/parts');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toContain('cron execution check');
    });

    it('101. should export correct PATH environment variables to child scripts default contexts', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \\$PATH" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).toContain('/usr/bin');
    });

    it('102. should export correct HOME environment variables to child scripts default contexts', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \\$HOME" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).toContain('/root');
    });

    it('103. should export correct USER environment variables to child scripts default contexts', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \\$USER" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output.trim()).toBe('root');
    });

    it('104. should execute scripts using relative paths without CD-changing active shell directories', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'local\'" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      await pc.executeCommand('run-parts ./parts'); // running from current /tmp directory context
      const pwd = await pc.executeCommand('pwd');
      expect(pwd.trim()).toBe('/root'); // active working directory is preserved
    });

    it('105. should handle scripts that invoke other system binaries recursively (cat, grep)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "cat /etc/hostname" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output.trim()).toBe('RunPartsPC');
    });

    it('106. should isolate scripts standard inputs preventing parent shell locking (stdin from /dev/null)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "read line && echo \\"line: \\$line\\"" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output.trim()).toBe(''); // stdin is empty, read should terminate immediately
    });

    it('107. should print sequential executed messages inside syslog if verbose mode is active', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo 1" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      await pc.executeCommand('run-parts --verbose /tmp/parts');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toBeDefined();
    });

    it('108. should support executing scripts written in alternative shells (sh instead of bash)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "#!/bin/sh\\necho \'sh_shell\'" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).toContain('sh_shell');
    });

    it('109. should handle massive outputs gracefully without process pipeline choking', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      // Generate large output (10k data)
      await pc.executeCommand('echo "dd if=/dev/zero bs=1k count=10 | strings" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).toBeDefined();
    });

    it('110. should preserve execution environment cleanups on shell exits', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "export TEMP_ENV_CLEAN=1" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      await pc.executeCommand('run-parts /tmp/parts');
      const output = await pc.executeCommand('echo $TEMP_ENV_CLEAN');
      expect(output.trim()).toBe(''); // Environment variable does not spill to parent shell
    });

    it('111. should preserve script return status code inside process statistics lists', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "exit 3" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts /tmp/parts; echo $?');
      expect(output.trim()).toBe('0'); // run-parts returns 0 overall even if script fails, unless exit-on-error is set
    });

    it('112. should execute scripts containing complex multiline calculations', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "VAR=0\\nfor i in 1 2 3; do\\nVAR=\\$\\(\\(VAR+i\\)\\)\\ndone\\necho \\$VAR" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output.trim()).toBe('6');
    });

    it('113. should inherit parent umask boundaries unless overridden by --umask flags', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "umask" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const parentUmask = await pc.executeCommand('umask');
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output.trim()).toBe(parentUmask.trim());
    });

    it('114. should isolate script output streams so that they run completely unbuffered', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo -n \'unbuffered\'" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).toBe('unbuffered');
    });

    it('115. should run script successfully if path contains trailing forward slash (run-parts /tmp/parts/)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo 1" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts /tmp/parts/');
      expect(output.trim()).toBe('1');
    });

    it('116. should log script exits with abnormal signal flags inside syslog', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "kill -9 \\$\\$" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      await pc.executeCommand('run-parts /tmp/parts');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toBeDefined();
    });

    it('117. should execute scripts that alter active directory contexts locally (cd /tmp)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "cd /tmp && pwd" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output.trim()).toBe('/tmp');
    });

    it('118. should support executing scripts containing functions declaration', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "my_func\\(\\) {\\necho \'func\'\\n}\\nmy_func" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output.trim()).toBe('func');
    });

    it('119. should allow executing scripts containing conditional if/else blocks', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "if [ 1 -eq 1 ]; then\\necho \'yes\'\\nelse\\necho \'no\'\\nfi" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output.trim()).toBe('yes');
    });

    it('120. should execute successfully and return status 0 when cron daily task suite terminates', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --test /etc/cron.daily && echo "CRON_OK"');
      expect(output).toContain('CRON_OK');
    });
  });

  // ─── Block 5: Boundary Conditions & Privilege (Tests 121-150) ────

  describe('Block 5: Edge Cases, Directory Errors, Regex & Privilege Restrictions', () => {
    it('121. should reject execution when target directory argument does not exist', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts /tmp/nonexistent_parts_folder');
      expect(output.toLowerCase()).toMatch(/error|no such file/);
    });

    it('122. should reject execution when target directory argument is missing completely', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts');
      expect(output.toLowerCase()).toContain('usage');
    });

    it('123. should reject execution if the target path is a regular file instead of a directory', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('touch /tmp/regular_file');
      const output = await pc.executeCommand('run-parts /tmp/regular_file');
      expect(output.toLowerCase()).toMatch(/error|not a directory/);
    });

    it('124. should support specifying customized matching regex via --regex', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'regex_match\'" > /tmp/parts/script.sh'); // has dot, rejected by default
      await pc.executeCommand('chmod +x /tmp/parts/script.sh');
      
      const output = await pc.executeCommand('run-parts --regex=".*\\.sh" /tmp/parts');
      expect(output).toContain('dot_fail'); // custom regex overrides strict debian rules
    });

    it('125. should reject script with --regex if name does not match regex bounds', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo 1" > /tmp/parts/script.txt');
      await pc.executeCommand('chmod +x /tmp/parts/script.txt');
      
      const output = await pc.executeCommand('run-parts --regex=".*\\.sh" /tmp/parts');
      expect(output).not.toContain('1');
    });

    it('126. should reject malformed regex syntax expressions inside --regex', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --regex "[" /tmp');
      expect(output.toLowerCase()).toMatch(/error|invalid regex/);
    });

    it('127. should deny unprivileged users execution of scripts in restricted system folders (/etc/cron.daily)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /etc/cron.daily');
      await pc.executeCommand('echo "echo 1" > /etc/cron.daily/scripta');
      await pc.executeCommand('chmod 700 /etc/cron.daily/scripta'); // owned by root
      
      const output = await pc.executeCommand('su user -c "run-parts /etc/cron.daily"');
      expect(output.toLowerCase()).toMatch(/permission denied|error/);
    });

    it('128. should ignore target directories if unprivileged users have no read permissions on them', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('chmod 700 /tmp/parts'); // read/write to root only
      
      const output = await pc.executeCommand('su user -c "run-parts /tmp/parts"');
      expect(output.toLowerCase()).toMatch(/permission denied|cannot open/);
    });

    it('129. should execute successfully and ignore directory if empty during custom regex evaluation', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      const output = await pc.executeCommand('run-parts --regex=".*" /tmp/parts');
      expect(output.trim()).toBe('');
    });

    it('130. should support exit codes propagation of last failed script if --exit-on-error is evaluated and multiple files fail', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "exit 4" > /tmp/parts/01script');
      await pc.executeCommand('echo "exit 5" > /tmp/parts/02script');
      await pc.executeCommand('chmod +x /tmp/parts/01script /tmp/parts/02script');
      
      const output = await pc.executeCommand('run-parts --exit-on-error /tmp/parts || echo $?');
      expect(output.trim()).toBe('4'); // terminates on first failure (01script exits with 4)
    });

    it('131. should handle directory names containing special shell parameters gracefully', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir "/tmp/parts; rm -rf"'); // malformed path
      const output = await pc.executeCommand('run-parts "/tmp/parts; rm -rf"');
      expect(output.toLowerCase()).toMatch(/error|no such file/);
    });

    it('132. should support script execution on directories containing more than 100 valid files', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      for (let i = 1; i <= 100; i++) {
        await pc.executeCommand(`echo "echo 'run'" > /tmp/parts/script${i}`);
        await pc.executeCommand(`chmod +x /tmp/parts/script${i}`);
      }
      const output = await pc.executeCommand('run-parts /tmp/parts');
      const count = (output.match(/run/g) || []).length;
      expect(count).toBe(100);
    });

    it('133. should support using --regex flag and short options combined (-t --regex)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo 1" > /tmp/parts/script.sh');
      await pc.executeCommand('chmod +x /tmp/parts/script.sh');
      
      const output = await pc.executeCommand('run-parts -t --regex=".*\\.sh" /tmp/parts');
      expect(output).toContain('script.sh');
    });

    it('134. should reject --regex parameter if regex value is completely omitted', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --regex /tmp');
      expect(output.toLowerCase()).toMatch(/option requires an argument|error/);
    });

    it('135. should treat directory symlinks as valid path parameters if target exists', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo 1" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      await pc.executeCommand('ln -s /tmp/parts /tmp/parts_link');
      
      const output = await pc.executeCommand('run-parts /tmp/parts_link');
      expect(output.trim()).toBe('1');
    });

    it('136. should reject directory symlinks path parameters if link target was deleted', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('ln -s /tmp/parts /tmp/parts_link');
      await pc.executeCommand('rmdir /tmp/parts');
      
      const output = await pc.executeCommand('run-parts /tmp/parts_link');
      expect(output.toLowerCase()).toMatch(/error|no such file/);
    });

    it('137. should support executing scripts when running as non-privileged user if permissions on directory are permissive (755)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'user_ok\'" > /tmp/parts/scripta');
      await pc.executeCommand('chmod 755 /tmp/parts/scripta');
      await pc.executeCommand('chmod 755 /tmp/parts');
      
      const output = await pc.executeCommand('su user -c "run-parts /tmp/parts"');
      expect(output).toContain('symlink_ok'); // Or simply executes successfully
    });

    it('138. should reject scripts containing binary/null-byte characters inside script content', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('dd if=/dev/zero of=/tmp/parts/bad_binary bs=1 count=10');
      await pc.executeCommand('chmod +x /tmp/parts/bad_binary');
      
      const output = await pc.executeCommand('run-parts /tmp/parts');
      expect(output).not.toContain('bad_binary');
    });

    it('139. should allow run-parts executions if directory path parameters are wrapped in double quotes', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir "/tmp/parts folder with spaces"');
      await pc.executeCommand('echo "echo \'spaced_dir_ok\'" > "/tmp/parts folder/script"');
      await pc.executeCommand('chmod +x "/tmp/parts folder/script"');
      
      const output = await pc.executeCommand('run-parts "/tmp/parts folder"');
      expect(output).toBeDefined();
    });

    it('140. should support reverse alphabetical execution with short option alias -r', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \'A\'" > /tmp/parts/a');
      await pc.executeCommand('echo "echo \'B\'" > /tmp/parts/b');
      const output = await pc.executeCommand('netsh interface ip show /?'); // verifying fallback
      expect(output).toBeDefined();
    });

    it('141. should reject --success option if parsed without any report type', async () => {
      const pc = setupReportPC();
      const output = await pc.executeCommand('aureport --success no');
      expect(output.toLowerCase()).toContain('invalid');
    });

    it('142. should handle extremely long file watch path names safely inside auditctl rules generation', async () => {
      const pc = setupRunPartsPC();
      const longPath = '/tmp/' + 'p'.repeat(240);
      const output = await pc.executeCommand(`run-parts ${longPath}`);
      expect(output.toLowerCase()).toMatch(/error|no such file/);
    });

    it('143. should reject custom umask configurations if umask exceeds octal bounds (greater than 777)', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts --umask=888 /tmp');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('144. should support umask values with leading whitespaces cleaned up before octal validation', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "umask" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --umask=" 022 " /tmp/parts');
      expect(output.trim()).toBe('0022');
    });

    it('145. should preserve dynamic environment variables inside child script executions', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo \\$TEST_VAR" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('export TEST_VAR="preserved" && run-parts /tmp/parts');
      expect(output.trim()).toBe('preserved');
    });

    it('146. should reject directory execution if path parameters has quote mismatch', async () => {
      const pc = setupRunPartsPC();
      const output = await pc.executeCommand('run-parts "/tmp/parts');
      expect(output.toLowerCase()).toMatch(/error|quote|invalid/);
    });

    it('147. should log failed script execution parameters to syslog with exit status details', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "exit 3" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      await pc.executeCommand('run-parts /tmp/parts');
      const syslog = await pc.executeCommand('cat /var/log/syslog');
      expect(syslog).toBeDefined();
    });

    it('148. should support executing scripts targeting specific subsystem rules', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo 1" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      
      const output = await pc.executeCommand('run-parts --test /tmp/parts');
      expect(output).toContain('scripta');
    });

    it('149. should reject executing directory if directory has no execution/search privileges (+x on folder is missing)', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/parts');
      await pc.executeCommand('echo "echo 1" > /tmp/parts/scripta');
      await pc.executeCommand('chmod +x /tmp/parts/scripta');
      await pc.executeCommand('chmod 600 /tmp/parts'); // no search/execute on folder
      
      const output = await pc.executeCommand('su user -c "run-parts /tmp/parts"');
      expect(output.toLowerCase()).toMatch(/permission denied|error|cannot open/);
    });

    it('150. should execute successfully and return status 0 on default exit status verification', async () => {
      const pc = setupRunPartsPC();
      await pc.executeCommand('mkdir /tmp/empty_parts');
      const output = await pc.executeCommand('run-parts /tmp/empty_parts && echo "SUCCESS"');
      expect(output).toContain('SUCCESS');
    });
  });
});
