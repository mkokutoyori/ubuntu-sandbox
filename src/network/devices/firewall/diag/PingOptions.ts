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

export interface PingOptionOutcome {
  readonly ok: boolean;
  readonly message: string;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export class PingOptions {
  private state: PingOptionsState = { ...PING_DEFAULTS };

  current(): Readonly<PingOptionsState> { return { ...this.state }; }

  reset(): void { this.state = { ...PING_DEFAULTS }; }

  set(option: string, value: string | undefined): PingOptionOutcome {
    const integer = (min: number, max: number): number | null => {
      if (value === undefined) return null;
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
    };

    switch (option) {
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
        if (value !== 'auto' && !IPV4.test(value)) {
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
      `    DF bit: ${s.dfBit ? 'set' : 'unset'}`,
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
