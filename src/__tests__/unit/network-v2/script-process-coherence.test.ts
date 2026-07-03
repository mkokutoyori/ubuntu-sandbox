import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

function vfsOf(pc: LinuxPC): VirtualFileSystem {
  return (pc as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

async function writeScript(pc: LinuxPC, path: string, lines: string[]): Promise<void> {
  vfsOf(pc).writeFile(path, ['#!/bin/bash', ...lines, ''].join('\n'), 0, 0, 0o022);
  await pc.executeCommand(`sudo chmod +x ${path}`);
}

function readFile(pc: LinuxPC, path: string): string {
  return vfsOf(pc).readFile(path) ?? '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('script execution ⇄ process table coherence', () => {
  it('a running script is a real process visible in ps from inside', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await writeScript(pc, '/usr/local/bin/observe.sh', [
      'ps aux > /tmp/inside.txt',
      'echo $$ > /tmp/self.pid',
    ]);

    await pc.executeCommand('/usr/local/bin/observe.sh');

    const pid = readFile(pc, '/tmp/self.pid').trim();
    expect(pid).toMatch(/^\d+$/);
    const inside = readFile(pc, '/tmp/inside.txt');
    const ownLine = inside.split('\n').find((l) => l.includes('observe.sh'));
    expect(ownLine).toBeDefined();
    expect(ownLine).toContain(pid);
  });

  it('the script process disappears once the script completes', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await writeScript(pc, '/usr/local/bin/gone.sh', ['echo done']);
    await pc.executeCommand('/usr/local/bin/gone.sh');

    const after = await pc.executeCommand('ps aux');

    expect(after).not.toContain('gone.sh');
  });

  it('$$ in a script differs from the shell pid and $PPID points at the shell', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const shellPid = (await pc.executeCommand('echo $$')).trim();
    await writeScript(pc, '/usr/local/bin/ident.sh', [
      'echo $$ > /tmp/s.pid',
      'echo $PPID > /tmp/s.ppid',
    ]);

    await pc.executeCommand('/usr/local/bin/ident.sh');

    expect(readFile(pc, '/tmp/s.pid').trim()).not.toBe(shellPid);
    expect(readFile(pc, '/tmp/s.ppid').trim()).toBe(shellPid);
  });

  it('a nested script is a child of the calling script', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await writeScript(pc, '/usr/local/bin/inner.sh', [
      'echo $PPID > /tmp/inner.ppid',
      'ps aux > /tmp/inner.ps',
    ]);
    await writeScript(pc, '/usr/local/bin/outer.sh', [
      'echo $$ > /tmp/outer.pid',
      '/usr/local/bin/inner.sh',
    ]);

    await pc.executeCommand('/usr/local/bin/outer.sh');

    expect(readFile(pc, '/tmp/inner.ppid').trim()).toBe(readFile(pc, '/tmp/outer.pid').trim());
    const insidePs = readFile(pc, '/tmp/inner.ps');
    expect(insidePs).toContain('outer.sh');
    expect(insidePs).toContain('inner.sh');
  });

  it('the script exit code is reported and the process exits', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await writeScript(pc, '/usr/local/bin/fail.sh', ['exit 7']);

    await pc.executeCommand('/usr/local/bin/fail.sh');
    const code = (await pc.executeCommand('echo $?')).trim();

    expect(code).toBe('7');
    expect(await pc.executeCommand('ps aux')).not.toContain('fail.sh');
  });

  it('kill $$ aborts the script: later commands never run', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await writeScript(pc, '/usr/local/bin/suicide.sh', [
      'touch /tmp/before',
      'kill $$',
      'touch /tmp/after',
    ]);

    await pc.executeCommand('/usr/local/bin/suicide.sh');
    const code = (await pc.executeCommand('echo $?')).trim();

    expect(vfsOf(pc).exists('/tmp/before')).toBe(true);
    expect(vfsOf(pc).exists('/tmp/after')).toBe(false);
    expect(code).toBe('143');
  });

  it('bash -c runs in its own short-lived process', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const shellPid = (await pc.executeCommand('echo $$')).trim();

    const first = (await pc.executeCommand("bash -c 'echo $$'")).trim();
    const second = (await pc.executeCommand("bash -c 'echo $$'")).trim();

    expect(first).not.toBe(shellPid);
    expect(second).not.toBe(shellPid);
    expect(first).not.toBe(second);
    expect(await pc.executeCommand('ps aux')).not.toContain('bash -c');
  });

  it('bash script.sh spawns a process just like ./script.sh', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const shellPid = (await pc.executeCommand('echo $$')).trim();
    await writeScript(pc, '/usr/local/bin/via-bash.sh', ['echo $$ > /tmp/vb.pid']);

    await pc.executeCommand('bash /usr/local/bin/via-bash.sh');

    const pid = readFile(pc, '/tmp/vb.pid').trim();
    expect(pid).toMatch(/^\d+$/);
    expect(pid).not.toBe(shellPid);
  });

  it('run-parts children are real distinct processes', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('mkdir -p /tmp/parts');
    await writeScript(pc, '/tmp/parts/01probe', [
      'echo $$ >> /tmp/parts.pids',
      'ps aux > /tmp/parts.ps',
    ]);
    await writeScript(pc, '/tmp/parts/02probe', ['echo $$ >> /tmp/parts.pids']);

    await pc.executeCommand('run-parts /tmp/parts');

    const pids = readFile(pc, '/tmp/parts.pids').trim().split('\n');
    expect(pids).toHaveLength(2);
    expect(pids[0]).not.toBe(pids[1]);
    const insidePs = readFile(pc, '/tmp/parts.ps');
    expect(insidePs.split('\n').some((l) => l.includes(pids[0]))).toBe(true);
    expect(await pc.executeCommand('ps aux')).not.toContain('01probe');
  });

  it('a service ExecStart script sees the unit MainPID as $$', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await writeScript(pc, '/usr/local/bin/svc.sh', ['echo $$ > /tmp/svc.pid']);
    vfsOf(pc).writeFile('/etc/systemd/system/probe.service',
      ['[Unit]', 'Description=Probe', '[Service]', 'ExecStart=/usr/local/bin/svc.sh', ''].join('\n'),
      0, 0, 0o644);
    await pc.executeCommand('systemctl daemon-reload');

    await pc.executeCommand('systemctl start probe');
    await sleep(50);

    const mainPid = (await pc.executeCommand('systemctl show -p MainPID probe')).trim();
    const seen = readFile(pc, '/tmp/svc.pid').trim();
    expect(seen).toMatch(/^\d+$/);
    expect(mainPid).toBe(`MainPID=${seen}`);
  });
});
