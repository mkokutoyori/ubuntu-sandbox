/**
 * Gap analysis — runs the real Pester suites of the PowerShell repository
 * (test/powershell/Language) through the simulator's PowerShell 7.6 engine and
 * writes a pass/fail report. Not an assertion suite: it reads the checkout
 * named by PESTER_ROOT (default /home/user/powershell/powershell/test/powershell)
 * and skips when it is absent. PESTER_FILES narrows the run (comma-separated
 * paths relative to the root).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { PSInterpreter, createClientCmdletOverlay } from '@/powershell/interpreter/PSInterpreter';
import { createWindowsPSProviders } from '@/powershell/providers/WindowsPSProviders';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { createPesterCmdlets, PesterSession } from './pester/MiniPester';
import type { ICmdlet } from '@/powershell/cmdlets/ICmdlet';

const ROOT = process.env.PESTER_ROOT ?? '/home/user/powershell/powershell/test/powershell';
const DEFAULT_FILES = [
  'Language/Operators', 'Language/Scripting', 'Language/Parser',
];

function collect(relative: string): string[] {
  const path = join(ROOT, relative);
  if (!existsSync(path)) return [];
  if (path.endsWith('.ps1')) return [relative];
  return readdirSync(path, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? collect(join(relative, entry.name)) : entry.name.endsWith('.Tests.ps1') ? [join(relative, entry.name)] : []);
}

const quietModule = (name: string): ICmdlet => ({
  name, aliases: [], parameters: [], execute: () => null,
});

describe.skipIf(!existsSync(ROOT))('Pester language suites on the PowerShell 7.6 engine', () => {
  const requested = (process.env.PESTER_FILES ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const files = (requested.length > 0 ? requested : DEFAULT_FILES).flatMap(collect);

  it('runs and reports', () => {
    const lines: string[] = [];
    let passed = 0, failed = 0, skipped = 0, broken = 0;
    for (const file of files) {
      const session = new PesterSession();
      const registry = createClientCmdletOverlay();
      for (const cmdlet of createPesterCmdlets(session)) registry.register(cmdlet);
      for (const name of ['import-module', 'set-strictmode', 'remove-module']) registry.register(quietModule(name));
      const pc = new WindowsPC('windows-pc', 'PESTER', 0, 0);
      pc.setCurrentUser('Administrator');
      const interp = new PSInterpreter(createWindowsPSProviders(pc), { edition: 'client', registry, language: 'core' });
      let fileError: string | null = null;
      try {
        interp.execute(readFileSync(join(ROOT, file), 'utf8'));
      } catch (error) {
        fileError = error instanceof Error ? error.message.split('\n')[0] : String(error);
      }
      const p = session.results.filter(r => r.status === 'pass').length;
      const f = session.results.filter(r => r.status === 'fail').length;
      const s = session.results.filter(r => r.status === 'skip').length;
      passed += p; failed += f; skipped += s;
      if (fileError !== null) broken++;
      lines.push(`## ${file}  pass=${p} fail=${f} skip=${s}${fileError !== null ? `  FILE ERROR: ${fileError}` : ''}`);
      for (const r of session.results.filter(x => x.status === 'fail')) {
        lines.push(`  FAIL [${r.suite}] ${r.name}\n       ${(r.message ?? '').split('\n')[0]}`);
      }
    }
    lines.unshift(`TOTAL pass=${passed} fail=${failed} skip=${skipped} filesWithErrors=${broken} files=${files.length}`);
    writeFileSync('/tmp/pester-report.txt', lines.join('\n'));
    expect(files.length).toBeGreaterThan(0);
  }, 900000);
});
