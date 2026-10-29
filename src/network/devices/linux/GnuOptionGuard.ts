import { getoptDiagnostic, shortOptions, type LongOption } from './commands/Getopt';

export interface GnuOptionSet {
  readonly optstring: string;
  readonly long: readonly LongOption[];
  readonly operands: boolean;
  readonly usage?: string;
  readonly failureStatus?: number;
  readonly program?: string;
  readonly trailer?: string;
}

const flag = (name: string, letter = ''): LongOption => ({ name, letter, takesArgument: false });
const valued = (name: string, letter = ''): LongOption => ({ name, letter, takesArgument: true });
const optional = (name: string, letter = ''): LongOption => ({ name, letter, takesArgument: false, optionalArgument: true });
const HELP_VERSION: readonly LongOption[] = [flag('help'), flag('version')];


const GREP_USAGE = 'Usage: grep [OPTION]... PATTERNS [FILE]...';

const GREP_OPTIONS: GnuOptionSet = {
  optstring: 'EFGPe:f:iyvwxcLlm:oqsbHhnTZzaIrRUVA:B:C:d:D:u0123456789',
  long: [
    flag('extended-regexp', 'E'), flag('fixed-strings', 'F'), flag('basic-regexp', 'G'), flag('perl-regexp', 'P'),
    valued('regexp', 'e'), valued('file', 'f'), flag('ignore-case', 'i'), flag('no-ignore-case'), flag('invert-match', 'v'),
    flag('word-regexp', 'w'), flag('line-regexp', 'x'), flag('count', 'c'), optional('color'), optional('colour'),
    flag('files-without-match', 'L'), flag('files-with-matches', 'l'), valued('max-count', 'm'),
    flag('only-matching', 'o'), flag('quiet', 'q'), flag('silent', 'q'), flag('no-messages', 's'),
    flag('byte-offset', 'b'), flag('with-filename', 'H'), flag('no-filename', 'h'), valued('label'),
    flag('line-number', 'n'), flag('initial-tab', 'T'), flag('null', 'Z'), flag('null-data', 'z'), flag('text', 'a'),
    valued('binary-files'), valued('devices', 'D'), valued('directories', 'd'), valued('exclude'),
    valued('exclude-from'), valued('exclude-dir'), valued('include'), flag('recursive', 'r'),
    flag('dereference-recursive', 'R'), flag('line-buffered'), flag('unix-byte-offsets', 'u'), flag('binary', 'U'),
    valued('after-context', 'A'), valued('before-context', 'B'), valued('context', 'C'), flag('help'),
    flag('version', 'V'),
  ],
  operands: true,
  usage: GREP_USAGE,
  failureStatus: 2,
  program: 'grep',
};


const DIFF_OPTIONS: GnuOptionSet = {
  optstring: 'abBcC:dD:eEfF:hiI:lL:nNpqrsS:tTuU:vwW:x:X:yZ0123456789',
  long: [
    flag('normal'), flag('brief', 'q'), flag('report-identical-files', 's'), optional('context', 'c'),
    optional('unified', 'u'), flag('ed', 'e'), flag('rcs', 'n'), flag('side-by-side', 'y'), valued('width', 'W'),
    flag('left-column'), flag('suppress-common-lines'), flag('show-c-function', 'p'), valued('show-function-line', 'F'),
    valued('label', 'L'), flag('expand-tabs', 't'), flag('initial-tab', 'T'), valued('tabsize'),
    flag('suppress-blank-empty'), flag('paginate', 'l'), flag('recursive', 'r'), flag('no-dereference'),
    flag('new-file', 'N'), flag('unidirectional-new-file'), flag('ignore-file-name-case'),
    flag('no-ignore-file-name-case'), valued('exclude', 'x'), valued('exclude-from', 'X'), valued('starting-file', 'S'),
    valued('from-file'), valued('to-file'), flag('ignore-case', 'i'), flag('ignore-tab-expansion', 'E'),
    flag('ignore-trailing-space', 'Z'), flag('ignore-space-change', 'b'), flag('ignore-all-space', 'w'),
    flag('ignore-blank-lines', 'B'), valued('ignore-matching-lines', 'I'), flag('text', 'a'), flag('strip-trailing-cr'),
    valued('ifdef', 'D'), valued('line-format'), flag('minimal', 'd'), valued('horizon-lines'),
    flag('speed-large-files'), optional('color'), valued('palette'), flag('help'), flag('version', 'v'),
  ],
  operands: true,
  failureStatus: 2,
  trailer: "diff: Try 'diff --help' for more information.",
};


