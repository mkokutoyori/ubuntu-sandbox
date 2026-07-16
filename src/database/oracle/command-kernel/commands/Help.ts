import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

const HELP_TEXT = [
  '',
  'HELP',
  '----',
  ' @             Execute a script file',
  ' COLUMN        Define a column format',
  ' CONNECT       Connect to a database',
  ' DEFINE        Define a substitution variable',
  ' DESCRIBE      Describe an object',
  ' EDIT          Edit the SQL buffer',
  ' EXIT          Exit SQL*Plus',
  ' HOST          Execute a host operating system command',
  ' PRINT         Display the value of a bind variable',
  ' PROMPT        Display text to the screen',
  ' QUIT          Exit SQL*Plus',
  ' SET           Set a SQL*Plus system variable',
  ' SHOW          Show a SQL*Plus system variable',
  ' SPOOL         Store query results in a file',
  ' STARTUP       Start an Oracle instance',
  ' SHUTDOWN      Shut down an Oracle instance',
  ' VARIABLE      Declare a bind variable',
  '',
];

/** HELP / HELP INDEX — index statique des commandes SQL*Plus. */
export class SqlPlusHelpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'HELP',
    summary: 'Affiche la liste des commandes SQL*Plus',
    usage: 'HELP [INDEX]',
    args: [
      { name: 'index', type: 'string', required: false, description: '"INDEX" (seule forme acceptée)' },
    ],
    options: [],
    privileges: ANY,
    category: 'sqlplus',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stdout.write(HELP_TEXT.join('\n') + '\n');
    return EXIT_OK;
  }
}
