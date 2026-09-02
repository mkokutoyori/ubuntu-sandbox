export interface PingOptionsState {
  repeatCount: number;
  dataSize: number;
  timeoutSeconds: number;
  interfaceName: string;
  intervalSeconds: number;
  ttl: number;
  tos: number;
  dfBit: boolean;
  sourceAddress: string;
}

export const PING_DEFAULTS: Readonly<PingOptionsState> = Object.freeze({
  repeatCount: 5,
  dataSize: 56,
  timeoutSeconds: 2,
  interfaceName: 'auto',
  intervalSeconds: 1,
  ttl: 64,
  tos: 0,
  dfBit: false,
  sourceAddress: 'auto',
});

export type PingFamily = 'ipv4' | 'ipv6';

export interface PingOptionSpec {
  readonly name: string;
  readonly help: string;
  readonly ipv4Only?: boolean;
}

export const PING_OPTION_SPECS: readonly PingOptionSpec[] = Object.freeze([
  { name: 'adaptive-ping', help: 'Adaptive ping <enable | disable>.' },
  { name: 'data-size', help: 'Integer value to specify datagram size in bytes.' },
  { name: 'df-bit', help: 'Set DF bit in IP header <yes | no>.', ipv4Only: true },
  { name: 'interface', help: 'Auto | <outgoing interface>.' },
  { name: 'interval', help: 'Integer value to specify seconds between two pings.' },
  { name: 'pattern', help: 'Hex pattern for the datagram payload.' },
  { name: 'repeat-count', help: 'Integer value to specify how many times to repeat PING.' },
  { name: 'reset', help: 'Reset settings.' },
  { name: 'source', help: 'Auto | <source interface IP>.' },
  { name: 'timeout', help: 'Integer value to specify timeout in seconds.' },
  { name: 'tos', help: 'IP type-of-service option.' },
  { name: 'ttl', help: 'Integer value to specify time-to-live.' },
  { name: 'validate-reply', help: 'Validate the reply data <yes | no>.' },
  { name: 'view-settings', help: 'View the current settings for PING option.' },
]);

export function pingOptionsFor(family: PingFamily): readonly PingOptionSpec[] {
  return PING_OPTION_SPECS.filter(spec => family === 'ipv4' || spec.ipv4Only !== true);
}

export interface PingOptionOutcome {
  readonly ok: boolean;
  readonly message: string;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9A-Fa-f:]+$/;

export class PingOptions {
  private state: PingOptionsState = { ...PING_DEFAULTS };

  constructor(private readonly family: PingFamily = 'ipv4') {}

  knows(option: string): boolean {
    return pingOptionsFor(this.family).some(spec => spec.name === option);
  }

  current(): Readonly<PingOptionsState> { return { ...this.state }; }

  reset(): void { this.state = { ...PING_DEFAULTS }; }

  set(option: string, value: string | undefined): PingOptionOutcome {
    const integer = (min: number, max: number): number | null => {
      if (value === undefined) return null;
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
    };

    if (!this.knows(option)) {
      return { ok: false, message: `unknown ping option "${option}".` };
    }

    switch (option) {
      case 'reset': {
        this.reset();
        return { ok: true, message: '' };
      }
      case 'repeat-count': {
        const n = integer(1, 1000);
        if (n === null) return refuse(value, 'an integer between 1 and 1000');
        this.state.repeatCount = n;
        return { ok: true, message: '' };
      }
      case 'data-size': {
        const n = integer(0, 65507);
        if (n === null) return refuse(value, 'an integer between 0 and 65507');
        this.state.dataSize = n;
        return { ok: true, message: '' };
      }
      case 'timeout': {
        const n = integer(0, 3600);
        if (n === null) return refuse(value, 'an integer of seconds');
        this.state.timeoutSeconds = n;
        return { ok: true, message: '' };
      }
      case 'interval': {
        const n = integer(1, 3600);
        if (n === null) return refuse(value, 'an integer of seconds');
        this.state.intervalSeconds = n;
        return { ok: true, message: '' };
      }
      case 'ttl': {
        const n = integer(1, 255);
        if (n === null) return refuse(value, 'an integer between 1 and 255');
        this.state.ttl = n;
        return { ok: true, message: '' };
      }
      case 'tos': {
        const n = integer(0, 255);
        if (n === null) return refuse(value, 'an integer between 0 and 255');
        this.state.tos = n;
        return { ok: true, message: '' };
      }
      case 'df-bit': {
        if (value !== 'yes' && value !== 'no') return refuse(value, '`yes` or `no`');
        this.state.dfBit = value === 'yes';
        return { ok: true, message: '' };
      }
      case 'source': {
        if (value === undefined) return refuse(value, '`auto` or an interface address');
        const shape = this.family === 'ipv6' ? IPV6 : IPV4;
        if (value !== 'auto' && !shape.test(value)) {
          return refuse(value, '`auto` or an interface address');
        }
        this.state.sourceAddress = value;
        return { ok: true, message: '' };
      }
      case 'interface': {
        if (value === undefined) return refuse(value, '`auto` or an interface name');
        this.state.interfaceName = value;
        return { ok: true, message: '' };
      }
      default:
        return { ok: false, message: `unknown ping option "${option}".` };
    }
  }

  viewSettings(): string {
    const s = this.state;
    return [
      'Ping Options:',
      `    Repeat Count: ${s.repeatCount}`,
      `    Data Size: ${s.dataSize}`,
      `    Timeout: ${s.timeoutSeconds}`,
      `    Interface: ${s.interfaceName}`,
      `    Interval: ${s.intervalSeconds}`,
      `    TTL: ${s.ttl}`,
      `    TOS: ${s.tos}`,
      ...(this.family === 'ipv4' ? [`    DF bit: ${s.dfBit ? 'set' : 'unset'}`] : []),
      `    Source Address: ${s.sourceAddress}`,
    ].join('\n');
  }
}

function refuse(value: string | undefined, expected: string): PingOptionOutcome {
  return {
    ok: false,
    message: value === undefined
      ? `this option needs ${expected}.`
      : `value parse error before '${value}'; this option needs ${expected}.`,
  };
}
