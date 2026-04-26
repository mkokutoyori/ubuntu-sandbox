/**
 * Core types for the PowerShell simulator diagnostic engine.
 *
 * A DiagnosticCase describes a single probe: what to run, how to assert,
 * and how to classify the result.
 */

export type Severity = 'FAIL' | 'WARN' | 'INFO';

/**
 * A single diagnostic probe.
 */
export interface DiagnosticCase {
  /** Unique identifier, e.g. "VAR-001" */
  id: string;
  /** Logical grouping, e.g. "Variables" */
  category: string;
  /** Human-readable description of what is being tested */
  description: string;
  /**
   * Commands to run before the main command to set up state.
   * Each is executed but its output is ignored.
   */
  setup?: string[];
  /** The PowerShell command under test */
  cmd: string;
  /**
   * Assertion function: returns null on pass, or a string describing
   * what was wrong (the "actual" value vs expectation).
   */
  assert: (output: string) => string | null;
  /**
   * Classification when the assertion fails:
   *   FAIL — wrong output, real bug
   *   WARN — missing feature or imprecise output
   *   INFO — known limitation, not a bug
   */
  severity: Severity;
  /** Optional note about real PS5.1 behaviour for context in the report */
  psNote?: string;
}

/**
 * Result of running a single DiagnosticCase.
 */
export interface CheckResult {
  case: DiagnosticCase;
  status: 'PASS' | Severity;
  actual: string;
  failReason: string | null;
  durationMs: number;
}

/**
 * Aggregated report produced by the DiagnosticEngine.
 */
export interface DiagnosticReport {
  results: CheckResult[];
  durationMs: number;
  passCount: number;
  failCount: number;
  warnCount: number;
  infoCount: number;
}
