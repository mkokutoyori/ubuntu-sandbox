/**
 * Data Recovery Advisor (DRA) — détection et réparation guidées des
 * sinistres Oracle introduits dans 11g.
 *
 *   LIST FAILURE
 *   LIST FAILURE <failureId> DETAIL
 *   LIST FAILURE EXCLUDE FAILURE <ids>
 *   ADVISE FAILURE
 *   ADVISE FAILURE <ids>
 *   REPAIR FAILURE PREVIEW
 *   REPAIR FAILURE [NOPROMPT]
 *   CHANGE FAILURE <ids> PRIORITY LOW|HIGH
 *   CHANGE FAILURE <ids> CLOSE
 *
 * Le sandbox n'a pas de vraie détection de corruption — on simule un
 * cas-école qui sert à valider la syntaxe et le pipeline. Chaque
 * "failure" a un id auto-incrémenté, une priorité et un statut.
 */

import { ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand } from './types';

export type DraVerb = 'LIST' | 'LIST_DETAIL' | 'ADVISE' | 'REPAIR_PREVIEW' | 'REPAIR' | 'CHANGE_PRIORITY' | 'CHANGE_CLOSE';

/** Modèle minimal de "failure" — partagé entre LIST / ADVISE / REPAIR. */
interface Failure {
  id: number;
  priority: 'HIGH' | 'MEDIUM' | 'LOW' | 'CRITICAL';
  status: 'OPEN' | 'CLOSED';
  detected: string;
  description: string;
  advice: string;
  repair: string;
}

// Cas-école — 3 failures réalistes auxquelles un DBA est confronté.
const SEED_FAILURES: Failure[] = [
  {
    id: 142, priority: 'HIGH', status: 'OPEN',
    detected: new Date().toISOString().slice(0, 19).replace('T', ' '),
    description: 'One or more non-system datafiles are missing',
    advice: 'Restore and recover datafile 4',
    repair: 'RESTORE DATAFILE 4; RECOVER DATAFILE 4;',
  },
  {
    id: 175, priority: 'HIGH', status: 'OPEN',
    detected: new Date().toISOString().slice(0, 19).replace('T', ' '),
    description: 'Datafile 1: \'/u01/app/oracle/oradata/ORCL/system01.dbf\' contains corrupted blocks',
    advice: 'Perform block media recovery of file 1, blocks 1234 and 5678',
    repair: 'BLOCKRECOVER DATAFILE 1 BLOCK 1234, 5678;',
  },
  {
    id: 203, priority: 'LOW', status: 'OPEN',
    detected: new Date().toISOString().slice(0, 19).replace('T', ' '),
    description: 'Redo log group 3 missing one of its member files',
    advice: 'Recreate the missing member of redo log group 3',
    repair: 'ALTER DATABASE DROP LOGFILE MEMBER \'/u01/redo03b.log\'; ' +
            'ALTER DATABASE ADD LOGFILE MEMBER \'/u01/redo03b.log\' TO GROUP 3;',
  },
];

export class DataRecoveryAdvisorCommand implements IRmanCommand<string[]> {
  readonly name = 'DRA';
  constructor(private readonly verb: DraVerb) {}

  execute(args: string[]): Result<string[], RmanError> {
    const failures = SEED_FAILURES;

    if (this.verb === 'LIST') {
      const open = failures.filter(f => f.status === 'OPEN');
      if (open.length === 0) {
        return ok(['', 'no failure', 'no failures known to RMAN at this time', '']);
      }
      const lines = [
        '',
        'List of Database Failures',
        '=========================',
        '',
        'Failure ID Priority Status    Time Detected        Summary',
        '---------- -------- --------- ------------------- -------',
      ];
      for (const f of open) {
        lines.push(
          `${String(f.id).padEnd(10)} ${f.priority.padEnd(8)} ${f.status.padEnd(9)} ` +
          `${f.detected.padEnd(19)} ${f.description}`,
        );
      }
      lines.push('');
      return ok(lines);
    }

    if (this.verb === 'LIST_DETAIL') {
      const ids = (args[0] ?? '').split(/[\s,]+/).map(s => Number(s.trim())).filter(Number.isFinite);
      const targets = failures.filter(f => ids.length === 0 || ids.includes(f.id));
      const lines: string[] = ['', 'List of Database Failures', '========================='];
      for (const f of targets) {
        lines.push('');
        lines.push(`Failure ID:  ${f.id}`);
        lines.push(`Priority:    ${f.priority}`);
        lines.push(`Status:      ${f.status}`);
        lines.push(`Detected:    ${f.detected}`);
        lines.push(`Description: ${f.description}`);
        lines.push('Impact:      Database operations affected until repaired');
      }
      lines.push('');
      return ok(lines);
    }

    if (this.verb === 'ADVISE') {
      const open = failures.filter(f => f.status === 'OPEN');
      const lines = ['', 'analyzing automatic repair options; this may take some time', '',
        'mapping failure ' + open.map(f => f.id).join(', ') + ' to repair options',
        '', 'List of Repair Options', '======================'];
      for (const f of open) {
        lines.push('');
        lines.push(`Option: 1`);
        lines.push(`Strategy:        Repair failure ${f.id}`);
        lines.push(`Repair Script:   ${f.advice}`);
        lines.push(`Repair script generated:`);
        lines.push(`   ${f.repair}`);
      }
      lines.push('');
      return ok(lines);
    }

    if (this.verb === 'REPAIR_PREVIEW') {
      const open = failures.filter(f => f.status === 'OPEN');
      const lines = ['', 'Strategy: The following repair actions are required:', ''];
      for (const f of open) {
        lines.push(`  ${f.repair}`);
      }
      lines.push('', 'use "REPAIR FAILURE" to execute these actions', '');
      return ok(lines);
    }

    if (this.verb === 'REPAIR') {
      const open = failures.filter(f => f.status === 'OPEN');
      const lines: string[] = ['', 'executing repair script', ''];
      for (const f of open) {
        lines.push(`Failure ${f.id} is repaired`);
        // Idempotent on the in-memory snapshot — we don't mutate the seed.
        // Real Oracle marks the row CLOSED; sandbox just reports success.
      }
      lines.push('', `Repair of failures complete`, '');
      return ok(lines);
    }

    if (this.verb === 'CHANGE_PRIORITY') {
      const ids = (args[0] ?? '').split(/[\s,]+/).filter(Boolean);
      const newP = (args[1] ?? 'LOW').toUpperCase();
      return ok([`changed ${ids.length} failure(s) to priority ${newP}`]);
    }

    if (this.verb === 'CHANGE_CLOSE') {
      const ids = (args[0] ?? '').split(/[\s,]+/).filter(Boolean);
      return ok([`closed ${ids.length} failure(s)`]);
    }

    return ok([]);
  }
}
