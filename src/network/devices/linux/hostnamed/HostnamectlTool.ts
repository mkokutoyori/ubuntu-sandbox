import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { emit, outputOf, type ToolOutput } from '../kerberos/Krb5ToolOutput';
import { JOURNALCTL_VERSION, SYSTEMD_FEATURES } from '../journal/JournalctlTool';
import type { BusError, Hostnamed, MachineInfoProperty } from './Hostnamed';
import { FILE_IS_PROTECTED, READ_ONLY_FILESYSTEM } from './Hostnamed';
import { cleanupHostname, isHostnameValid, levenshtein } from './SystemdNames';

export interface HostnamectlHost {
  readonly daemon: Hostnamed;
  readonly machineId: string | null;
  readonly bootId: string | null;
  readonly virtualization: string;
  readonly architecture: string;
  readonly kernel: { readonly name: string; readonly release: string; readonly version: string };
  readonly connectFailure: (transport: 'host' | 'machine', target: string) => string;
}

type JsonValue = string | null;
type JsonFormat = 'off' | 'pretty' | 'short';

const HELP = [
  'hostnamectl [OPTIONS...] COMMAND ...',
  '',
  'Query or change system hostname.',
  '',
  'Commands:',
  '  status                 Show current hostname settings',
  '  hostname [NAME]        Get/set system hostname',
  '  icon-name [NAME]       Get/set icon name for host',
  '  chassis [NAME]         Get/set chassis type for host',
  '  deployment [NAME]      Get/set deployment environment for host',
  '  location [NAME]        Get/set location for host',
  '',
  'Options:',
  '  -h --help              Show this help',
  '     --version           Show package version',
  '     --no-ask-password   Do not prompt for password',
  '  -H --host=[USER@]HOST  Operate on remote host',
  '  -M --machine=CONTAINER Operate on local container',
  '     --transient         Only set transient hostname',
  '     --static            Only set static hostname',
  '     --pretty            Only set pretty hostname',
  '     --json=pretty|short|off',
  '                         Generate JSON output',
  '',
  'See the hostnamectl(1) man page for details.',
  '',
].join('\n');

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'help', letter: 'h', takesArgument: false },
  { name: 'version', letter: 'Ā', takesArgument: false },
  { name: 'transient', letter: 'Ă', takesArgument: false },
  { name: 'static', letter: 'ă', takesArgument: false },
  { name: 'pretty', letter: 'Ą', takesArgument: false },
  { name: 'host', letter: 'H', takesArgument: true },
  { name: 'machine', letter: 'M', takesArgument: true },
  { name: 'no-ask-password', letter: 'ā', takesArgument: false },
  { name: 'json', letter: 'ą', takesArgument: true },
];

interface Verb {
  readonly name: string;
  readonly minArgs: number | null;
  readonly maxArgs: number | null;
  readonly run: (words: readonly string[]) => number;
}

const CHASSIS_GLYPHS: Readonly<Record<string, string>> = {
  laptop: '\u{1F4BB}', desktop: '\u{1F5A5}️', server: '\u{1F5B3}', tablet: '具', watch: '⌚', handset: '\u{1F5FB}', vm: '\u{1F5B4}', container: '☐',
};

const CLOSEST_VERB_DISTANCE = 5;

function jsonText(value: JsonValue): string {
  return value === null ? 'null' : JSON.stringify(value);
}

export function renderJson(fields: ReadonlyArray<readonly [string, JsonValue]>, format: JsonFormat): string {
  if (format === 'short') return `{${fields.map(([key, value]) => `${JSON.stringify(key)}:${jsonText(value)}`).join(',')}}\n`;
  return `{\n${fields.map(([key, value]) => `\t${JSON.stringify(key)} : ${jsonText(value)}`).join(',\n')}\n}\n`;
}

