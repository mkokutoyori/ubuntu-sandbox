import { applyOutputToggles, defaultOutputOptions, type NetSnmpOutputOptions } from './NetSnmpOutput';
import { netSnmpMibSearchPath } from './NetSnmpOid';

export const NET_SNMP_VERSION = '5.9.1';

export type NetSnmpVersion = 'v1' | 'v2c' | 'v3';

export type NetSnmpLogDestination = 'stderr' | 'stdout' | 'none';

export interface NetSnmpSessionOptions {
  readonly version: NetSnmpVersion;
  readonly community: string | null;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly output: NetSnmpOutputOptions;
  readonly log: NetSnmpLogDestination;
}

export interface NetSnmpApplication {
  readonly name: string;
  readonly operandsUsage: string;
  readonly optionLetters: string;
  readonly applicationUsage: readonly string[];
  applicationOption(letter: string, argument: string, takeNext: () => string | undefined): string | null;
}

export interface NetSnmpOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type NetSnmpParse =
  | {
    readonly kind: 'session';
    readonly options: NetSnmpSessionOptions;
    readonly peername: string;
    readonly operands: readonly string[];
  }
  | { readonly kind: 'finished'; readonly outcome: NetSnmpOutcome };

const COMMON_OPTIONS_WITH_ARGUMENT = new Set('YmMOIPDvrtcZeEnulxXaApTL3s-');
const COMMON_FLAGS = new Set('VhHd');
const MIB_PARSING_TOGGLES = new Set('ucdewWR');
const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_RETRIES = 5;
const INT_MAX = 2147483647;
const LONG_MAX_PLUS_ONE = 2 ** 63;

export function netSnmpUsage(application: NetSnmpApplication, home: string | null): string {
  const tab = '\t\t\t  ';
  const mibDirectories = netSnmpMibSearchPath(home ?? '$HOME');
  return [
    `USAGE: ${application.name} [OPTIONS] AGENT${application.operandsUsage}`,
    '',
    `  Version:  ${NET_SNMP_VERSION}`,
    '  Web:      http://www.net-snmp.org/',
    '  Email:    net-snmp-coders@lists.sourceforge.net',
    '',
    'OPTIONS:',
    '  -h, --help\t\tdisplay this help message',
    '  -H\t\t\tdisplay configuration file directives understood',
    '  -v 1|2c|3\t\tspecifies SNMP version to use',
    '  -V, --version\t\tdisplay package version number',
    'SNMP Version 1 or 2c specific',
    '  -c COMMUNITY\t\tset the community string',
    'SNMP Version 3 specific',
    '  -a PROTOCOL\t\tset authentication protocol (MD5|SHA|SHA-224|SHA-256|SHA-384|SHA-512)',
    '  -A PASSPHRASE\t\tset authentication protocol pass phrase',
    '  -e ENGINE-ID\t\tset security engine ID (e.g. 800000020109840301)',
    '  -E ENGINE-ID\t\tset context engine ID (e.g. 800000020109840301)',
    '  -l LEVEL\t\tset security level (noAuthNoPriv|authNoPriv|authPriv)',
    '  -n CONTEXT\t\tset context name (e.g. bridge1)',
    '  -u USER-NAME\t\tset security name (e.g. bert)',
    '  -x PROTOCOL\t\tset privacy protocol (DES|AES|AES-192|AES-256)',
    '  -X PASSPHRASE\t\tset privacy protocol pass phrase',
    '  -Z BOOTS,TIME\t\tset destination engine boots/time',
    'General communication options',
    '  -r RETRIES\t\tset the number of retries',
    '  -t TIMEOUT\t\tset the request timeout (in seconds)',
    'Debugging',
    '  -d\t\t\tdump input/output packets in hexadecimal',
    '  -D[TOKEN[,...]]\tturn on debugging output for the specified TOKENs',
    '\t\t\t   (ALL gives extremely verbose debugging output)',
    'General options',
    '  -m MIB[:...]\t\tload given list of MIBs (ALL loads everything)',
    '  -M DIR[:...]\t\tlook in given list of directories for MIBs',
    `    (default: ${mibDirectories})`,
    '  -P MIBOPTS\t\tToggle various defaults controlling MIB parsing:',
    `${tab}u:  allow the use of underlines in MIB symbols`,
    `${tab}c:  disallow the use of "--" to terminate comments`,
    `${tab}d:  save the DESCRIPTIONs of the MIB objects`,
    `${tab}e:  disable errors when MIB symbols conflict`,
    `${tab}w:  enable warnings when MIB symbols conflict`,
    `${tab}W:  enable detailed warnings when MIB symbols conflict`,
    `${tab}R:  replace MIB symbols from latest module`,
    '  -O OUTOPTS\t\tToggle various defaults controlling output display:',
    `${tab}0:  print leading 0 for single-digit hex characters`,
    `${tab}a:  print all strings in ascii format`,
    `${tab}b:  do not break OID indexes down`,
    `${tab}e:  print enums numerically`,
    `${tab}E:  escape quotes in string indices`,
    `${tab}f:  print full OIDs on output`,
    `${tab}n:  print OIDs numerically`,
    `${tab}p PRECISION:  display floating point values with specified PRECISION (printf format string)`,
    `${tab}q:  quick print for easier parsing`,
    `${tab}Q:  quick print with equal-signs`,
    `${tab}s:  print only last symbolic element of OID`,
    `${tab}S:  print MIB module-id plus last element`,
    `${tab}t:  print timeticks unparsed as numeric integers`,
    `${tab}T:  print human-readable text along with hex strings`,
    `${tab}u:  print OIDs using UCD-style prefix suppression`,
    `${tab}U:  don't print units`,
    `${tab}v:  print values only (not OID = value)`,
    `${tab}x:  print all strings in hex format`,
    `${tab}X:  extended index format`,
    '  -I INOPTS\t\tToggle various defaults controlling input parsing:',
    `${tab}b:  do best/regex matching to find a MIB node`,
    `${tab}h:  don't apply DISPLAY-HINTs`,
    `${tab}r:  do not check values for range/type legality`,
    `${tab}R:  do random access to OID labels`,
    `${tab}u:  top-level OIDs must have '.' prefix (UCD-style)`,
    `${tab}s SUFFIX:  Append all textual OIDs with SUFFIX before parsing`,
    `${tab}S PREFIX:  Prepend all textual OIDs with PREFIX before parsing`,
    '  -L LOGOPTS\t\tToggle various defaults controlling logging:',
    `${tab}e:           log to standard error`,
    `${tab}o:           log to standard output`,
    `${tab}n:           don't log at all`,
    `${tab}f file:      log to the specified file`,
    `${tab}s facility:  log to syslog (via the specified facility)`,
    '',
    `${tab}(variants)`,
    `${tab}[EON] pri:   log to standard error, output or /dev/null for level 'pri' and above`,
    `${tab}[EON] p1-p2: log to standard error, output or /dev/null for levels 'p1' to 'p2'`,
    `${tab}[FS] pri token:    log to file/syslog for level 'pri' and above`,
    `${tab}[FS] p1-p2 token:  log to file/syslog for levels 'p1' to 'p2'`,
    ...application.applicationUsage,
  ].join('\n');
}

