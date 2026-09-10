export interface FormatSpecContext {
  readonly dbName:         string;
  readonly dbId:           number;
  readonly setNumber:      number;
  readonly pieceNumber:    number;
  readonly copyNumber:     number;
  readonly logSequence:    number;
  readonly at:             Date;
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

export function resolveFormatSpec(format: string, ctx: FormatSpecContext): string {
  const u = shortName(ctx);
  return format.replace(/%[a-zA-Z]/g, (token) => {
    switch (token) {
      case '%d': return ctx.dbName;
      case '%n': return paddedDbName(ctx.dbName);
      case '%I': return String(ctx.dbId);
      case '%T': return compactDate(ctx.at);
      case '%t': return backupSetTimestamp(ctx.at);
      case '%s': return String(ctx.setNumber);
      case '%p': return String(ctx.pieceNumber);
      case '%c': return String(ctx.copyNumber);
      case '%e': return String(ctx.logSequence);
      case '%u': return u;
      case '%U': return `${u}_${ctx.pieceNumber}_${ctx.copyNumber}`;
      case '%F': return autobackupName(ctx.dbId, ctx.at, ctx.setNumber);
      default:   return token;
    }
  });
}
