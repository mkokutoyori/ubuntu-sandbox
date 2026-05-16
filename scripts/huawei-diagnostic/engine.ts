/**
 * HuaweiDiagnosticEngine
 *
 * Runs each HuaweiDiagnosticCase against a fresh device instance so that
 * probes are fully isolated from one another.
 */

import { HuaweiRouter }  from '../../src/network/devices/HuaweiRouter';
import { HuaweiSwitch }  from '../../src/network/devices/HuaweiSwitch';
import { resetCounters } from '../../src/network/core/types';
import { resetDeviceCounters } from '../../src/network/devices/DeviceFactory';
import { Logger }        from '../../src/network/core/Logger';
import type { HuaweiDiagnosticCase, CheckResult, DiagnosticReport } from './types';

export class HuaweiDiagnosticEngine {
  private readonly cases: HuaweiDiagnosticCase[] = [];

  register(...checks: HuaweiDiagnosticCase[]): this {
    this.cases.push(...checks);
    return this;
  }

  async run(): Promise<DiagnosticReport> {
    const start = Date.now();
    const results: CheckResult[] = [];

    for (const c of this.cases) {
      results.push(await this.runCase(c));
    }

    return {
      results,
      durationMs: Date.now() - start,
      passCount:  results.filter(r => r.status === 'PASS').length,
      failCount:  results.filter(r => r.status === 'FAIL').length,
      warnCount:  results.filter(r => r.status === 'WARN').length,
      infoCount:  results.filter(r => r.status === 'INFO').length,
    };
  }

  private async runCase(c: HuaweiDiagnosticCase): Promise<CheckResult> {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();

    const device = c.device === 'router'
      ? new HuaweiRouter('DIAG-R')
      : new HuaweiSwitch('switch-huawei', 'DIAG-SW');

    const start = Date.now();
    try {
      for (const setupCmd of c.setup ?? []) {
        await device.executeCommand(setupCmd);
      }
      const actual = (await device.executeCommand(c.cmd)) ?? '';
      const failReason = c.assert(actual);
      return {
        case: c,
        status: failReason === null ? 'PASS' : c.severity,
        actual,
        failReason,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        case: c,
        status: c.severity,
        actual: '',
        failReason: `threw exception: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
      };
    }
  }
}

// ─── Assertion helpers ────────────────────────────────────────────

export const assert = {
  contains(expected: string) {
    return (out: string): string | null =>
      out.includes(expected) ? null
        : `expected to contain "${expected}"\n  actual: ${JSON.stringify(out.slice(0, 300))}`;
  },
  notContains(forbidden: string) {
    return (out: string): string | null =>
      !out.includes(forbidden) ? null
        : `expected NOT to contain "${forbidden}"\n  actual: ${JSON.stringify(out.slice(0, 300))}`;
  },
  matches(pattern: RegExp) {
    return (out: string): string | null =>
      pattern.test(out) ? null
        : `expected to match ${pattern}\n  actual: ${JSON.stringify(out.slice(0, 300))}`;
  },
  exact(expected: string) {
    return (out: string): string | null =>
      out.trim() === expected.trim() ? null
        : `expected:\n  ${JSON.stringify(expected.trim())}\n  actual:\n  ${JSON.stringify(out.trim().slice(0, 300))}`;
  },
  notEmpty() {
    return (out: string): string | null =>
      out.trim().length > 0 ? null : 'expected non-empty output but got empty string';
  },
  empty() {
    return (out: string): string | null =>
      out.trim().length === 0 ? null
        : `expected empty output\n  actual: ${JSON.stringify(out.slice(0, 300))}`;
  },
  promptContains(fragment: string) {
    // Checks that the prompt (not the output) changed to contain fragment.
    // We verify by checking the device prompt after running setup.
    // Since we can't easily inspect prompt here, we use output heuristics.
    return (out: string): string | null =>
      out.includes(fragment) ? null
        : `expected prompt/output to contain "${fragment}"\n  actual: ${JSON.stringify(out.slice(0, 300))}`;
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
  any(...fns: Array<(out: string) => string | null>) {
    return (out: string): string | null => {
      const reasons: string[] = [];
      for (const fn of fns) {
        const r = fn(out);
        if (r === null) return null;
        reasons.push(r);
      }
      return `none of the conditions matched:\n  ${reasons.join('\n  ')}`;
    };
  },
};
