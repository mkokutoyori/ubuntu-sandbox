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
      `commande « ${verb} » inconnue. Tapez ? pour la liste.`,
    );
  },

  parseError(word: string, hint?: string): string {
    return fail(`command parse error before '${word}'\n${FORTI_COMMAND_FAIL}`, hint);
  },

  valueError(value: string, hint?: string): string {
    return fail(`value parse error before '${value}'\n${FORTI_COMMAND_FAIL}`, hint);
  },

  unknownPath(path: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `chemin de configuration « ${path} » inconnu. Tapez `
      + '`config ?` pour la liste des branches.',
    );
  },

  unknownAttribute(attribute: string, path: string): string {
    return this.parseError(
      attribute,
      `attribut « ${attribute} » inconnu pour \`config ${path}\`. `
      + 'Tapez `set ?` pour la liste.',
    );
  },

  unimplemented(attribute: string, reason: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `\`set ${attribute}\` existe sur un vrai FortiGate ; ${reason}`,
    );
  },

  unimplementedPath(path: string, reason: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `\`config ${path}\` existe sur un vrai FortiGate ; ${reason}`,
    );
  },

  needsEdit(path: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `\`${path}\` est une table : il faut \`edit <cle>\` avant de poser une valeur.`,
    );
  },

  notATable(path: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `\`${path}\` est un objet unique : \`edit\` n'y a pas de sens, `
      + 'posez directement les valeurs.',
    );
  },

  setOutside(table: { spec: { path: readonly string[] } } | undefined): string {
    if (table) return this.needsEdit(table.spec.path.join(' '));
    return fail(
      FORTI_COMMAND_FAIL,
      '`set` ne s\'emploie que sur un objet ouvert par `config` puis `edit`.',
    );
  },

  outsideObject(verb: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `\`${verb}\` ne s'emploie que sur un objet ouvert par \`edit\`.`,
    );
  },

  outsideTable(verb: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `\`${verb}\` ne s'emploie que dans une table ouverte par \`config\`.`,
    );
  },

  notOrdered(verb: string, path: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `la table « ${path} » n'est pas ordonnee ; \`${verb}\` n'y a pas de sens.`,
    );
  },

  notMultiValue(verb: string, attribute: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `\`${attribute}\` ne porte qu'une valeur ; \`${verb}\` ne s'applique `
      + "qu'a une liste.",
    );
  },

  unknownReference(attribute: string, value: string, target: string): string {
    return fail(
      `${FORTI_NOT_FOUND}\n${FORTI_COMMAND_FAIL}`,
      `« ${value} » n'existe pas dans \`${target}\` ; `
      + `\`set ${attribute}\` reference un objet declare.`,
    );
  },

  duplicate(key: string): string {
    return fail(`${FORTI_DUPLICATE}\n${FORTI_COMMAND_FAIL}`, `« ${key} » existe deja.`);
  },

  unknownKey(key: string): string {
    return fail(`${FORTI_NOT_FOUND}\n${FORTI_COMMAND_FAIL}`, `« ${key} » n'existe pas.`);
  },

  readOnly(attribute: string): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `\`${attribute}\` est en lecture seule ; la machine le pose elle-meme.`,
    );
  },

  incomplete(what: string): string {
    return fail(FORTI_COMMAND_FAIL, `il manque ${what}.`);
  },

  ambiguous(word: string, candidates: readonly string[]): string {
    return fail(
      FORTI_COMMAND_FAIL,
      `« ${word} » est ambigu : ${candidates.join(', ')}.`,
    );
  },

  noSaveNeeded(): string {
    return fail(
      FORTI_COMMAND_FAIL,
      'FortiOS enregistre la configuration automatiquement a chaque `end` ; '
      + "il n'y a pas de commande d'enregistrement a taper.",
    );
  },
};
