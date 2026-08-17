import type { CliSession } from './CliSession';
import type { CommandTable } from './CommandTable';
import { parseCommand } from './CommandParser';
import { complete, type CompletionResult, type CompletionTrigger } from './CompletionEngine';

export const IOS_INVALID_INPUT = '% Invalid input detected at \'^\' marker.';
export const IOS_INCOMPLETE = '% Incomplete command.';

export function iosAmbiguous(token: string): string {
  return `% Ambiguous command:  "${token}"`;
}

export class CliEngine {
  constructor(private readonly table: CommandTable) {}

  async execute(input: string, session: CliSession): Promise<string> {
    const parsed = parseCommand(this.table, input, session);

    switch (parsed.status) {
      case 'empty': return '';
      case 'ambiguous': return iosAmbiguous(parsed.token);
      case 'incomplete': return IOS_INCOMPLETE;
      case 'invalid': return IOS_INVALID_INPUT;
      case 'ok': return parsed.spec.run(session, parsed.args);
    }
  }

  complete(input: string, session: CliSession, trigger: CompletionTrigger): CompletionResult {
    return complete(this.table, input, session, trigger);
  }

  commandTable(): CommandTable { return this.table; }
}
