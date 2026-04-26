/**
 * Huawei VRP diagnostic types.
 *
 * Extends the base pattern with a `device` discriminator so each probe
 * can target either a router (HuaweiVRPShell) or a switch (HuaweiSwitchShell).
 */

export type Severity = 'FAIL' | 'WARN' | 'INFO';

/** Which Huawei device class to instantiate for this probe. */
export type HuaweiDeviceKind = 'router' | 'switch';

/**
 * A single Huawei VRP diagnostic probe.
 *
 * Execution model:
 *   1. Fresh device is created (router or switch).
 *   2. Each `setup` command is executed in order (errors ignored).
 *   3. `cmd` is executed; its output is passed to `assert`.
 */
export interface HuaweiDiagnosticCase {
  /** Unique identifier, e.g. "USR-001" */
  id: string;
  /** Logical grouping, e.g. "User View" */
  category: string;
  /** Human-readable description */
  description: string;
  /** Device kind to use for this probe */
  device: HuaweiDeviceKind;
  /** Commands to run before the test command (to set up state) */
  setup?: string[];
  /** The VRP command under test */
  cmd: string;
  /**
   * Assertion: returns null on pass, or a string describing the failure.
   */
  assert: (output: string) => string | null;
  /** Severity when the assertion fails */
  severity: Severity;
  /** Note about real VRP behaviour */
  vrpNote?: string;
}

export interface CheckResult {
  case: HuaweiDiagnosticCase;
  status: 'PASS' | Severity;
  actual: string;
  failReason: string | null;
  durationMs: number;
}

export interface DiagnosticReport {
  results: CheckResult[];
  durationMs: number;
  passCount: number;
  failCount: number;
  warnCount: number;
  infoCount: number;
}
