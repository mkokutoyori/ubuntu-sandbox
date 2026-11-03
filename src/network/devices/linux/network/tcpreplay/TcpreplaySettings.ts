import { isSet, optionOf, type ParsedOptions } from './TcpreplayOptions';
import { apiFailure, fatalErrText, fatalText, warningText } from './TcpreplayDiagnostics';

export type SpeedMode = 'multiplier' | 'topspeed' | 'packetrate' | 'mbpsrate' | 'oneatatime';
export type TimerMode = 'select' | 'gtod' | 'nano';

export interface ReplaySettings {
  readonly debug: number;
  readonly quiet: boolean;
  readonly timer: TimerMode;
  readonly maxSleepNanos: number;
  readonly verbose: boolean;
  readonly decodeArguments: string | null;
  readonly preload: boolean;
  readonly dualfile: boolean;
  readonly cachefile: string | null;
  readonly loop: number;
  readonly loopDelayMs: number;
  readonly useActualLength: boolean;
  readonly limitSend: number | null;
  readonly limitTimeSeconds: number | null;
  readonly speedMode: SpeedMode;
  readonly speed: number;
  readonly multiplier: number;
  readonly ppsMulti: number;
  readonly uniqueIp: boolean;
  readonly uniqueLoops: number;
  readonly flowStats: boolean;
  readonly flowExpiry: number;
  readonly stats: number;
  readonly intf1: string;
  readonly intf2: string | null;
}

export type SettingsOutcome<S> =
  | { readonly kind: 'failed'; readonly text: string }
  | { readonly kind: 'ready'; readonly settings: ReplaySettings; readonly warnings: readonly string[]; readonly primary: S; readonly secondary: S | null };

const POST_ARGS = 'tcpreplay_post_args';
const API_FILE = 'tcpreplay_api.c';

export function atof(text: string): number {
  const match = /^[ \t\n\v\f\r]*[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(text);
  return match === null ? 0 : Number(match[0].trim());
}

function failure(line: number, message: string): { kind: 'failed'; text: string } {
  return { kind: 'failed', text: fatalText('tcpreplay.c', 'main', 75, `Unable to parse args: ${apiFailure(API_FILE, POST_ARGS, line, message)}`) };
}

export interface InterfaceHost<S> {
  alias(name: string): string | null;
  open(name: string, direction: 'primary' | 'secondary'): S;
}

export function resolveSettings<S>(options: ParsedOptions, operandCount: number, interfaces: InterfaceHost<S>): SettingsOutcome<S> {
  const has = (name: string): boolean => isSet(options, name);
  const text = (name: string): string => optionOf(options, name).argument ?? '';
  const num = (name: string, fallback: number): number => optionOf(options, name).value ?? fallback;
  const warnings: string[] = [];

  let speedMode: SpeedMode = 'multiplier';
  let speed = 0;
  let multiplier = 1.0;
  let ppsMulti = 0;

  if (has('topspeed')) {
    speedMode = 'topspeed';
  } else if (has('pps')) {
    const rate = atof(text('pps'));
    if (rate === 0) return failure(182, `invalid pps value '${text('pps')}'`);
    speed = Math.trunc(rate * 60 * 60);
    speedMode = 'packetrate';
    ppsMulti = num('pps-multi', 1);
  } else if (has('oneatatime')) {
    speedMode = 'oneatatime';
  } else if (has('mbps')) {
    const rate = atof(text('mbps'));
    if (rate !== 0) {
      speedMode = 'mbpsrate';
      speed = Math.trunc(rate * 1000000);
    } else speedMode = 'topspeed';
  } else if (has('multiplier')) {
    speedMode = 'multiplier';
    multiplier = Math.fround(atof(text('multiplier')));
  }

  const maxSleepNanos = num('maxsleep', 0) * 1000000;

  const dualfile = has('dualfile');
  if (dualfile) {
    if (operandCount < 2) return failure(244, '--dualfile mode requires at least two pcap files');
    if (operandCount % 2 !== 0) return failure(249, '--dualfile mode requires an even number of pcap files');
  }

  let uniqueLoops = 1.0;
  if (has('unique-ip-loops')) {
    uniqueLoops = atof(text('unique-ip-loops'));
    if (uniqueLoops < 1.0) return failure(274, '--unique-ip-loops requires loop count >= 1.0');
  }

  let timer: TimerMode = 'gtod';
  if (has('timer')) {
    switch (text('timer')) {
      case 'select': timer = 'select'; break;
      case 'ioport':
        return { kind: 'failed', text: fatalErrText(API_FILE, POST_ARGS, 302, 'tcpreplay not compiled with IO Port 0x80 support') };
      case 'gtod': timer = 'gtod'; break;
      case 'nano': timer = 'nano'; break;
      case 'abstime': return failure(309, 'abstime is deprecated');
      default: return failure(313, `Unsupported timer mode: ${text('timer')}`);
    }
  }

  if (has('pktlen')) warnings.push(warningText('tcpreplay.c', 'main', 73, '--pktlen may cause problems.  Use with caution.'));

  const intf1 = interfaces.alias(text('intf1'));
  if (intf1 === null) return failure(336, `Invalid interface name/alias: ${text('intf1')}`);
  const primary = interfaces.open(intf1, 'primary');

  let intf2: string | null = null;
  let secondary: S | null = null;
  if (has('intf2')) {
    if (!has('cachefile') && !dualfile) return failure(370, `--intf2=${text('intf2')} requires either --cachefile or --dualfile`);
    intf2 = interfaces.alias(text('intf2'));
    if (intf2 === null) return failure(375, `Invalid interface name/alias: ${text('intf2')}`);
    secondary = interfaces.open(intf2, 'secondary');
  }

  const settings: ReplaySettings = {
    debug: num('dbug', 0),
    quiet: has('quiet'),
    timer,
    maxSleepNanos,
    verbose: has('verbose'),
    decodeArguments: has('decode') ? text('decode') : null,
    preload: has('preload-pcap'),
    dualfile,
    cachefile: has('cachefile') ? text('cachefile') : null,
    loop: num('loop', 1),
    loopDelayMs: num('loopdelay-ms', 0),
    useActualLength: has('pktlen'),
    limitSend: has('limit') ? num('limit', -1) : null,
    limitTimeSeconds: has('duration') ? num('duration', -1) : null,
    speedMode,
    speed,
    multiplier,
    ppsMulti,
    uniqueIp: has('unique-ip'),
    uniqueLoops,
    flowStats: !has('no-flow-stats'),
    flowExpiry: has('flow-expiry') ? num('flow-expiry', 0) : 0,
    stats: has('stats') ? num('stats', -1) : -1,
    intf1,
    intf2,
  };
  return { kind: 'ready', settings, warnings, primary, secondary };
}