export async function runHostnamectl(argv0: string, args: readonly string[], host: HostnamectlHost): Promise<ToolOutput> {
  const out = outputOf();
  const say = (text: string): void => emit(out, 'stdout', text);
  const complain = (text: string): void => emit(out, 'stderr', `${text}\n`);
  const fail = (text: string): number => { complain(text); return 1; };
  const daemon = host.daemon;

  let transient = false;
  let pretty = false;
  let isStatic = false;
  let json: JsonFormat = 'off';
  let remote: { transport: 'host' | 'machine'; target: string } | null = null;
  const operands: string[] = [];
  for (const item of shortOptions(args, 'hH:M:', LONG_OPTIONS)) {
    if (item.kind === 'operand') {
      operands.push(item.value);
    } else if (item.kind === 'option') {
      switch (item.letter) {
        case 'h':
          say(HELP);
          return finish(out, 0);
        case 'Ā':
          say(`${JOURNALCTL_VERSION}\n${SYSTEMD_FEATURES}\n`);
          return finish(out, 0);
        case 'H':
        case 'M':
          remote = { transport: item.letter === 'H' ? 'host' : 'machine', target: item.argument ?? '' };
          break;
        case 'Ă': transient = true; break;
        case 'ă': isStatic = true; break;
        case 'Ą': pretty = true; break;
        case 'ā': break;
        case 'ą': {
          const choice = item.argument ?? '';
          if (choice === 'pretty' || choice === 'short' || choice === 'off') json = choice;
          else if (choice === 'help') {
            say('pretty\nshort\noff\n');
            return finish(out, 0);
          } else return finish(out, fail(`Unknown argument to --json= switch: ${choice}`));
          break;
        }
      }
    } else {
      complain(getoptDiagnostic(argv0, item));
      return finish(out, 1);
    }
  }

  const failure = (target: string, error: BusError): number => fail(`Could not set ${target}: ${error.message}`);

  const unreachable = (prefix: string): number => fail(`${prefix}: Transport endpoint is not connected`);

  const printName = (value: string | null): number => { say(`${value ?? ''}\n`); return 0; };

  const nameByFlag = (): number => {
    if (remote !== null) return unreachable('Could not get property');
    if (Number(isStatic) + Number(pretty) + Number(transient) > 1) return fail('Cannot query more than one name type at a time');
    if (pretty) return printName(daemon.machineInfo().PRETTY_HOSTNAME);
    if (isStatic) return printName(daemon.staticHostname());
    return printName(daemon.kernelHostname());
  };

  const description = (): Array<readonly [string, JsonValue]> => {
    const info = daemon.machineInfo();
    const os = daemon.osRelease();
    return [
      ['Hostname', daemon.kernelHostname()], ['StaticHostname', daemon.staticHostname()], ['PrettyHostname', info.PRETTY_HOSTNAME],
      ['DefaultHostname', daemon.defaultHostname()], ['HostnameSource', daemon.source()], ['IconName', daemon.iconName()],
      ['Chassis', daemon.chassis()], ['Deployment', info.DEPLOYMENT], ['Location', info.LOCATION],
      ['KernelName', host.kernel.name], ['KernelRelease', host.kernel.release], ['KernelVersion', host.kernel.version],
      ['OperatingSystemPrettyName', os.prettyName], ['OperatingSystemCPEName', os.cpeName], ['OperatingSystemHomeURL', os.homeUrl],
      ['HardwareVendor', daemon.hardware().vendor], ['HardwareModel', daemon.hardware().model], ['HardwareSerial', null], ['FirmwareVersion', null], ['FirmwareVendor', null],
      ['MachineID', host.machineId], ['BootID', host.bootId], ['ProductUUID', null],
    ];
  };

  const statusTable = (): number => {
    const info = daemon.machineInfo();
    const os = daemon.osRelease();
    const staticName = daemon.staticHostname();
    const kernelName = daemon.kernelHostname();
    const chassis = daemon.chassis();
    const rows: Array<readonly [string, string]> = [['Static hostname', staticName ?? '(unset)']];
    if (info.PRETTY_HOSTNAME !== null && info.PRETTY_HOSTNAME !== staticName) rows.push(['Pretty hostname', info.PRETTY_HOSTNAME]);
    if (kernelName !== staticName) rows.push(['Transient hostname', kernelName]);
    rows.push(['Icon name', daemon.iconName()]);
    if (chassis !== null) rows.push(['Chassis', CHASSIS_GLYPHS[chassis] === undefined ? chassis : `${chassis} ${CHASSIS_GLYPHS[chassis]}`]);
    if (info.DEPLOYMENT !== null) rows.push(['Deployment', info.DEPLOYMENT]);
    if (info.LOCATION !== null) rows.push(['Location', info.LOCATION]);
    if (host.machineId !== null) rows.push(['Machine ID', host.machineId]);
    if (host.bootId !== null) rows.push(['Boot ID', host.bootId]);
    if (host.virtualization !== '') rows.push(['Virtualization', host.virtualization]);
    if (os.prettyName !== null) rows.push(['Operating System', os.prettyName]);
    if (os.cpeName !== null) rows.push(['CPE OS Name', os.cpeName]);
    if (host.kernel.name !== '' && host.kernel.release !== '') rows.push(['Kernel', `${host.kernel.name} ${host.kernel.release}`]);
    if (host.architecture !== '') rows.push(['Architecture', host.architecture]);
    const hardware = daemon.hardware();
    if (hardware.vendor !== null) rows.push(['Hardware Vendor', hardware.vendor]);
    if (hardware.model !== null) rows.push(['Hardware Model', hardware.model]);
    const width = Math.max(...rows.map(([label]) => label.length)) + 1;
    say(rows.map(([label, value]) => `${`${label}:`.padStart(width)} ${value}\n`).join(''));
    return 0;
  };

  const showStatus = (): number => {
    if (remote !== null) return unreachable(json !== 'off' ? 'Could not get description' : pretty || isStatic || transient ? 'Could not get property' : 'Failed to query system properties');
    if (json !== 'off') {
      say(renderJson(description(), json));
      return 0;
    }
    if (pretty || isStatic || transient) return nameByFlag();
    return statusTable();
  };

  const callSetter = (target: string, error: BusError | null): { failed: number; hint: boolean } => {
    if (error === null) return { failed: 0, hint: false };
    const protectedFile = error.name === FILE_IS_PROTECTED || error.name === READ_ONLY_FILESYSTEM;
    return { failed: failure(target, error), hint: protectedFile };
  };

  const setHostname = (words: readonly string[]): number => {
    let name = words[1];
    let implicit = false;
    let showHint = false;
    let result = 0;
    if (!pretty && !isStatic && !transient) {
      pretty = isStatic = transient = implicit = true;
    }
    if (remote !== null) {
      if (!implicit && !isStatic && transient) return unreachable('Could not get property');
      return unreachable(`Could not set ${pretty ? 'pretty' : isStatic ? 'static' : 'transient'} hostname`);
    }
    if (!implicit && !isStatic && transient && daemon.source() === 'static') {
      complain('Hint: static hostname is already set, so the specified transient hostname will not be used.');
    }
    if (pretty) {
      const prettyValue = implicit && isHostnameValid(name, true) ? '' : name;
      const outcome = callSetter('pretty hostname', daemon.setMachineInfo('PRETTY_HOSTNAME', prettyValue));
      if (outcome.failed !== 0) {
        if (!(implicit && outcome.hint)) return 1;
        showHint = true;
        result = 1;
      }
      name = cleanupHostname(name);
    }
    if (isStatic) {
      const outcome = callSetter('static hostname', daemon.setStaticHostname(name));
      if (outcome.failed !== 0) {
        if (!(implicit && outcome.hint)) return 1;
        showHint = true;
        result = 1;
      }
    }
    if (transient) {
      const error = daemon.setHostname(name);
      if (error !== null) return failure('transient hostname', error);
    }
    if (showHint) {
      complain('Hint: use --transient option when /etc/machine-info or /etc/hostname cannot be modified (e.g. located in read-only filesystem).');
    }
    return result;
  };

  const machineVerb = (property: MachineInfoProperty, label: string): ((words: readonly string[]) => number) => (words) => {
    if (remote !== null) return unreachable(words.length === 1 ? 'Could not get property' : `Could not set ${label}`);
    if (words.length === 1) {
      const value = property === 'ICON_NAME' ? daemon.iconName() : property === 'CHASSIS' ? daemon.chassis() : daemon.machineInfo()[property];
      return printName(value);
    }
    const error = daemon.setMachineInfo(property, words[1]);
    return error === null ? 0 : failure(label, error);
  };

  const hostnameVerb = (words: readonly string[]): number => (words.length === 1 ? nameByFlag() : setHostname(words));

  const verbs: readonly Verb[] = [
    { name: 'status', minArgs: null, maxArgs: 1, run: showStatus },
    { name: 'hostname', minArgs: null, maxArgs: 2, run: hostnameVerb },
    { name: 'set-hostname', minArgs: 2, maxArgs: 2, run: hostnameVerb },
    { name: 'icon-name', minArgs: null, maxArgs: 2, run: machineVerb('ICON_NAME', 'icon') },
    { name: 'set-icon-name', minArgs: 2, maxArgs: 2, run: machineVerb('ICON_NAME', 'icon') },
    { name: 'chassis', minArgs: null, maxArgs: 2, run: machineVerb('CHASSIS', 'chassis') },
    { name: 'set-chassis', minArgs: 2, maxArgs: 2, run: machineVerb('CHASSIS', 'chassis') },
    { name: 'deployment', minArgs: null, maxArgs: 2, run: machineVerb('DEPLOYMENT', 'deployment') },
    { name: 'set-deployment', minArgs: 2, maxArgs: 2, run: machineVerb('DEPLOYMENT', 'deployment') },
    { name: 'location', minArgs: null, maxArgs: 2, run: machineVerb('LOCATION', 'location') },
    { name: 'set-location', minArgs: 2, maxArgs: 2, run: machineVerb('LOCATION', 'location') },
    { name: 'help', minArgs: null, maxArgs: null, run: () => { say(HELP); return 0; } },
  ];

  if (remote !== null && remote.transport === 'machine') return finish(out, fail(host.connectFailure(remote.transport, remote.target)));
  daemon.begin();
  const name = operands[0];
  let verb = verbs.find((candidate) => candidate.name === name);
  if (verb === undefined) {
    if (name === undefined) verb = verbs[0];
    else {
      let best: Verb | undefined;
      let bestRemainder = Infinity;
      for (const candidate of verbs) {
        if (!candidate.name.startsWith(name)) continue;
        const remainder = candidate.name.length - name.length;
        if (remainder < bestRemainder) {
          bestRemainder = remainder;
          best = candidate;
        }
      }
      if (best === undefined) {
        let bestDistance = Infinity;
        for (const candidate of verbs) {
          const distance = levenshtein(candidate.name, name);
          if (distance > CLOSEST_VERB_DISTANCE) continue;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = candidate;
          }
        }
      }
      return finish(out, fail(best === undefined ? `Unknown command verb '${name}'.` : `Unknown command verb '${name}', did you mean '${best.name}'?`));
    }
  }
  const left = name === undefined ? 1 : operands.length;
  if (verb.minArgs !== null && left < verb.minArgs) return finish(out, fail('Too few arguments.'));
  if (verb.maxArgs !== null && left > verb.maxArgs) return finish(out, fail('Too many arguments.'));
  return finish(out, verb.run(name === undefined ? [verb.name] : operands));
}

function finish(out: ToolOutput, status: number): ToolOutput {
  out.exitCode = status;
  return out;
}
