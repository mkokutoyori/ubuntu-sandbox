/*
 * Oracle: the augenrules script shipped with auditd 3.1.2 (Ubuntu), run by sh over a temporary rules tree with
 * /sbin/auditctl replaced by a stub (scripts/oracle/record_augenrules.py).  400 scenarios compare stdout, exit
 * status, the compiled audit.rules and the audit.rules.prev copy with runAugenrules.  The local awk is mawk
 * 1.3.4-20240123 - the awk of Ubuntu 24.04 - which reads the script's \s as a literal s, so indented comments
 * and "-D  " are NOT recognised; the port reproduces that.  Files are concatenated with cat, without separator.
 * Measured before the port (module absent, git stash push -u -- src/network): all 400 scenarios fall.
 * No witness-free cases: every scenario reads the real output.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { runAugenrules, type AugenrulesHost } from '@/network/devices/linux/audit/tools/AugenrulesTool';

interface Scenario {
  files: Record<string, string>;
  rulesDirExists: boolean;
  existing: string | null;
  args: string[];
  stubRc: number;
  stdout: string;
  stderr: string;
  code: number;
  rules: string | null;
  prev: string | null;
}

const fixture = JSON.parse(readFileSync('src/__tests__/support/oracle/audit-tools/augenrules-3.1.2.json', 'utf8')) as { scenarios: Scenario[] };

describe('augenrules 3.1.2 oracle', () => {
  it('replays every recorded scenario byte for byte', () => {
    const failures: string[] = [];
    fixture.scenarios.forEach((scenario, index) => {
      const written = new Map<string, { content: string; mode: number }>();
      if (scenario.existing !== null) written.set('/etc/audit/audit.rules', { content: scenario.existing, mode: 0o644 });
      const host: AugenrulesHost = {
        listDirectory: (path) => (path === '/etc/audit/rules.d' && scenario.rulesDirExists ? Object.keys(scenario.files) : null),
        readFile: (path) => {
          if (path.startsWith('/etc/audit/rules.d/')) return scenario.files[path.slice('/etc/audit/rules.d/'.length)] ?? null;
          return written.get(path)?.content ?? null;
        },
        writeFile: (path, content, mode) => { written.set(path, { content, mode }); },
        loadRules: (path) => ({ stdout: `auditctl -R ${path}\n`, stderr: '', exitCode: scenario.stubRc, interleaved: '' }),
      };
      const result = runAugenrules(host, scenario.args, 'augenrules');
      const rules = written.get('/etc/audit/audit.rules')?.content ?? null;
      const prev = written.get('/etc/audit/audit.rules.prev')?.content ?? null;
      const wrote = written.get('/etc/audit/audit.rules');
      const modeOk = wrote === undefined || wrote.mode === 0o644 || wrote.mode === 0o640;
      if (result.stdout !== scenario.stdout || result.exitCode !== scenario.code || rules !== scenario.rules || prev !== scenario.prev || !modeOk) {
        failures.push(`#${index} ${JSON.stringify(scenario.args)}: ${JSON.stringify({ got: result.stdout, want: scenario.stdout, code: [result.exitCode, scenario.code] })}`);
      }
    });
    expect(failures.slice(0, 5)).toEqual([]);
    expect(fixture.scenarios.length).toBe(400);
  });
});
