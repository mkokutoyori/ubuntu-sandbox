export const NANO_FLAGS = [
  'afterends', 'atblanks', 'autoindent', 'backup', 'boldtext', 'bookstyle', 'breaklonglines',
  'casesensitive', 'constantshow', 'cutfromcursor', 'emptyline', 'historylog', 'ignorercfiles',
  'indicator', 'insecurebackup', 'jumpyscrolling', 'linenumbers', 'locking', 'minibar',
  'mouse', 'multibuffer', 'noconvert', 'nohelp', 'nonewlines', 'noread', 'positionlog',
  'preserve', 'quickblank', 'rawsequences', 'rebinddelete', 'regexp', 'restricted', 'saveonexit',
  'showcursor', 'smarthome', 'softwrap', 'stateflags', 'tabstospaces', 'trimblanks', 'unix',
  'view', 'wordbounds', 'zap', 'zero',
] as const;

export type NanoFlag = typeof NANO_FLAGS[number];

export const DEFAULT_TABSIZE = 8;

export interface NanoSettings extends Readonly<Record<NanoFlag, boolean>> {
  readonly tabsize: number;
  readonly fill: number | null;
  readonly guidestripe: number | null;
  readonly quotestr: string | null;
  readonly wordchars: string | null;
  readonly brackets: string | null;
  readonly punct: string | null;
  readonly matchbrackets: string | null;
  readonly whitespace: string | null;
  readonly backupdir: string | null;
  readonly operatingdir: string | null;
  readonly speller: string | null;
  readonly syntax: string | null;
  readonly rcfile: string | null;
}

export function defaultNanoSettings(overrides: Partial<NanoSettings> = {}): NanoSettings {
  const flags = Object.fromEntries(NANO_FLAGS.map((flag) => [flag, false])) as Record<NanoFlag, boolean>;
  return {
    ...flags,
    tabsize: DEFAULT_TABSIZE,
    fill: null,
    guidestripe: null,
    quotestr: null,
    wordchars: null,
    brackets: null,
    punct: null,
    matchbrackets: null,
    whitespace: null,
    backupdir: null,
    operatingdir: null,
    speller: null,
    syntax: null,
    rcfile: null,
    ...overrides,
  };
}
