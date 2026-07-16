import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** Classe le type affiché dans la colonne TYPE de SHOW PARAMETER[S]/SPPARAMETER[S] — mirroir du legacy `getParamTypeStr`. */
function paramTypeStr(value: string): string {
  if (value === 'TRUE' || value === 'FALSE') return 'boolean';
  if (/^\d+$/.test(value)) return 'integer';
  if (/^\d+[MmGgKk]$/i.test(value)) return 'big integer';
  return 'string';
}

/**
 * SHOW <option> — affiche un réglage SQL*Plus ou une info d'instance
 * (USER, CON_NAME/CON_ID, SGA, PARAMETER[S], SPPARAMETER[S], ALL…).
 * Lecture pure via `machine.oracle` — aucune mutation.
 *
 * Wave 1 : `SHOW ERRORS` reste porté par le legacy (nécessite les DTOs de
 * compilation du catalogue, pas encore exposés côté MachineApi).
 */
export class SqlPlusShowCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'SHOW',
    summary: 'Affiche un réglage SQL*Plus ou une information de instance',
    usage: 'SHOW <option>',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'option (USER, SGA, PARAMETER [nom], ALL…)' },
    ],
    options: [],
    privileges: ANY,
    category: 'sqlplus',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const parts = ctx.args.get<string[] | undefined>('rest') ?? [];
    const option = parts.join(' ').trim().replace(/;+$/, '').toUpperCase();
    const oracle = ctx.machine.oracle!;
    const out: string[] = [];

    switch (option) {
      case 'USER':
        out.push(`USER is "${oracle.currentUser()}"`);
        break;
      case 'CON_NAME':
        out.push('CON_NAME', '------------------------------', oracle.conName());
        break;
      case 'CON_ID':
        out.push('CON_ID', '------------------------------', String(oracle.conId()));
        break;
      case 'LINESIZE': case 'LIN':
        out.push(`linesize ${oracle.settings().linesize}`);
        break;
      case 'PAGESIZE': case 'PAGES':
        out.push(`pagesize ${oracle.settings().pagesize}`);
        break;
      case 'SERVEROUTPUT': case 'SERVEROUT':
        out.push(`serveroutput ${oracle.settings().serveroutput ? 'ON' : 'OFF'}`);
        break;
      case 'FEEDBACK': case 'FEED':
        out.push(`FEEDBACK ON for ${oracle.settings().feedback ? '1' : '0'} or more rows`);
        break;
      case 'TIMING': case 'TIM':
        out.push(`timing ${oracle.settings().timing ? 'ON' : 'OFF'}`);
        break;
      case 'AUTOCOMMIT': case 'AUTO':
        out.push(`autocommit ${oracle.settings().autocommit ? 'ON' : 'OFF'}`);
        break;
      case 'HEADING': case 'HEA':
        out.push(`heading ${oracle.settings().heading ? 'ON' : 'OFF'}`);
        break;
      case 'SGA': {
        const sga = oracle.sgaInfo();
        if (!sga) { out.push('ERROR:', 'ORA-01012: not logged on'); break; }
        out.push('');
        out.push('Total System Global Area  ' + sga.totalSize);
        out.push('Fixed Size                2.0M');
        out.push('Variable Size             256.0M');
        out.push('Database Buffers          ' + sga.bufferCache);
        out.push('Redo Buffers              ' + sga.redoLogBuffer);
        break;
      }
      case 'PARAMETER':
      case 'PARAMETERS': {
        const params = oracle.allParameters();
        if (!params) { out.push('ERROR:', 'ORA-01012: not logged on'); break; }
        out.push('');
        out.push('NAME'.padEnd(44) + 'TYPE'.padEnd(12) + 'VALUE');
        out.push('-'.repeat(44) + ' ' + '-'.repeat(11) + ' ' + '-'.repeat(30));
        for (const [name, value] of params) {
          out.push(name.padEnd(44) + paramTypeStr(value).padEnd(12) + value);
        }
        break;
      }
      case 'ALL': {
        const s = oracle.settings();
        out.push(`autocommit ${s.autocommit ? 'ON' : 'OFF'}`);
        out.push(`colsep "${s.colsep}"`);
        out.push(`echo ${s.echo ? 'ON' : 'OFF'}`);
        out.push(`feedback ${s.feedback ? 'ON' : 'OFF'}`);
        out.push(`heading ${s.heading ? 'ON' : 'OFF'}`);
        out.push(`linesize ${s.linesize}`);
        out.push(`null "${s.null_display}"`);
        out.push(`pagesize ${s.pagesize}`);
        out.push(`serveroutput ${s.serveroutput ? 'ON' : 'OFF'}`);
        out.push(`timing ${s.timing ? 'ON' : 'OFF'}`);
        out.push(`verify ${s.verify ? 'ON' : 'OFF'}`);
        out.push(`wrap ${s.wrap ? 'ON' : 'OFF'}`);
        break;
      }
      case 'RELEASE':
        out.push('release 1903000000');
        break;
      case 'SQLPROMPT':
        out.push(`sqlprompt "${oracle.settings().sqlprompt}"`);
        break;
      default: {
        if (option.startsWith('PARAMETER ') || option.startsWith('PARAMETERS ')) {
          const search = option.replace(/^PARAMETERS?\s*/, '').toLowerCase();
          const params = oracle.allParameters();
          if (!params) { out.push('ERROR:', 'ORA-01012: not logged on'); break; }
          out.push('');
          out.push('NAME'.padEnd(44) + 'TYPE'.padEnd(12) + 'VALUE');
          out.push('-'.repeat(44) + ' ' + '-'.repeat(11) + ' ' + '-'.repeat(30));
          for (const [name, value] of params) {
            if (!search || name.includes(search)) {
              out.push(name.padEnd(44) + paramTypeStr(value).padEnd(12) + value);
            }
          }
        } else if (option.startsWith('SPPARAMETER ') || option.startsWith('SPPARAMETERS ')
                   || option === 'SPPARAMETER' || option === 'SPPARAMETERS') {
          const search = option.replace(/^SPPARAMETERS?\s*/, '').toLowerCase();
          const params = oracle.spfileParameters();
          if (!params) { out.push('ERROR:', 'ORA-01012: not logged on'); break; }
          out.push('');
          out.push('SID'.padEnd(10) + 'NAME'.padEnd(44) + 'TYPE'.padEnd(12) + 'VALUE');
          out.push('-'.repeat(9) + ' ' + '-'.repeat(44) + ' ' + '-'.repeat(11) + ' ' + '-'.repeat(30));
          for (const [name, value] of params) {
            if (!search || name.includes(search)) {
              out.push('*'.padEnd(10) + name.padEnd(44) + paramTypeStr(value).padEnd(12) + value);
            }
          }
        } else {
          out.push(`SP2-0158: unknown SHOW option "${option}"`);
        }
        break;
      }
    }

    await ctx.io.stdout.write(out.join('\n') + '\n');
    return EXIT_OK;
  }
}
