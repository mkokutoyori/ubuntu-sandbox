import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { MetadataObjectType } from '../../metadata/MetadataExtractor';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

const OBJECT_TYPES = /^(TABLE|VIEW|INDEX|SEQUENCE|SYNONYM|TRIGGER|USER|ROLE|PROCEDURE|FUNCTION|PACKAGE)$/i;

/**
 * `DDL [type] [schema.]objet` — raccourci `DBMS_METADATA.GET_DDL` : sans
 * argument, affiche l'usage ; sinon reconstruit le DDL de l'objet (défaut
 * `TABLE`, schéma par défaut l'utilisateur courant). Lecture pure via
 * `machine.oracle.objectDdl` (partagée avec le legacy `handleDdlCommand`).
 */
export class SqlPlusDdlCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'DDL',
    summary: 'Raccourci DBMS_METADATA.GET_DDL',
    usage: 'DDL [type] [schema.]objet',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '[type_objet] [schema.]identifiant' },
    ],
    options: [],
    privileges: ANY,
    category: 'sqlplus',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const oracle = ctx.machine.oracle!;
    const rest = (ctx.args.get<string[] | undefined>('rest') ?? []).join(' ').replace(/;\s*$/, '').trim();

    if (!rest) {
      await ctx.io.stdout.write([
        'Usage: DDL [object_type] [schema.]object_name',
        '  e.g. DDL TABLE HR.EMPLOYEES',
        '       DDL VIEW DBA_USERS',
        '       DDL HR.EMPLOYEES        (defaults to TABLE)',
      ].join('\n') + '\n');
      return EXIT_OK;
    }

    const parts = rest.split(/\s+/);
    let objType: MetadataObjectType = 'TABLE';
    let identifier = parts[0];
    if (parts.length >= 2 && OBJECT_TYPES.test(parts[0])) {
      objType = parts[0].toUpperCase() as MetadataObjectType;
      identifier = parts.slice(1).join(' ');
    }

    const m = identifier.replace(/"/g, '').match(/^(?:([\w$#]+)\.)?([\w$#]+)$/);
    if (!m) {
      await ctx.io.stdout.write(`SP2-0734: cannot parse object identifier "${identifier}"\n`);
      return EXIT_OK;
    }

    const owner = (m[1] ?? oracle.currentUser() ?? 'SYS').toUpperCase();
    const name = m[2].toUpperCase();
    const ddl = oracle.objectDdl(objType, name, owner);
    if (ddl === null) {
      await ctx.io.stdout.write(`ORA-31603: object "${name}" of type ${objType} not found in schema "${owner}"\n`);
      return EXIT_OK;
    }

    await ctx.io.stdout.write(ddl + '\n');
    return EXIT_OK;
  }
}
