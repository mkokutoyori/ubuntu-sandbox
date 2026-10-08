/*
 * Oracle: auditctl 3.1.2 (real binary) run against scripts/oracle/audit_fake_kernel.c,
 * a deterministic in-process netlink audit kernel (LD_PRELOAD). The fixture replays
 * 3715 scenarios / 17019 invocations (stdout, stderr, exit code) against the TS port
 * (runAuditctl + AuditKernelState). Measured before the port: the module did not
 * exist, so all 3715 scenarios fall. Witnesses (pass either way): none - every
 * scenario reads real output. Kernel semantics are those of the fake kernel; the
 * VM's own kernel audit was locked (-e 2) and could not be used as a second oracle.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { runAuditctl, type AuditctlHost } from '@/network/devices/linux/audit/tools/AuditctlTool';
import { AuditKernelState } from '@/network/devices/linux/audit/tools/AuditKernelState';
import { MACH } from '@/network/devices/linux/audit/tools/AuditctlLib';

interface Step { args: string[]; stdout: string; stderr: string; code: number }
interface Scenario { name: string; files: Record<string, string>; steps: Step[] }
const fixture = JSON.parse(readFileSync('src/__tests__/support/oracle/audit-tools/auditctl-3.1.2.json', 'utf8')) as {
  paths: Record<string, 'directory' | 'file' | 'missing'>; scenarios: Scenario[]; hostdb: { passwd: string; group: string; protocols: string };
};

const users = new Map<number, string>();
const userIds = new Map<string, number>();
for (const line of fixture.hostdb.passwd.split('\n')) {
  const f = line.split(':');
  if (f.length > 2) { if (!users.has(Number(f[2]))) users.set(Number(f[2]), f[0]); userIds.set(f[0], Number(f[2])); }
}
const groups = new Map<number, string>();
const groupIds = new Map<string, number>();
for (const line of fixture.hostdb.group.split('\n')) {
  const f = line.split(':');
  if (f.length > 2) { if (!groups.has(Number(f[2]))) groups.set(Number(f[2]), f[0]); groupIds.set(f[0], Number(f[2])); }
}
const protocols = new Map<number, string>();
for (const line of fixture.hostdb.protocols.split('\n')) {
  const f = line.replace(/#.*/, '').trim().split(/\s+/);
  if (f.length >= 2 && /^\d+$/.test(f[1]) && !protocols.has(Number(f[1]))) protocols.set(Number(f[1]), f[0]);
}

function replay(scenario: Scenario): string | null {
  const kind = (path: string): 'directory' | 'file' | 'missing' => (path in scenario.files ? 'file' : (fixture.paths[path] ?? 'missing'));
  const kernel = new AuditKernelState({ pathExists: (path) => kind(path) !== 'missing' });
  const host: AuditctlHost = {
    isRoot: () => true,
    userName: (uid) => users.get(uid) ?? null,
    groupName: (gid) => groups.get(gid) ?? null,
    protocolName: (n) => protocols.get(n) ?? null,
    lookupUser: (name) => userIds.get(name) ?? null,
    lookupGroup: (name) => groupIds.get(name) ?? null,
    fileKind: (path) => kind(path),
    readFile: (path) => scenario.files[path] ?? null,
    kernel: () => kernel,
    detectMachine: () => MACH.X86_64,
    signalProcess: () => -3,
    syslog: () => undefined,
    terminal: () => 'pts/0',
  };
  for (const step of scenario.steps) {
    const result = runAuditctl(host, step.args);
    if (result.stdout !== step.stdout || result.stderr !== step.stderr || result.exitCode !== step.code) {
      return `${scenario.name} steps ${JSON.stringify(scenario.steps.map((s) => s.args))} at ${JSON.stringify(step.args)}\n--- got rc=${result.exitCode}\n${result.stdout}|${result.stderr}\n--- want rc=${step.code}\n${step.stdout}|${step.stderr}\n`;
    }
  }
  return null;
}

describe('auditctl against the real 3.1.2 binary', () => {
  it('replays', () => {
    const failures = fixture.scenarios.map(replay).filter((f): f is string => f !== null);
    writeFileSync('/tmp/claude-0/scratch/auditctl-failures.txt', `${failures.length}/${fixture.scenarios.length}\n${failures.join('\n=====\n')}`);
    expect(failures.length).toBe(0);
  });
});
