import type { RsyslogMessage } from '../Message';
import { RS_RET } from './Log';

export interface RateLimiterOptions {
  readonly name: string;
  readonly interval: number;
  readonly burst: number;
  readonly severityThreshold: number;
  readonly reduceRepeated: boolean;
  readonly internal: (severity: number, code: number, text: string) => void;
  readonly nowSeconds: () => number;
}

export interface RateLimitDecision {
  readonly deliver: RsyslogMessage | null;
  readonly repeated: RsyslogMessage | null;
}


export class RateLimiter {
  private begin = 0;
  private done = 0;
  private missed = 0;
  private previous: RsyslogMessage | null = null;
  private suppressed = 0;

  constructor(private readonly options: RateLimiterOptions) {}

  private tellLostCount(): void {
    if (this.missed === 0) return;
    this.options.internal(
      6,
      RS_RET.RATE_LIMITED,
      `${this.options.name}: ${this.missed} messages lost due to rate-limiting (${this.options.burst} allowed within ${this.options.interval} seconds)`,
    );
    this.missed = 0;
  }

  private within(source: string, seconds: number): boolean {
    const { interval, burst } = this.options;
    if (interval === 0) return true;
    if (this.begin === 0) this.begin = seconds;
    if (seconds > this.begin + interval || seconds < this.begin) {
      this.begin = 0;
      this.done = 0;
      this.tellLostCount();
    }
    if (burst > this.done) {
      this.done++;
      return true;
    }
    this.missed++;
    if (this.missed === 1) {
      this.options.internal(
        6,
        RS_RET.RATE_LIMITED,
        `${this.options.name} from <${source}>: begin to drop messages due to rate-limiting`,
      );
    }
    return false;
  }

  private repeatedMessage(): RsyslogMessage | null {
    const previous = this.previous;
    if (previous === null) return null;
    if (this.suppressed === 1) return previous;
    const copy = Object.assign(Object.create(Object.getPrototypeOf(previous) as object) as RsyslogMessage, previous);
    copy.cee = JSON.parse(JSON.stringify(previous.cee)) as typeof previous.cee;
    copy.localVariables = JSON.parse(JSON.stringify(previous.localVariables)) as typeof previous.localVariables;
    copy.msg = ` message repeated ${this.suppressed} times: [${previous.msg.slice(0, 800)}]`;
    return copy;
  }

  admit(source: string): boolean {
    if (this.options.interval === 0) return true;
    return this.within(source, this.options.nowSeconds());
  }

  decide(message: RsyslogMessage): RateLimitDecision {
    const { interval, severityThreshold, reduceRepeated } = this.options;
    const severity = reduceRepeated || severityThreshold > 0 ? message.severity : 0;
    if (interval > 0 && severity >= severityThreshold && !this.within(`${message.hostnameOrSender}:${message.effectiveAppName}`, message.receivedAtSeconds)) {
      return { deliver: null, repeated: null };
    }
    if (!reduceRepeated) return { deliver: message, repeated: null };
    const previous = this.previous;
    if (
      previous !== null && previous.msg === message.msg && previous.hostnameOrSender === message.hostnameOrSender
      && previous.effectiveProcId === message.effectiveProcId && previous.effectiveAppName === message.effectiveAppName
    ) {
      this.suppressed++;
      this.previous = message;
      return { deliver: null, repeated: null };
    }
    let repeated: RsyslogMessage | null = null;
    if (previous !== null && this.suppressed > 0) {
      repeated = this.repeatedMessage();
      this.suppressed = 0;
    }
    this.previous = message;
    return { deliver: message, repeated };
  }
}