const SYSTEMD_COMMON: readonly LongOption[] = [
  flag('help', 'h'), flag('version'), valued('host', 'H'), valued('machine', 'M'), flag('no-pager'),
  flag('no-ask-password'), flag('no-legend'), flag('legend'),
];

const SYSTEMCTL_OPTIONS: GnuOptionSet = {
  optstring: 'ht:p:alqfs:n:o:riH:M:T',
  long: [
    ...SYSTEMD_COMMON, flag('system'), flag('user'), flag('global'), valued('type', 't'), valued('state'),
    valued('property', 'p'), flag('all', 'a'), flag('failed'), flag('full', 'l'), flag('show-types'), flag('value'),
    flag('recursive', 'r'), flag('reverse'), flag('after'), flag('before'), flag('with-dependencies'),
    valued('job-mode'), flag('show-transaction', 'T'), flag('fail'), flag('irreversible'), flag('ignore-dependencies'),
    flag('ignore-inhibitors', 'i'), flag('dry-run'), flag('quiet', 'q'), flag('no-block'), flag('wait'),
    flag('no-wall'), flag('no-reload'), flag('no-warn'), flag('now'), flag('force', 'f'), valued('root'),
    flag('runtime'), valued('preset-mode'), valued('lines', 'n'), valued('output', 'o'), flag('plain'),
    flag('firmware-setup'), optional('boot-loader-menu'), valued('boot-loader-entry'), valued('signal', 's'),
    valued('kill-who'), valued('kill-whom'), valued('kill-mode'), valued('check-inhibitors'), valued('message'),
    valued('timestamp'), flag('mkdir'), flag('marked'), flag('stdin'), flag('read-only'), valued('what'),
  ],
  operands: true,
};

const LOGINCTL_OPTIONS: GnuOptionSet = {
  optstring: 'hp:alno:s:H:M:',
  long: [
    ...SYSTEMD_COMMON, valued('property', 'p'), flag('all', 'a'), flag('full', 'l'), valued('lines', 'n'),
    valued('output', 'o'), valued('signal', 's'), valued('kill-who'), valued('kill-whom'), flag('value'),
    flag('no-wall'), valued('what'),
  ],
  operands: true,
};

const HOSTNAMECTL_OPTIONS: GnuOptionSet = {
  optstring: 'hH:M:',
  long: [...SYSTEMD_COMMON, flag('transient'), flag('static'), flag('pretty'), flag('json')],
  operands: true,
};

const TIMEDATECTL_OPTIONS: GnuOptionSet = {
  optstring: 'hH:M:p:a',
  long: [
    ...SYSTEMD_COMMON, flag('adjust-system-clock'), flag('monitor'), valued('property', 'p'), flag('all', 'a'),
    flag('value'),
  ],
  operands: true,
};