function parseTimeoutSeconds(text: string): number | null {
  if (!/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(text)) return null;
  const microseconds = Number(text) * 1_000_000;
  if (!(microseconds >= 1 && microseconds < LONG_MAX_PLUS_ONE)) return null;
  return Math.trunc(microseconds) / 1000;
}

function parseRetries(text: string): number | null {
  if (!/^\s*[+-]?\d+\s*$/.test(text)) return null;
  const retries = Number(text);
  return retries >= 0 && retries <= INT_MAX ? retries : null;
}

export function parseNetSnmpArguments(
  argv: readonly string[], application: NetSnmpApplication, home: string,
): NetSnmpParse {
  const name = application.name;
  const stderr: string[] = [];
  const finished = (exitCode: number, stdout = ''): NetSnmpParse =>
    ({ kind: 'finished', outcome: { stdout, stderr: stderr.join('\n'), exitCode } });
  const usageDuringOptions = (): NetSnmpParse => {
    stderr.push(netSnmpUsage(application, null));
    return finished(1);
  };
  const notSimulated = (what: string): NetSnmpParse => {
    stderr.push(`${name}: ${what} is not simulated on this machine`);
    return finished(1);
  };

  let version: NetSnmpVersion | null = null;
  let community: string | null = null;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let retries = DEFAULT_RETRIES;
  let log: NetSnmpLogDestination = 'stderr';
  const output = defaultOutputOptions();
  const operands: string[] = [];

  let index = 0;
  const takeNext = (): string | undefined => (index < argv.length ? argv[index++] : undefined);
  while (index < argv.length) {
    const argument = argv[index++];
    if (argument === '--') {
      operands.push(...argv.slice(index));
      break;
    }
    if (!argument.startsWith('-') || argument === '-') {
      operands.push(argument);
      continue;
    }
    let position = 1;
    while (position < argument.length) {
      const letter = argument[position++];
      const takesArgument = COMMON_OPTIONS_WITH_ARGUMENT.has(letter) || application.optionLetters.includes(letter);
      if (!takesArgument && !COMMON_FLAGS.has(letter)) {
        stderr.push(`${name}: invalid option -- '${letter}'`);
        return usageDuringOptions();
      }
      let value = '';
      if (takesArgument) {
        if (position < argument.length) {
          value = argument.slice(position);
          position = argument.length;
        } else {
          const next = takeNext();
          if (next === undefined) {
            stderr.push(`${name}: option requires an argument -- '${letter}'`);
            return usageDuringOptions();
          }
          value = next;
        }
      }
      if (application.optionLetters.includes(letter)) {
        const refusal = application.applicationOption(letter, value, takeNext);
        if (refusal !== null) {
          stderr.push(refusal);
          return finished(1);
        }
        continue;
      }
      switch (letter) {
        case '-':
          if (value.toLowerCase() === 'help') return usageDuringOptions();
          if (value.toLowerCase() === 'version') {
            stderr.push(`NET-SNMP version: ${NET_SNMP_VERSION}`);
            return finished(0);
          }
          return notSimulated(`the configuration directive --${value}`);
        case 'V':
          stderr.push(`NET-SNMP version: ${NET_SNMP_VERSION}`);
          return finished(0);
        case 'h':
          return usageDuringOptions();
        case 'H':
          return notSimulated('listing the configuration directives (-H)');
        case 'Y':
          return notSimulated(`the configuration directive -Y ${value}`);
        case 'm':
        case 'M':
          return notSimulated(`loading MIB modules (-${letter} ${value}): this machine has no MIB files`);
        case 'I':
          return notSimulated(`input parsing options (-I ${value})`);
        case 'D':
          return notSimulated('debug tracing (-D)');
        case 'd':
          return notSimulated('packet dumping (-d)');
        case 's':
          return notSimulated(`binding a local address (-s ${value})`);
        case 'P': {
          const unknown = [...value].find((toggle) => !MIB_PARSING_TOGGLES.has(toggle));
          if (unknown !== undefined) {
            stderr.push(`Unknown parsing option passed to -P: ${unknown}.`);
            return usageDuringOptions();
          }
          break;
        }
        case 'O': {
          const toggled = applyOutputToggles(value, output);
          if (toggled.kind === 'precision-from-next-argument' && takeNext() === undefined) {
            stderr.push('Missing precision for -Op');
            stderr.push('Unknown output option passed to -O: p.');
            return usageDuringOptions();
          }
          if (toggled.kind === 'unknown') {
            stderr.push(`Unknown output option passed to -O: ${toggled.letter}.`);
            return usageDuringOptions();
          }
          break;
        }
        case 'v':
          if (value === '1') version = 'v1';
          else if (value.toLowerCase() === '2c') version = 'v2c';
          else if (value === '3') version = 'v3';
          else {
            stderr.push(`Invalid version specified after -v flag: ${value}`);
            return usageDuringOptions();
          }
          break;
        case 'p':
          stderr.push('Warning: -p option is no longer used - specify the remote host as HOST:PORT');
          return usageDuringOptions();
        case 'T':
          if (!value.includes('=')) {
            stderr.push('-T expects a NAME=VALUE pair.');
            return usageDuringOptions();
          }
          return notSimulated(`transport configuration (-T ${value})`);
        case 't': {
          const parsed = parseTimeoutSeconds(value);
          if (parsed === null) {
            stderr.push('Invalid timeout in seconds after -t flag.');
            return usageDuringOptions();
          }
          timeoutMs = parsed;
          break;
        }
        case 'r': {
          const parsed = parseRetries(value);
          if (parsed === null) {
            stderr.push('Invalid number of retries after -r flag.');
            return usageDuringOptions();
          }
          retries = parsed;
          break;
        }
        case 'c':
          community = value;
          break;
        case 'L':
          if (value === 'e') log = 'stderr';
          else if (value === 'o') log = 'stdout';
          else if (value === 'n') log = 'none';
          else return notSimulated(`logging option -L ${value}`);
          break;
        default:
          break;
      }
    }
  }

  const usageAfterInit = (): NetSnmpParse => {
    stderr.push(netSnmpUsage(application, home));
    return finished(1);
  };
  const resolvedVersion = version ?? 'v3';
  if (operands.length === 0) {
    stderr.push('No hostname specified.');
    return usageAfterInit();
  }
  if (resolvedVersion !== 'v3' && community === null) {
    stderr.push('No community name specified.');
    return usageAfterInit();
  }
  return {
    kind: 'session',
    options: { version: resolvedVersion, community, timeoutMs, retries, output, log },
    peername: operands[0],
    operands: operands.slice(1),
  };
}
