/**
 * PowerShell Simulator Diagnostic Script
 *
 * Usage:
 *   npx tsx scripts/ps-diagnostic.ts
 *   npx tsx scripts/ps-diagnostic.ts --filter VAR      # only matching categories/IDs
 *   npx tsx scripts/ps-diagnostic.ts --filter FS
 *   npx tsx scripts/ps-diagnostic.ts --fail-only        # suppress PASSes
 *
 * Exit code: 0 if no FAILs, 1 if any FAIL found.
 */

import { DiagnosticEngine } from './diagnostic/engine';
import { renderReport } from './diagnostic/reporter';
import { variableChecks }       from './diagnostic/checks/01-variables';
import { filesystemChecks }     from './diagnostic/checks/02-filesystem';
import { contentChecks }        from './diagnostic/checks/03-content';
import { pipelineChecks }       from './diagnostic/checks/04-pipeline';
import { processServiceChecks } from './diagnostic/checks/05-process-service';
import { networkChecks }        from './diagnostic/checks/06-network';
import { controlFlowChecks }    from './diagnostic/checks/07-control-flow';
import { errorsRegistryChecks } from './diagnostic/checks/08-errors-registry';

// ─── CLI flags ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const filterArg = args.find((_, i) => args[i - 1] === '--filter');
const failOnly  = args.includes('--fail-only');

// ─── Register all check suites ────────────────────────────────────
const engine = new DiagnosticEngine();
engine
  .register(...variableChecks)
  .register(...filesystemChecks)
  .register(...contentChecks)
  .register(...pipelineChecks)
  .register(...processServiceChecks)
  .register(...networkChecks)
  .register(...controlFlowChecks)
  .register(...errorsRegistryChecks);

// ─── Run ──────────────────────────────────────────────────────────
console.log('\n\x1b[1m\x1b[36mPowerShell Simulator — Diagnostic Report\x1b[0m');
console.log('\x1b[90mProbing real PS5.1 behavioural fidelity…\x1b[0m\n');

const report = await engine.run();

// Apply CLI filters post-run
if (filterArg || failOnly) {
  report.results = report.results.filter(r => {
    if (
      filterArg &&
      !r.case.category.toLowerCase().includes(filterArg.toLowerCase()) &&
      !r.case.id.toLowerCase().includes(filterArg.toLowerCase())
    ) return false;
    if (failOnly && r.status === 'PASS') return false;
    return true;
  });
}

renderReport(report);
process.exit(report.failCount > 0 ? 1 : 0);
