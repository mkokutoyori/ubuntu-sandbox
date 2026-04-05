/**
 * Tests for ScriptRunner — script execution with privilege checks.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxUserManager } from '@/network/devices/linux/LinuxUserManager';
import type { ShellContext } from '@/network/devices/linux/LinuxFileCommands';
import { runScript, runScriptContent } from '@/bash/runtime/ScriptRunner';

let vfs: VirtualFileSystem;
let userMgr: LinuxUserManager;

function makeCtx(uid = 0, gid = 0): ShellContext {
  return { vfs, userMgr, cwd: '/', umask: 0o022, uid, gid };
}

function execCmd(args: string[]): string {
  // Simple mock: just return args joined
  return '';
}

beforeEach(() => {
  vfs = new VirtualFileSystem();
  userMgr = new LinuxUserManager(vfs);
});

// ─── File Existence ─────────────────────────────────────────────

describe('ScriptRunner — File Existence', () => {
  it('returns 127 for non-existent file', () => {
    const ctx = makeCtx();
    const result = runScript(ctx, '/tmp/nonexistent.sh', [], execCmd);
    expect(result.exitCode).toBe(127);
    expect(result.output).toContain('No such file or directory');
  });

  it('returns 126 for a directory', () => {
    const ctx = makeCtx();
    const result = runScript(ctx, '/tmp', [], execCmd);
    expect(result.exitCode).toBe(126);
    expect(result.output).toContain('Is a directory');
  });
});

// ─── Permission Checks ─────────────────────────────────────────

describe('ScriptRunner — Permission Checks', () => {
  it('executes script with execute permission (root)', () => {
    const ctx = makeCtx(0, 0);
    vfs.writeFile('/tmp/test.sh', 'echo hello', 0, 0, 0o022);
    vfs.chmod('/tmp/test.sh', 0o755);
    const result = runScript(ctx, '/tmp/test.sh', [], execCmd);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('hello\n');
  });

  it('root cannot execute file with no execute bits', () => {
    const ctx = makeCtx(0, 0);
    vfs.writeFile('/tmp/test.sh', 'echo hello', 0, 0, 0o022);
    vfs.chmod('/tmp/test.sh', 0o644);
    const result = runScript(ctx, '/tmp/test.sh', [], execCmd);
    expect(result.exitCode).toBe(126);
    expect(result.output).toContain('Permission denied');
  });

  it('non-root owner with execute permission can run', () => {
    const ctx = makeCtx(1000, 1000);
    vfs.writeFile('/tmp/test.sh', 'echo hello', 1000, 1000, 0o022);
    vfs.chmod('/tmp/test.sh', 0o755);
    const result = runScript(ctx, '/tmp/test.sh', [], execCmd);
    expect(result.exitCode).toBe(0);
  });

  it('non-root owner without execute permission is denied', () => {
    const ctx = makeCtx(1000, 1000);
    vfs.writeFile('/tmp/test.sh', 'echo hello', 1000, 1000, 0o022);
    vfs.chmod('/tmp/test.sh', 0o644);
    const result = runScript(ctx, '/tmp/test.sh', [], execCmd);
    expect(result.exitCode).toBe(126);
    expect(result.output).toContain('Permission denied');
  });

  it('other user with other-execute can run', () => {
    const ctx = makeCtx(2000, 2000);
    vfs.writeFile('/tmp/test.sh', 'echo hello', 1000, 1000, 0o022);
    vfs.chmod('/tmp/test.sh', 0o755);
    const result = runScript(ctx, '/tmp/test.sh', [], execCmd);
    expect(result.exitCode).toBe(0);
  });

  it('other user without other-execute is denied', () => {
    const ctx = makeCtx(2000, 2000);
    vfs.writeFile('/tmp/test.sh', 'echo hello', 1000, 1000, 0o022);
    vfs.chmod('/tmp/test.sh', 0o750);
    const result = runScript(ctx, '/tmp/test.sh', [], execCmd);
    expect(result.exitCode).toBe(126);
    expect(result.output).toContain('Permission denied');
  });
});

// ─── Shebang Handling ───────────────────────────────────────────

describe('ScriptRunner — Shebang', () => {
  it('strips shebang line before execution', () => {
    const ctx = makeCtx(0, 0);
    vfs.writeFile('/tmp/test.sh', '#!/bin/bash\necho hello', 0, 0, 0o022);
    vfs.chmod('/tmp/test.sh', 0o755);
    const result = runScript(ctx, '/tmp/test.sh', [], execCmd);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('hello\n');
  });
});

// ─── Script Arguments ───────────────────────────────────────────

describe('ScriptRunner — Script Arguments', () => {
  it('passes positional arguments to script', () => {
    const ctx = makeCtx(0, 0);
    vfs.writeFile('/tmp/test.sh', 'echo $1 $2', 0, 0, 0o022);
    vfs.chmod('/tmp/test.sh', 0o755);
    const result = runScript(ctx, '/tmp/test.sh', ['foo', 'bar'], execCmd);
    expect(result.output).toBe('foo bar\n');
  });

  it('sets $# correctly', () => {
    const ctx = makeCtx(0, 0);
    vfs.writeFile('/tmp/test.sh', 'echo $#', 0, 0, 0o022);
    vfs.chmod('/tmp/test.sh', 0o755);
    const result = runScript(ctx, '/tmp/test.sh', ['a', 'b', 'c'], execCmd);
    expect(result.output).toBe('3\n');
  });
});

// ─── runScriptContent ───────────────────────────────────────────

describe('ScriptRunner — runScriptContent', () => {
  it('executes inline script content', () => {
    const result = runScriptContent('echo hello', 'inline', [], execCmd);
    expect(result.output).toBe('hello\n');
    expect(result.exitCode).toBe(0);
  });

  it('handles syntax errors gracefully', () => {
    const result = runScriptContent('if; then', 'inline', [], execCmd);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('bash:');
  });

  it('passes variables to script', () => {
    const result = runScriptContent('echo $HOME', 'inline', [], execCmd, { HOME: '/root' });
    expect(result.output).toBe('/root\n');
  });
});

// ─── Complex Scripts ────────────────────────────────────────────

describe('ScriptRunner — Complex Scripts', () => {
  it('runs a script with control flow', () => {
    const script = `#!/bin/bash
for i in 1 2 3; do
  echo $i
done`;
    const ctx = makeCtx(0, 0);
    vfs.writeFile('/tmp/loop.sh', script, 0, 0, 0o022);
    vfs.chmod('/tmp/loop.sh', 0o755);
    const result = runScript(ctx, '/tmp/loop.sh', [], execCmd);
    expect(result.output).toBe('1\n2\n3\n');
  });

  it('runs a script with functions', () => {
    const script = `greet() { echo "Hello $1"; }
greet World`;
    const result = runScriptContent(script, 'test', [], execCmd);
    expect(result.output).toBe('Hello World\n');
  });

  it('runs a script with conditionals', () => {
    const script = `X=5
if test $X -gt 3; then
  echo big
else
  echo small
fi`;
    const result = runScriptContent(script, 'test', [], execCmd);
    expect(result.output).toBe('big\n');
  });
});
