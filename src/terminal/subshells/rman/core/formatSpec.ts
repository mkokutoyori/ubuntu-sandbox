export interface FormatSpecContext {
  readonly dbName:         string;
  readonly dbId:           number;
  readonly activationId:   number;
  readonly setNumber:      number;
  readonly pieceNumber:    number;
  readonly copyNumber:     number;
  readonly logSequence:    number;
  readonly logThread:      number;
  readonly at:             Date;
  /** `%f`/`%N` ne valent que pour une COPIE IMAGE, qui porte un seul fichier. */
  readonly fileNumber?:    number;
  readonly tablespace?:    string;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

function compactDate(at: Date): string {
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
}

function backupSetTimestamp(at: Date): string {
  return String(Math.floor(at.getTime() / 1000));
}

function shortName(ctx: FormatSpecContext): string {
  const stamp = Math.floor(ctx.at.getTime() / 1000).toString(36);
  return `${ctx.setNumber.toString(36)}${stamp}`.slice(-8).padStart(8, '0');
}

function paddedDbName(dbName: string): string {
  return dbName.slice(0, 8).padEnd(8, 'x');
}

export function autobackupName(dbId: number, at: Date, sequence: number): string {
  return `c-${dbId}-${compactDate(at)}-${pad(sequence).slice(-2)}`;
}

/**
 * Les specificateurs qu'un FORMAT peut porter, et ce qu'ils valent.
 *
 * `%%` est traite AVANT les autres : il ne designe pas une lettre, et le
 * balayage qui cherche `%<lettre>` le laissait passer tel quel — un
 * operateur qui voulait un `%` litteral en obtenait deux.
 */
export function resolveFormatSpec(format: string, ctx: FormatSpecContext): string {
  const u = shortName(ctx);
  const at = ctx.at;
  return format
    .split('%%')
    .map((morceau) => morceau.replace(/%[a-zA-Z]/g, (token) => {
      switch (token) {
        case '%a': return String(ctx.activationId);
        case '%c': return String(ctx.copyNumber);
        case '%d': return ctx.dbName;
        case '%D': return pad(at.getDate());
        case '%e': return String(ctx.logSequence);
        case '%f': return ctx.fileNumber === undefined ? token : String(ctx.fileNumber);
        case '%F': return autobackupName(ctx.dbId, at, ctx.setNumber);
        case '%h': return String(ctx.logThread);
        case '%I': return String(ctx.dbId);
        case '%M': return pad(at.getMonth() + 1);
        case '%N': return ctx.tablespace ?? token;
        case '%n': return paddedDbName(ctx.dbName);
        case '%p': return String(ctx.pieceNumber);
        case '%s': return String(ctx.setNumber);
        case '%t': return backupSetTimestamp(at);
        case '%T': return compactDate(at);
        case '%u': return u;
        case '%U': return `${u}_${ctx.pieceNumber}_${ctx.copyNumber}`;
        case '%Y': return String(at.getFullYear());
        default:   return token;
      }
    }))
    .join('%');
}
