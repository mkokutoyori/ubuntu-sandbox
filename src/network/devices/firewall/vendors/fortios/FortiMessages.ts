export const FORTI_COMMAND_FAIL = 'Command fail. Return code -61';
export const FORTI_UNKNOWN_ACTION = 'Unknown action 0';

export const FORTI_NOT_FOUND = 'entry not found in datasource';
export const FORTI_DUPLICATE = 'duplicate name';
export const FORTI_IN_USE = 'Cannot delete entry: it is used by other entries';
export const FORTI_PERMISSION = 'Permission denied';
export const FORTI_CONFIRM = 'Do you want to continue? (y/n)';

export const HINT_PREFIX = 'NOTE:';

export interface FortiFailure {
  readonly text: string;
  readonly hint?: string;
}

let hintsEnabled = true;

export function setHintsEnabled(enabled: boolean): void {
  hintsEnabled = enabled;
}

export function hintsAreEnabled(): boolean {
  return hintsEnabled;
}

export function renderFailure(failure: FortiFailure): string {
  if (!hintsEnabled || failure.hint === undefined) return failure.text;
  return `${failure.text}\n${HINT_PREFIX} ${failure.hint}`;
}

function fail(text: string, hint?: string): string {
  return renderFailure({ text, hint });
}

export const FortiMessages = {
  commandFail(hint?: string): string {
    return fail(FORTI_COMMAND_FAIL, hint);
  },

  unknownCommand(verb: string): string {
    return fail(
      `${FORTI_UNKNOWN_ACTION}\n${FORTI_COMMAND_FAIL}`,
      `unknown command "${verb}". Type ? for the list.`,
    );
  },

  parseError(word: string, hint?: string): string {
    return fail(`command parse error before '${word}'\n${FORTI_COMMAND_FAIL}`, hint);
  },

  valueError(value: string, hint?: string): string {
    return fail(`value parse error before '${value}'\n${FORTI_COMMAND_FAIL}`, hint);
  },

  unknownPath(path: string, verb = 'config'): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `unknown configuration path "${path}". Type \`${verb} ?\` for the list of branches.`,
    );
  },

  unknownAction(what: string): string {
    return fail(
      `${FORTI_UNKNOWN_ACTION}\n${FORTI_COMMAND_FAIL}`,
      `unknown action "${what}". Type \`execute ?\` for the list.`,
    );
  },

  unknownAttribute(attribute: string, path: string): string {
    return this.parseError(
      attribute,
      `unknown attribute "${attribute}" under \`config ${path}\`. `
      + 'Type `set ?` for the list.',
    );
  },

  unimplemented(attribute: string, reason: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `\`set ${attribute}\` exists on a real FortiGate; ${reason}`,
    );
  },

  needsConsole(action: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `\`execute ${action}\` asks for a password, so it only runs from an `
      + 'interactive console; this invocation has no terminal to prompt on.',
    );
  },

  noPermission(path: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `you do not have permission to change \`${path}\`; this access profile `
      + 'grants read access only to that group of settings.',
    );
  },

  unimplementedValue(attribute: string, value: string, reason: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `\`set ${attribute} ${value}\` exists on a real FortiGate; ${reason}`,
    );
  },

  unimplementedPath(path: string, reason: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `\`config ${path}\` exists on a real FortiGate; ${reason}`,
    );
  },

  needsEdit(path: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `"${path}" is a table: use \`edit <key>\` before setting a value.`,
    );
  },

  notATable(path: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `"${path}" is a single object: \`edit\` has no meaning here, `
      + 'set the values directly.',
    );
  },

  setOutside(table: { spec: { path: readonly string[] } } | undefined): string {
    if (table) return this.needsEdit(table.spec.path.join(' '));
    return fail(
      FORTI_COMMAND_FAIL,
      '`set` only applies to an object opened with `config` then `edit`.',
    );
  },

  outsideObject(verb: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `\`${verb}\` only applies to an object opened with \`edit\`.`,
    );
  },

  outsideTable(verb: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `\`${verb}\` only applies inside a table opened with \`config\`.`,
    );
  },

  notOrdered(verb: string, path: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `table "${path}" is not ordered; \`${verb}\` has no meaning here.`,
    );
  },

  notMultiValue(verb: string, attribute: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `"${attribute}" holds a single value; \`${verb}\` only applies to a list.`,
    );
  },

  unknownReference(attribute: string, value: string, target: string): string {
    return fail(
      `${FORTI_NOT_FOUND}\n${FORTI_COMMAND_FAIL}`,
      `"${value}" does not exist in \`${target}\`; `
      + `\`set ${attribute}\` references a declared object.`,
    );
  },

  duplicate(key: string): string {
    return fail(`${FORTI_DUPLICATE}\n${FORTI_COMMAND_FAIL}`, `"${key}" already exists.`);
  },

  unknownKey(key: string): string {
    return fail(`${FORTI_NOT_FOUND}\n${FORTI_COMMAND_FAIL}`, `"${key}" does not exist.`);
  },

  readOnly(attribute: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `"${attribute}" is read-only; the system sets it itself.`,
    );
  },

  incomplete(what: string): string {
    return this.parseError('', `${what} is missing.`);
  },

  ambiguous(word: string, candidates: readonly string[]): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `"${word}" is ambiguous: ${candidates.join(', ')}.`,
    );
  },

  noSaveNeeded(): string {
    return fail(
      FORTI_COMMAND_FAIL,
      'FortiOS saves the configuration automatically on every `end`; '
      + 'there is no save command to type.',
    );
  },
};
