import type { EntryType } from './PSEventLogProvider';

export interface EventcreateHost {
  readonly logNames: () => string[];
  readonly write: (log: string, source: string, id: number, type: EntryType, description: string) => string;
}

export interface EventcreateResult {
  readonly output: string;
  readonly exitCode: number;
}

const TYPES: Readonly<Record<string, EntryType>> = {
  error: 'Error',
  warning: 'Warning',
  information: 'Information',
  successaudit: 'SuccessAudit',
  failureaudit: 'FailureAudit',
};

const USAGE_HINT = 'Type "EVENTCREATE /?" for usage.';
const DEFAULT_LOG = 'APPLICATION';
const DEFAULT_SOURCE = 'EventCreate';
const MAX_ID = 1000;

const refuse = (message: string): EventcreateResult => ({ output: `${message}\n${USAGE_HINT}`, exitCode: 1 });
const invalidOption = (name: string): EventcreateResult => refuse(`ERROR: Invalid Argument/Option - '${name}'.`);

export function cmdEventcreate(host: EventcreateHost, args: string[]): EventcreateResult {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const name = args[i].toLowerCase();
    if (!['/t', '/id', '/l', '/so', '/d', '/s', '/u', '/p'].includes(name)) return invalidOption(args[i]);
    if (i + 1 >= args.length) return invalidOption(args[i]);
    options.set(name, args[++i]);
  }
  for (const remote of ['/s', '/u', '/p']) {
    if (options.has(remote)) return invalidOption(remote.toUpperCase());
  }
  for (const required of ['/t', '/id', '/d']) {
    if (!options.has(required)) return refuse(`ERROR: Invalid Syntax. '${required.toUpperCase()}' option is required.`);
  }

  const typeText = options.get('/t') as string;
  const type = TYPES[typeText.toLowerCase()];
  if (type === undefined) return invalidOption('/T');
  const idText = options.get('/id') as string;
  const id = /^\d+$/.test(idText) ? Number(idText) : 0;
  if (id < 1 || id > MAX_ID) return invalidOption('/ID');

  const requested = options.get('/l') ?? DEFAULT_LOG;
  const log = host.logNames().find((name) => name.toLowerCase() === requested.toLowerCase());
  if (log === undefined) return invalidOption('/L');
  const source = options.get('/so') ?? DEFAULT_SOURCE;

  const failure = host.write(log, source, id, type, options.get('/d') as string);
  if (failure !== '') return { output: `ERROR: ${failure}`, exitCode: 1 };
  return {
    output: `SUCCESS: An event of type '${typeText}' was created in the '${requested}' log with '${source}' as the source.`,
    exitCode: 0,
  };
}
