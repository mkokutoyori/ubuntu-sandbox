/**
 * Terminal reporter: renders a DiagnosticReport with ANSI colours.
 *
 * Output structure:
 *   ── Category ──────────────────
 *   PASS VAR-001  $PSVersionTable contains PSVersion
 *   FAIL VAR-002  $home resolves to user home directory
 *        actual:  "C:\Users\User\Documents"
 *        note:    Real PS returns C:\Users\<username>
 *   ─────────────────────────────
 *   Summary: 42 PASS  3 FAIL  5 WARN  2 INFO  (50 total)
 */

import type { DiagnosticReport, CheckResult } from './types';

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  grey:   '\x1b[90m',
};

function statusBadge(status: CheckResult['status']): string {
  switch (status) {
    case 'PASS': return `${C.green}${C.bold}PASS${C.reset}`;
    case 'FAIL': return `${C.red}${C.bold}FAIL${C.reset}`;
    case 'WARN': return `${C.yellow}${C.bold}WARN${C.reset}`;
    case 'INFO': return `${C.blue}${C.bold}INFO${C.reset}`;
  }
}

function categoryHeader(name: string): string {
  const line = '─'.repeat(Math.max(0, 60 - name.length - 4));
  return `\n${C.cyan}${C.bold}── ${name} ${line}${C.reset}`;
}

export function renderReport(report: DiagnosticReport): void {
  let currentCategory = '';

  for (const result of report.results) {
    if (result.case.category !== currentCategory) {
      currentCategory = result.case.category;
      console.log(categoryHeader(currentCategory));
    }

    const id   = result.case.id.padEnd(10);
    const desc = result.case.description;
    console.log(`  ${statusBadge(result.status)} ${C.grey}${id}${C.reset} ${desc}`);

    if (result.failReason !== null) {
      const indent = '            ';
      const reason = result.failReason.split('\n').join('\n' + indent);
      console.log(`${indent}${C.dim}${reason}${C.reset}`);
      if (result.case.psNote) {
        console.log(`${indent}${C.blue}note:${C.reset}     ${result.case.psNote}`);
      }
    }
  }

  console.log(`\n${C.cyan}${'─'.repeat(64)}${C.reset}`);
  renderSummary(report);
}

function renderSummary(report: DiagnosticReport): void {
  const total = report.results.length;
  const { passCount, failCount, warnCount, infoCount, durationMs } = report;

  const parts = [
    `${C.green}${C.bold}${passCount} PASS${C.reset}`,
    failCount > 0 ? `${C.red}${C.bold}${failCount} FAIL${C.reset}` : `${C.grey}0 FAIL${C.reset}`,
    warnCount > 0 ? `${C.yellow}${C.bold}${warnCount} WARN${C.reset}` : `${C.grey}0 WARN${C.reset}`,
    infoCount > 0 ? `${C.blue}${C.bold}${infoCount} INFO${C.reset}` : `${C.grey}0 INFO${C.reset}`,
  ];

  console.log(`${C.bold}Summary:${C.reset} ${parts.join('  ')}  ${C.grey}(${total} total, ${durationMs}ms)${C.reset}\n`);

  if (failCount > 0) {
    console.log(`${C.red}${C.bold}─── FAILURES ────────────────────────────────────────────────${C.reset}`);
    for (const r of report.results.filter(r => r.status === 'FAIL')) {
      console.log(`  ${C.red}●${C.reset} ${r.case.id}: ${r.case.description}`);
      if (r.failReason) {
        console.log(`    ${C.dim}${r.failReason.split('\n')[0]}${C.reset}`);
      }
    }
    console.log();
  }
}
