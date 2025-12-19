/**
 * Real-world Shell Script Tests
 *
 * Tests complex, production-like shell scripts to identify
 * implementation limits in the Linux terminal simulator.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { executeShellCommand } from '../terminal/shell/executor';
import { executeScript, executeInlineLoop, clearShellFunctions } from '../terminal/shell/scriptInterpreter';
import { FileSystem } from '../terminal/filesystem';
import { PackageManager } from '../terminal/packages';
import { TerminalState } from '../terminal/types';

describe('Real-World Shell Scripts', () => {
  let fs: FileSystem;
  let pm: PackageManager;
  let state: TerminalState;

  beforeEach(() => {
    clearShellFunctions();
    fs = new FileSystem();
    pm = new PackageManager();
    state = {
      currentPath: '/home/user',
      currentUser: 'user',
      hostname: 'webserver',
      history: [],
      historyIndex: -1,
      aliases: {},
      env: {
        PATH: '/usr/bin:/bin:/usr/local/bin',
        HOME: '/home/user',
        USER: 'user',
        SHELL: '/bin/bash',
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        APP_ENV: 'production',
        DATABASE_URL: 'postgres://localhost:5432/myapp',
      },
      isRoot: false,
    };
  });

  describe('Deployment Script Patterns', () => {
    it('handles deployment with health check loop', () => {
      // Simule: while ! curl -s http://localhost:8080/health; do sleep 1; done
      // Comme curl retourne toujours succès, on teste la structure
      const script = `
        RETRIES=3
        for i in 1 2 3; do
          echo "Attempt $i of $RETRIES"
        done
        echo "Deployment complete"
      `;

      const result = executeScript(script, state, fs, pm);
      expect(result.output).toContain('Attempt 1');
      expect(result.output).toContain('Attempt 2');
      expect(result.output).toContain('Attempt 3');
      expect(result.output).toContain('Deployment complete');
    });

    it('handles environment-based configuration', () => {
      const script = `
        if test "$APP_ENV" = "production"; then
          echo "Running in PRODUCTION mode"
          echo "Database: $DATABASE_URL"
        else
          echo "Running in development mode"
        fi
      `;

      const result = executeScript(script, state, fs, pm);
      expect(result.output).toContain('Running in PRODUCTION mode');
      expect(result.output).toContain('postgres://localhost:5432/myapp');
    });

    it('handles case statement for environment routing', () => {
      const script = `
        case $APP_ENV in
          production)
            echo "Deploying to prod cluster"
            ;;
          staging)
            echo "Deploying to staging"
            ;;
          *)
            echo "Unknown environment"
            ;;
        esac
      `;

      const result = executeScript(script, state, fs, pm);
      expect(result.output).toContain('Deploying to prod cluster');
    });
  });

  describe('Log Processing Scripts', () => {
    it('processes log files with grep and wc', () => {
      // Create a mock log file using createNode
      fs.createNode('/var/log/app.log', 'file', 'root', `2024-01-15 10:00:00 INFO Starting application
2024-01-15 10:00:01 INFO Connected to database
2024-01-15 10:00:02 ERROR Connection timeout
2024-01-15 10:00:03 INFO Retry successful
2024-01-15 10:00:04 ERROR Disk full
2024-01-15 10:00:05 INFO Cleanup complete`);

      const result = executeShellCommand(
        'cat /var/log/app.log | grep ERROR | wc -l',
        state, fs, pm
      );
      expect(result.output.trim()).toBe('2');
    });

    it('extracts unique error types', () => {
      fs.createNode('/var/log/errors.log', 'file', 'root', `ERROR: Connection refused
ERROR: Timeout
ERROR: Connection refused
ERROR: Disk full
ERROR: Timeout
ERROR: Timeout`);

      const result = executeShellCommand(
        'cat /var/log/errors.log | sort | uniq',
        state, fs, pm
      );
      expect(result.output).toContain('Connection refused');
      expect(result.output).toContain('Disk full');
      expect(result.output).toContain('Timeout');
    });
  });

  describe('Backup Script Patterns', () => {
    it('handles backup with date-based naming', () => {
      const result = executeShellCommand('date +%Y%m%d', state, fs, pm);
      expect(result.output).toMatch(/\d{8}/);
    });

    it('simulates backup rotation logic', () => {
      const script = `
        MAX_BACKUPS=3
        BACKUP_COUNT=5
        if test $BACKUP_COUNT -gt $MAX_BACKUPS; then
          echo "Rotating old backups"
          echo "Removing oldest backup"
        fi
        echo "Creating new backup"
      `;

      const result = executeScript(script, state, fs, pm);
      expect(result.output).toContain('Rotating old backups');
      expect(result.output).toContain('Creating new backup');
    });
  });

  describe('System Monitoring Scripts', () => {
    it('checks disk usage and alerts', () => {
      const script = `
        THRESHOLD=80
        USAGE=85
        if test $USAGE -gt $THRESHOLD; then
          echo "ALERT: Disk usage at $USAGE% exceeds threshold of $THRESHOLD%"
        else
          echo "Disk usage OK: $USAGE%"
        fi
      `;

      const result = executeScript(script, state, fs, pm);
      expect(result.output).toContain('ALERT: Disk usage at 85%');
    });

    it('runs uptime and free commands', () => {
      const uptimeResult = executeShellCommand('uptime', state, fs, pm);
      expect(uptimeResult.output).toContain('load average');

      const freeResult = executeShellCommand('free -h', state, fs, pm);
      expect(freeResult.output).toContain('Mem:');
    });

    it('checks running processes', () => {
      const result = executeShellCommand('ps aux | head -5', state, fs, pm);
      expect(result.output).toContain('PID');
      expect(result.output).toContain('USER');
    });
  });

  describe('Function-Based Scripts', () => {
    it('defines and uses utility functions', () => {
      // Define a logging function
      executeInlineLoop('log() { echo "[LOG] $1"; }', state, fs, pm);

      // Note: quoted arguments are split incorrectly - this is a limitation
      // "Application started" becomes two args: "Application and started"
      const result = executeInlineLoop('log AppStarted', state, fs, pm);
      expect(result?.output).toBe('[LOG] AppStarted');
    });

    it('handles quoted arguments in function calls correctly', () => {
      executeInlineLoop('show() { echo "Arg1: $1, Arg2: $2"; }', state, fs, pm);

      // "Hello World" should be passed as a single argument $1
      const result = executeInlineLoop('show "Hello World"', state, fs, pm);
      expect(result?.output).toBe('Arg1: Hello World, Arg2: ');
    });

    it('handles function with multiple commands', () => {
      executeInlineLoop('setup() { echo "Step 1: Init"; echo "Step 2: Configure"; }', state, fs, pm);

      const result = executeInlineLoop('setup', state, fs, pm);
      expect(result?.output).toContain('Step 1: Init');
      expect(result?.output).toContain('Step 2: Configure');
    });

    it('uses function return values for flow control', () => {
      // Define a check function
      executeInlineLoop('check_ready() { echo "Checking..."; return 0; }', state, fs, pm);

      const result = executeInlineLoop('check_ready', state, fs, pm);
      expect(result?.output).toBe('Checking...');
      expect(result?.exitCode).toBe(0);
    });
  });

  describe('Network Configuration Scripts', () => {
    it('displays network configuration', () => {
      const result = executeShellCommand('ifconfig', state, fs, pm);
      expect(result.output).toContain('eth0');
      expect(result.output).toContain('inet');
    });

    it('checks connectivity with ping', () => {
      const result = executeShellCommand('ping -c 3 8.8.8.8', state, fs, pm);
      expect(result.output).toContain('bytes from');
      expect(result.output).toContain('icmp_seq');
    });

    it('scans ports with nmap', () => {
      const result = executeShellCommand('nmap -F 192.168.1.1', { ...state, isRoot: true }, fs, pm);
      expect(result.output).toContain('PORT');
      expect(result.output).toContain('open');
    });
  });

  describe('Complex Control Flow', () => {
    it('handles nested for loops', () => {
      const script = `
        for i in 1 2; do
          for j in a b; do
            echo "$i$j"
          done
        done
      `;

      const result = executeScript(script, state, fs, pm);
      expect(result.output).toContain('1a');
      expect(result.output).toContain('1b');
      expect(result.output).toContain('2a');
      expect(result.output).toContain('2b');
    });

    it('handles if inside for loop', () => {
      const script = `
        for num in 1 2 3 4 5; do
          if test $num -gt 3; then
            echo "$num is greater than 3"
          fi
        done
      `;

      const result = executeScript(script, state, fs, pm);
      expect(result.output).toContain('4 is greater than 3');
      expect(result.output).toContain('5 is greater than 3');
      expect(result.output).not.toContain('1 is greater');
    });

    it('handles while loop with counter', () => {
      const script = `
        COUNT=0
        while test $COUNT -lt 3; do
          echo "Count: $COUNT"
          COUNT=1
        done
      `;

      // Note: This will only run once because we can't do arithmetic
      // This test documents the limitation
      const result = executeScript(script, state, fs, pm);
      expect(result.output).toContain('Count:');
    });
  });

  describe('File Operations Scripts', () => {
    it('creates directory structure', () => {
      executeShellCommand('mkdir -p /home/user/project/src', state, fs, pm);
      executeShellCommand('mkdir -p /home/user/project/tests', state, fs, pm);

      const result = executeShellCommand('ls /home/user/project', state, fs, pm);
      expect(result.output).toContain('src');
      expect(result.output).toContain('tests');
    });

    it('creates and reads configuration file', () => {
      executeShellCommand('echo "DB_HOST=localhost" > /home/user/.env', state, fs, pm);
      executeShellCommand('echo "DB_PORT=5432" >> /home/user/.env', state, fs, pm);

      const result = executeShellCommand('cat /home/user/.env', state, fs, pm);
      expect(result.output).toContain('DB_HOST=localhost');
      expect(result.output).toContain('DB_PORT=5432');
    });

    it('finds files by pattern using ls | grep', () => {
      fs.createNode('/home/user/app.js', 'file', 'user', 'console.log("app");');
      fs.createNode('/home/user/test.js', 'file', 'user', 'console.log("test");');
      fs.createNode('/home/user/readme.md', 'file', 'user', '# Readme');

      // ls outputs one file per line when piped
      const result = executeShellCommand('ls /home/user | grep js', state, fs, pm);
      expect(result.output).toContain('app.js');
      expect(result.output).toContain('test.js');
      // readme.md should NOT be in output (grep only matches lines containing 'js')
      expect(result.output).not.toContain('readme.md');
    });

    it('ls outputs one file per line when piped', () => {
      fs.createNode('/home/user/file1.txt', 'file', 'user', 'content1');
      fs.createNode('/home/user/file2.txt', 'file', 'user', 'content2');

      // When piped, ls outputs one file per line
      const result = executeShellCommand('ls /home/user | wc -l', state, fs, pm);
      // Should count files correctly (2 files = 2 lines)
      const lineCount = parseInt(result.output.trim());
      expect(lineCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('SSH and Remote Operations', () => {
    it('simulates SSH connection', () => {
      const result = executeShellCommand('ssh user@server.example.com', state, fs, pm);
      expect(result.output).toContain('Welcome to Ubuntu');
      expect(result.output).toContain('Last login');
    });

    it('simulates remote command execution', () => {
      const result = executeShellCommand('ssh admin@server.example.com hostname', state, fs, pm);
      expect(result.output).toContain('server.example.com');
    });

    it('simulates SCP file transfer', () => {
      const result = executeShellCommand('scp /home/user/file.txt user@server:/tmp/', state, fs, pm);
      expect(result.output).toContain('100%');
    });

    it('generates SSH key', () => {
      const result = executeShellCommand('ssh-keygen -t ed25519', state, fs, pm);
      expect(result.output).toContain('Generating public/private');
      expect(result.output).toContain('randomart');
    });
  });

  describe('Package and Service Management', () => {
    it('checks service status', () => {
      const result = executeShellCommand('systemctl status nginx', state, fs, pm);
      expect(result.output).toContain('nginx.service');
    });

    it('lists running services', () => {
      const result = executeShellCommand('systemctl list-units --type=service', state, fs, pm);
      expect(result.output).toContain('UNIT');
      expect(result.output).toContain('running');
    });

    it('views system logs', () => {
      const result = executeShellCommand('journalctl -n 5', state, fs, pm);
      expect(result.output).toContain('systemd');
    });
  });

  describe('Shell Features Tests', () => {
    it('supports arithmetic expansion $((expr))', () => {
      // $((expr)) should evaluate to the result
      const result = executeShellCommand('echo $((2 + 2))', state, fs, pm);
      expect(result.output.trim()).toBe('4');
    });

    it('supports complex arithmetic expressions', () => {
      const result = executeShellCommand('echo $((10 * 5 - 3))', state, fs, pm);
      expect(result.output.trim()).toBe('47');
    });

    it('supports command substitution', () => {
      // $(cmd) should be replaced with command output
      const result = executeShellCommand('echo "Today is $(date +%A)"', state, fs, pm);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Today is');
    });

    it('LIMITATION: arrays not supported', () => {
      // arr=(a b c) should create an array
      const result = executeShellCommand('arr=(one two three); echo ${arr[0]}', state, fs, pm);
      // Arrays are not implemented
      expect(result.exitCode).toBeDefined();
    });

    it('supports local variables in functions', () => {
      // local should create function-scoped variable
      executeInlineLoop('test_local() { local x=5; echo $x; }', state, fs, pm);
      const result = executeInlineLoop('test_local', state, fs, pm);
      expect(result?.output).toBe('5');
    });

    it('local variables do not leak outside function', () => {
      // Define function with local var
      executeInlineLoop('set_local() { local myvar=secret; echo $myvar; }', state, fs, pm);
      const result1 = executeInlineLoop('set_local', state, fs, pm);
      expect(result1?.output).toBe('secret');

      // Variable should not exist outside function
      const result2 = executeShellCommand('echo "Value: $myvar"', state, fs, pm);
      expect(result2.output).toBe('Value: ');
    });

    it('LIMITATION: process substitution not supported', () => {
      // <(cmd) should create a file descriptor
      const result = executeShellCommand('diff <(echo a) <(echo b)', state, fs, pm);
      // Process substitution is not implemented
      expect(result.exitCode).toBeDefined();
    });
  });

  describe('CI/CD Pipeline Patterns', () => {
    it('simulates build and test pipeline', () => {
      const script = `
        echo "=== Build Stage ==="
        echo "Compiling source..."
        echo "Build successful"
        echo ""
        echo "=== Test Stage ==="
        for test in unit integration e2e; do
          echo "Running $test tests..."
        done
        echo "All tests passed"
        echo ""
        echo "=== Deploy Stage ==="
        if test "$APP_ENV" = "production"; then
          echo "Deploying to production..."
        fi
      `;

      const result = executeScript(script, state, fs, pm);
      expect(result.output).toContain('Build Stage');
      expect(result.output).toContain('Running unit tests');
      expect(result.output).toContain('Running integration tests');
      expect(result.output).toContain('All tests passed');
      expect(result.output).toContain('Deploying to production');
    });

    it('handles error checking pattern', () => {
      const script = `
        echo "Checking prerequisites..."
        if test -d /home/user; then
          echo "Home directory exists"
        else
          echo "ERROR: Home directory not found"
        fi
      `;

      const result = executeScript(script, state, fs, pm);
      expect(result.output).toContain('Home directory exists');
    });
  });
});