export const GNU_OPTION_SETS: Readonly<Record<string, GnuOptionSet>> = {
  systemctl: SYSTEMCTL_OPTIONS,
  loginctl: LOGINCTL_OPTIONS,
  hostnamectl: HOSTNAMECTL_OPTIONS,
  timedatectl: TIMEDATECTL_OPTIONS,
  diff: DIFF_OPTIONS,
  grep: GREP_OPTIONS,
  egrep: GREP_OPTIONS,
  fgrep: GREP_OPTIONS,
  whoami: { optstring: '', long: HELP_VERSION, operands: false },
  groups: { optstring: '', long: HELP_VERSION, operands: true },
  tty: { optstring: 's', long: [flag('silent', 's'), flag('quiet', 's'), ...HELP_VERSION], operands: false },
  nproc: { optstring: '', long: [flag('all'), valued('ignore'), ...HELP_VERSION], operands: false },
  free: {
    optstring: 'bkmghHlLtvVwc:s:',
    long: [
      flag('bytes', 'b'), flag('kilo'), flag('mega'), flag('giga'), flag('tera'), flag('peta'),
      flag('kibi', 'k'), flag('mebi', 'm'), flag('gibi', 'g'), flag('tebi'), flag('pebi'),
      flag('human', 'h'), flag('si'), flag('lohi', 'l'), flag('total', 't'), flag('wide', 'w'),
      valued('seconds', 's'), valued('count', 'c'), flag('help'), flag('version', 'V'),
    ],
    operands: false,
  },
  env: {
    optstring: '+i0u:C:S:vh',
    long: [
      flag('ignore-environment', 'i'), flag('null', '0'), valued('unset', 'u'), valued('chdir', 'C'),
      valued('split-string', 'S'), flag('debug', 'v'), ...HELP_VERSION,
    ],
    operands: true,
  },
  ls: {
    optstring: 'aAbBcCdDfFgGhHI:iklLmnNopqQrRsStT:uUvw:xXZ1',
    long: [
      flag('all', 'a'), flag('almost-all', 'A'), flag('author'), flag('escape', 'b'),
      valued('block-size'), flag('ignore-backups', 'B'), optional('color'), optional('classify', 'F'),
      flag('file-type'), valued('format'), flag('full-time'), flag('group-directories-first'),
      flag('no-group', 'G'), flag('human-readable', 'h'), flag('si'),
      flag('dereference-command-line', 'H'), flag('dereference-command-line-symlink-to-dir'),
      valued('hide'), optional('hyperlink'), valued('indicator-style'), flag('inode', 'i'),
      valued('ignore', 'I'), flag('kibibytes', 'k'), flag('dereference', 'L'),
      flag('numeric-uid-gid', 'n'), flag('literal', 'N'), flag('hide-control-chars', 'q'),
      flag('show-control-chars'), flag('quote-name', 'Q'), valued('quoting-style'),
      flag('reverse', 'r'), flag('recursive', 'R'), flag('size', 's'), valued('sort'), valued('time'),
      valued('time-style'), valued('tabsize', 'T'), valued('width', 'w'), flag('context', 'Z'),
      flag('zero'), flag('directory', 'd'), flag('dired', 'D'), ...HELP_VERSION,
    ],
    operands: true,
  },
  head: {
    optstring: 'c:n:qvz0123456789',
    long: [
      valued('bytes', 'c'), valued('lines', 'n'), flag('quiet', 'q'), flag('silent', 'q'),
      flag('verbose', 'v'), flag('zero-terminated', 'z'), ...HELP_VERSION,
    ],
    operands: true,
  },
  sort: {
    optstring: 'bcCdfghiMnrRsuVzmk:t:o:S:T:',
    long: [
      flag('ignore-leading-blanks', 'b'), optional('check', 'c'), flag('check-silent', 'C'),
      flag('dictionary-order', 'd'), flag('ignore-case', 'f'), flag('general-numeric-sort', 'g'),
      flag('human-numeric-sort', 'h'), flag('ignore-nonprinting', 'i'), flag('month-sort', 'M'),
      flag('numeric-sort', 'n'), optional('random-sort', 'R'), flag('reverse', 'r'), flag('stable', 's'),
      flag('unique', 'u'), flag('version-sort', 'V'), flag('zero-terminated', 'z'), flag('merge', 'm'),
      flag('debug'), valued('batch-size'), valued('buffer-size', 'S'), valued('compress-program'),
      valued('files0-from'), valued('key', 'k'), valued('field-separator', 't'), valued('output', 'o'),
      valued('parallel'), valued('random-source'), valued('temporary-directory', 'T'), valued('sort'),
      ...HELP_VERSION,
    ],
    operands: true,
  },
  uniq: {
    optstring: 'cdDf:iuzs:w:',
    long: [
      flag('count', 'c'), flag('repeated', 'd'), optional('all-repeated', 'D'), valued('skip-fields', 'f'),
      optional('group'), flag('ignore-case', 'i'), valued('skip-chars', 's'), flag('unique', 'u'),
      flag('zero-terminated', 'z'), valued('check-chars', 'w'), ...HELP_VERSION,
    ],
    operands: true,
  },
  cut: {
    optstring: 'b:c:d:f:nsz',
    long: [
      valued('bytes', 'b'), valued('characters', 'c'), valued('delimiter', 'd'), valued('fields', 'f'),
      flag('complement'), flag('only-delimited', 's'), valued('output-delimiter'),
      flag('zero-terminated', 'z'), ...HELP_VERSION,
    ],
    operands: true,
  },
  tr: {
    optstring: 'cCdst',
    long: [
      flag('complement', 'c'), flag('delete', 'd'), flag('squeeze-repeats', 's'),
      flag('truncate-set1', 't'), ...HELP_VERSION,
    ],
    operands: true,
  },
  date: {
    optstring: 'd:f:I::r:Rs:uV',
    long: [
      valued('date', 'd'), flag('debug'), valued('file', 'f'), optional('iso-8601', 'I'),
      valued('reference', 'r'), flag('rfc-email', 'R'), valued('rfc-3339'), valued('set', 's'),
      flag('utc', 'u'), flag('universal', 'u'), flag('resolution'), ...HELP_VERSION,
    ],
    operands: true,
  },
  mkdir: {
    optstring: 'm:pvZ',
    long: [valued('mode', 'm'), flag('parents', 'p'), flag('verbose', 'v'), valued('context'), ...HELP_VERSION],
    operands: true,
  },
  rmdir: {
    optstring: 'pv',
    long: [flag('ignore-fail-on-non-empty'), flag('parents', 'p'), flag('verbose', 'v'), ...HELP_VERSION],
    operands: true,
  },
  rm: {
    optstring: 'fiIrRdv',
    long: [
      flag('force', 'f'), flag('interactive'), flag('one-file-system'), flag('no-preserve-root'),
      flag('preserve-root'), flag('recursive', 'r'), flag('dir', 'd'), flag('verbose', 'v'), ...HELP_VERSION,
    ],
    operands: true,
  },
  cat: {
    optstring: 'AbeEnstTuv',
    long: [
      flag('show-all', 'A'), flag('number-nonblank', 'b'), flag('show-ends', 'E'), flag('number', 'n'),
      flag('squeeze-blank', 's'), flag('show-tabs', 'T'), flag('show-nonprinting', 'v'), ...HELP_VERSION,
    ],
    operands: true,
  },
  wc: {
    optstring: 'cmlLw',
    long: [
      flag('bytes', 'c'), flag('chars', 'm'), flag('lines', 'l'), valued('files0-from'),
      flag('max-line-length', 'L'), flag('words', 'w'), valued('total'), ...HELP_VERSION,
    ],
    operands: true,
  },
  tac: {
    optstring: 'brs:',
    long: [flag('before', 'b'), flag('regex', 'r'), valued('separator', 's'), ...HELP_VERSION],
    operands: true,
  },
  tee: {
    optstring: 'aip',
    long: [flag('append', 'a'), flag('ignore-interrupts', 'i'), valued('output-error'), ...HELP_VERSION],
    operands: true,
  },
  basename: {
    optstring: 'as:z',
    long: [flag('multiple', 'a'), valued('suffix', 's'), flag('zero', 'z'), ...HELP_VERSION],
    operands: true,
  },
  dirname: { optstring: 'z', long: [flag('zero', 'z'), ...HELP_VERSION], operands: true },
  printenv: { optstring: '0', long: [flag('null', '0'), ...HELP_VERSION], operands: true },
  md5sum: {
    optstring: 'bctwz',
    long: [
      flag('binary', 'b'), flag('check', 'c'), flag('tag'), flag('text', 't'), flag('zero', 'z'),
      flag('ignore-missing'), flag('quiet'), flag('status'), flag('strict'), flag('warn', 'w'), ...HELP_VERSION,
    ],
    operands: true,
  },
  sha1sum: {
    optstring: 'bctwz',
    long: [
      flag('binary', 'b'), flag('check', 'c'), flag('tag'), flag('text', 't'), flag('zero', 'z'),
      flag('ignore-missing'), flag('quiet'), flag('status'), flag('strict'), flag('warn', 'w'), ...HELP_VERSION,
    ],
    operands: true,
  },
  sha224sum: {
    optstring: 'bctwz',
    long: [
      flag('binary', 'b'), flag('check', 'c'), flag('tag'), flag('text', 't'), flag('zero', 'z'),
      flag('ignore-missing'), flag('quiet'), flag('status'), flag('strict'), flag('warn', 'w'), ...HELP_VERSION,
    ],
    operands: true,
  },
  sha256sum: {
    optstring: 'bctwz',
    long: [
      flag('binary', 'b'), flag('check', 'c'), flag('tag'), flag('text', 't'), flag('zero', 'z'),
      flag('ignore-missing'), flag('quiet'), flag('status'), flag('strict'), flag('warn', 'w'), ...HELP_VERSION,
    ],
    operands: true,
  },
  sha384sum: {
    optstring: 'bctwz',
    long: [
      flag('binary', 'b'), flag('check', 'c'), flag('tag'), flag('text', 't'), flag('zero', 'z'),
      flag('ignore-missing'), flag('quiet'), flag('status'), flag('strict'), flag('warn', 'w'), ...HELP_VERSION,
    ],
    operands: true,
  },
  sha512sum: {
    optstring: 'bctwz',
    long: [
      flag('binary', 'b'), flag('check', 'c'), flag('tag'), flag('text', 't'), flag('zero', 'z'),
      flag('ignore-missing'), flag('quiet'), flag('status'), flag('strict'), flag('warn', 'w'), ...HELP_VERSION,
    ],
    operands: true,
  },
  nl: {
    optstring: 'b:d:f:h:i:l:n:pv:w:s:',
    long: [
      valued('body-numbering', 'b'), valued('section-delimiter', 'd'), valued('footer-numbering', 'f'),
      valued('header-numbering', 'h'), valued('line-increment', 'i'), valued('join-blank-lines', 'l'),
      valued('number-format', 'n'), flag('no-renumber', 'p'), valued('number-separator', 's'),
      valued('starting-line-number', 'v'), valued('number-width', 'w'), ...HELP_VERSION,
    ],
    operands: true,
  },
  fold: {
    optstring: 'bsw:',
    long: [flag('bytes', 'b'), flag('spaces', 's'), valued('width', 'w'), ...HELP_VERSION],
    operands: true,
  },
  paste: {
    optstring: 'd:sz',
    long: [valued('delimiters', 'd'), flag('serial', 's'), flag('zero-terminated', 'z'), ...HELP_VERSION],
    operands: true,
  },
  comm: {
    optstring: '123z',
    long: [
      flag('check-order'), flag('nocheck-order'), valued('output-delimiter'), flag('total'),
      flag('zero-terminated', 'z'), ...HELP_VERSION,
    ],
    operands: true,
  },
  base64: {
    optstring: 'diw:',
    long: [flag('decode', 'd'), flag('ignore-garbage', 'i'), valued('wrap', 'w'), ...HELP_VERSION],
    operands: true,
  },
  du: {
    optstring: 'abcd:hkms',
    long: [
      flag('all', 'a'), flag('bytes', 'b'), flag('total', 'c'), valued('max-depth', 'd'),
      flag('human-readable', 'h'), flag('summarize', 's'), ...HELP_VERSION,
    ],
    operands: true,
  },
  rev: { optstring: '0hV', long: [flag('zero', '0'), flag('help', 'h'), flag('version', 'V')], operands: true },
  id: {
    optstring: 'agGnruzZ',
    long: [
      flag('context', 'Z'), flag('group', 'g'), flag('groups', 'G'), flag('name', 'n'), flag('real', 'r'),
      flag('user', 'u'), flag('zero', 'z'), ...HELP_VERSION,
    ],
    operands: true,
  },
  chown: {
    optstring: 'cfhHLPRv',
    long: [
      flag('changes', 'c'), flag('dereference'), flag('no-dereference', 'h'), valued('from'), flag('no-preserve-root'),
      flag('preserve-root'), flag('quiet', 'f'), flag('silent', 'f'), valued('reference'), flag('recursive', 'R'),
      flag('verbose', 'v'), ...HELP_VERSION,
    ],
    operands: true,
  },
  sleep: { optstring: '', long: [...HELP_VERSION], operands: true },
  readlink: {
    optstring: 'efmnqsvz',
    long: [
      flag('canonicalize-existing', 'e'), flag('canonicalize', 'f'), flag('canonicalize-missing', 'm'),
      flag('no-newline', 'n'), flag('quiet', 'q'), flag('silent', 's'), flag('verbose', 'v'), flag('zero', 'z'), ...HELP_VERSION,
    ],
    operands: true,
  },
  realpath: {
    optstring: 'emLPqsz',
    long: [
      flag('canonicalize-existing', 'e'), flag('canonicalize-missing', 'm'), flag('logical', 'L'), flag('physical', 'P'),
      flag('quiet', 'q'), valued('relative-to'), valued('relative-base'), flag('strip', 's'), flag('no-symlinks', 's'),
      flag('zero', 'z'), ...HELP_VERSION,
    ],
    operands: true,
  },
  split: {
    optstring: 'a:b:C:del:n:t:ux',
    long: [
      valued('suffix-length', 'a'), valued('bytes', 'b'), valued('line-bytes', 'C'), optional('numeric-suffixes', 'd'),
      optional('hex-suffixes', 'x'), valued('additional-suffix'), flag('elide-empty-files', 'e'), valued('filter'),
      valued('lines', 'l'), valued('number', 'n'), valued('separator', 't'), flag('unbuffered', 'u'),
      flag('verbose'), ...HELP_VERSION,
    ],
    operands: true,
  },
  uname: {
    optstring: 'asnrvmpio',
    long: [
      flag('all', 'a'), flag('kernel-name', 's'), flag('nodename', 'n'), flag('kernel-release', 'r'),
      flag('kernel-version', 'v'), flag('machine', 'm'), flag('processor', 'p'),
      flag('hardware-platform', 'i'), flag('operating-system', 'o'), ...HELP_VERSION,
    ],
    operands: false,
  },
};

export interface OptionRefusal {
  readonly output: string;
  readonly exitCode: number;
}

export function refuseUnknownGnuOption(command: string, args: readonly string[]): OptionRefusal | null {
  const set = GNU_OPTION_SETS[command];
  if (!set) return null;
  const program = set.program ?? command;
  const trailer = set.trailer ?? `Try '${program} --help' for more information.`;
  for (const item of shortOptions(args, set.optstring, set.long)) {
    if (item.kind === 'operand' && !set.operands) {
      return { output: `${command}: extra operand '${item.value}'\n${trailer}`, exitCode: set.failureStatus ?? 1 };
    }
    if (item.kind === 'invalid' || item.kind === 'unrecognized'
      || item.kind === 'missing-argument' || item.kind === 'needless-argument') {
      const lines = [getoptDiagnostic(program, item), ...(set.usage === undefined ? [] : [set.usage]), trailer];
      return { output: lines.join('\n'), exitCode: set.failureStatus ?? 1 };
    }
  }
  return null;
}
