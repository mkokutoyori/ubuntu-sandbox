#!/usr/bin/env npx tsx
/**
 * Huawei VRP Diagnostic
 *
 * Audits the HuaweiRouter and HuaweiSwitch simulators for correctness,
 * inconsistencies, and missing implementations across all VRP command categories.
 *
 * Usage:
 *   npx tsx scripts/huawei-diagnostic.ts
 *   npx tsx scripts/huawei-diagnostic.ts --filter "DHCP"
 *   npx tsx scripts/huawei-diagnostic.ts --fail-only
 *   npx tsx scripts/huawei-diagnostic.ts --device router
 *   npx tsx scripts/huawei-diagnostic.ts --device switch
 */

import { HuaweiDiagnosticEngine } from './huawei-diagnostic/engine';
import { renderReport }           from './huawei-diagnostic/reporter';
import { userViewChecks }         from './huawei-diagnostic/checks/01-user-view';
import { systemInterfaceChecks }  from './huawei-diagnostic/checks/02-system-interface';
import { routingChecks }          from './huawei-diagnostic/checks/03-routing';
import { vlanSwitchChecks }       from './huawei-diagnostic/checks/04-vlan-switch';
import { dhcpChecks }             from './huawei-diagnostic/checks/05-dhcp';
import { aclChecks }              from './huawei-diagnostic/checks/06-acl';
import { ipsecChecks }            from './huawei-diagnostic/checks/07-ipsec';

// ─── CLI argument parsing ────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const categoryFilter = getArg('--filter');
const deviceFilter   = getArg('--device') as 'router' | 'switch' | null;
const failOnly       = args.includes('--fail-only');

// ─── Build and run engine ────────────────────────────────────────────────────

const engine = new HuaweiDiagnosticEngine();

const allChecks = [
  ...userViewChecks,
  ...systemInterfaceChecks,
  ...routingChecks,
  ...vlanSwitchChecks,
  ...dhcpChecks,
  ...aclChecks,
  ...ipsecChecks,
];

for (const check of allChecks) {
  if (categoryFilter && !check.category.toLowerCase().includes(categoryFilter.toLowerCase())) {
    continue;
  }
  if (deviceFilter && check.device !== deviceFilter) {
    continue;
  }
  engine.register(check);
}

const report = await engine.run();

renderReport(report, { failOnly });

process.exit(report.failCount > 0 ? 1 : 0);
