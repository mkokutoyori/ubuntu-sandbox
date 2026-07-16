import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `SECDEMO [RUN|SCAN SOD|SCAN DORMANT|STATUS]` — pilote la démonstration
 * d'audit sécurité. `RUN`/`RUN ALL`/nu : exécute tous les scénarios de
 * fraude puis affiche le statut du journal ; `SCAN SOD`/`SCAN DORMANT` :
 * relance un seul évaluateur et retourne immédiatement (pas de statut) ;
 * `STATUS`/tout le reste : statut seul (ou erreur SP2-0734 si sous-commande
 * inconnue). Mutations déléguées à `machine.oracle.runFraudScenarios`/
 * `scanSodViolations`/`sweepDormantAccounts` (partagées avec le legacy
 * `handleSecDemo`).
 */
export class SqlPlusSecdemoCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'SECDEMO',
    summary: 'Démonstration d\'audit sécurité (scénarios de fraude)',
    usage: 'SECDEMO [RUN|SCAN SOD|SCAN DORMANT|STATUS]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'sous-commande, vide = RUN puis STATUS' },
    ],
    options: [],
    privileges: ANY,
    category: 'sqlplus',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const oracle = ctx.machine.oracle!;
    const args = (ctx.args.get<string[] | undefined>('rest') ?? []).join(' ').replace(/;\s*$/, '').trim().toUpperCase();
    const out: string[] = [];

    if (args === '' || args === 'RUN' || args === 'RUN ALL') {
      out.push('Running security-audit fraud scenarios...');
      for (const r of oracle.runFraudScenarios()) {
        out.push(`  [${r.scenario}] steps=${r.stepCount}`);
      }
      out.push('');
    } else if (args === 'SCAN SOD') {
      const n = oracle.scanSodViolations();
      await ctx.io.stdout.write(`SoD scan complete — ${n} new violation(s) journaled.\n`);
      return EXIT_OK;
    } else if (args === 'SCAN DORMANT') {
      const n = oracle.sweepDormantAccounts();
      await ctx.io.stdout.write(`Dormant-account sweep complete — ${n} account(s) flagged.\n`);
      return EXIT_OK;
    } else if (args !== 'STATUS') {
      await ctx.io.stdout.write([
        `SP2-0734: unknown SECDEMO subcommand "${args}"`,
        'Available: RUN | SCAN SOD | SCAN DORMANT | STATUS',
      ].join('\n') + '\n');
      return EXIT_OK;
    }

    const counts = oracle.securityAuditJournalCounts();
    out.push('Security audit journal status:');
    out.push(`  Connection traces:    ${counts.connectionTraces}`);
    out.push(`  DDL history:          ${counts.ddlHistory}`);
    out.push(`  DML history:          ${counts.dmlHistory}`);
    out.push(`  Sensitive accesses:   ${counts.sensitiveAccess}`);
    out.push(`  Privilege usage rows: ${counts.privilegeUsage}`);
    out.push(`  SoD policies:         ${counts.sodPolicies}`);
    out.push(`  SoD violations:       ${counts.sodViolations}`);
    out.push(`  Dormant accounts:     ${counts.dormantAccounts}`);
    out.push(`  Anomalies:            ${counts.anomalies}`);

    await ctx.io.stdout.write(out.join('\n') + '\n');
    return EXIT_OK;
  }
}
