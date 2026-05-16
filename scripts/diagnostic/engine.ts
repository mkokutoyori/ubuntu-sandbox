/**
 * DiagnosticEngine: orchestrates probe execution and result collection.
 *
 * Each probe gets a fresh WindowsPC + PowerShellExecutor instance so that
 * setup state is isolated between checks.
 */

import { WindowsPC } from '../../src/network/devices/WindowsPC';
import { PowerShellExecutor } from '../../src/network/devices/windows/PowerShellExecutor';
import { resetCounters } from '../../src/network/core/types';
import { resetDeviceCounters } from '../../src/network/devices/DeviceFactory';
import { Logger } from '../../src/network/core/Logger';
import type { DiagnosticCase, CheckResult, DiagnosticReport } from './types';

export class DiagnosticEngine {
  private readonly cases: DiagnosticCase[] = [];

  register(...checks: DiagnosticCase[]): this {
    this.cases.push(...checks);
    return this;
  }

  async run(): Promise<DiagnosticReport> {
    const start = Date.now();
    const results: CheckResult[] = [];

    for (const c of this.cases) {
      results.push(await this.runCase(c));
    }

    const passCount  = results.filter(r => r.status === 'PASS').length;
    const failCount  = results.filter(r => r.status === 'FAIL').length;
    const warnCount  = results.filter(r => r.status === 'WARN').length;
    const infoCount  = results.filter(r => r.status === 'INFO').length;

    return { results, durationMs: Date.now() - start, passCount, failCount, warnCount, infoCount };
  }

  private async runCase(c: DiagnosticCase): Promise<CheckResult> {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();

    const pc = new WindowsPC('windows-pc', 'DIAG-PC');
    const ps = new PowerShellExecutor(pc);

    const caseStart = Date.now();
    try {
      for (const setupCmd of c.setup ?? []) {
        await ps.execute(setupCmd);
      }
      const actual = (await ps.execute(c.cmd)) ?? '';
      const failReason = c.assert(actual);
      const status = failReason === null ? 'PASS' : c.severity;
      return { case: c, status, actual, failReason, durationMs: Date.now() - caseStart };
    } catch (err) {
      const failReason = `threw exception: ${err instanceof Error ? err.message : String(err)}`;
      return { case: c, status: c.severity, actual: '', failReason, durationMs: Date.now() - caseStart };
    }
  }
}

// ─── Assertion helpers ────────────────────────────────────────────

export const assert = {
  contains(expected: string) {
    return (out: string): string | null =>
      out.includes(expected) ? null : `expected to contain "${expected}"\n  actual: ${JSON.stringify(out.slice(0, 200))}`;
  },
  notContains(forbidden: string) {
    return (out: string): string | null =>
      !out.includes(forbidden) ? null : `expected NOT to contain "${forbidden}"\n  actual: ${JSON.stringify(out.slice(0, 200))}`;
  },
  matches(pattern: RegExp) {
    return (out: string): string | null =>
      pattern.test(out) ? null : `expected to match ${pattern}\n  actual: ${JSON.stringify(out.slice(0, 200))}`;
  },
  exact(expected: string) {
    return (out: string): string | null =>
      out.trim() === expected.trim() ? null : `expected:\n  ${JSON.stringify(expected.trim())}\n  actual:\n  ${JSON.stringify(out.trim().slice(0, 200))}`;
  },
  notEmpty() {
    return (out: string): string | null =>
      out.trim().length > 0 ? null : 'expected non-empty output but got empty string';
  },
  empty() {
    return (out: string): string | null =>
      out.trim().length === 0 ? null : `expected empty output\n  actual: ${JSON.stringify(out.slice(0, 200))}`;
  },
  all(...fns: Array<(out: string) => string | null>) {
    return (out: string): string | null => {
      for (const fn of fns) {
        const r = fn(out);
        if (r !== null) return r;
      }
      return null;
    };
  },
};
