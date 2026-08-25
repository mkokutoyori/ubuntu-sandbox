import type { CliSession } from './CliSession';
import type { CommandSpec, CommandTable } from './CommandTable';
import { parseCommand } from './CommandParser';
import { complete, type CompletionResult, type CompletionTrigger } from './CompletionEngine';

export const IOS_INVALID_INPUT = '% Invalid input detected at \'^\' marker.';
export const IOS_INCOMPLETE = '% Incomplete command.';

export function iosAmbiguous(token: string): string {
  return `% Ambiguous command:  "${token}"`;
}

export function applyTransition(
  spec: CommandSpec, args: Readonly<Record<string, string>>, session: CliSession,
): void {
  if (spec.enters === undefined) return;

  session.enter(spec.enters);
  if (spec.contextField && spec.contextFrom) {
    session.fields[spec.contextField] = args[spec.contextFrom];
  }
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
      case 'ok': {
        const handler = parsed.negated && parsed.spec.undo
          ? parsed.spec.undo
          : parsed.spec.run;
        const output = await handler(session, parsed.args);
        if (!parsed.negated) applyTransition(parsed.spec, parsed.args, session);
        return output;
      }
    }
  }

  complete(input: string, session: CliSession, trigger: CompletionTrigger): CompletionResult {
    return complete(this.table, input, session, trigger);
  }

  commandTable(): CommandTable { return this.table; }
}
