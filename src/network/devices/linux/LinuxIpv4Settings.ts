import { ecnPolicyOfSetting, type TcpEcnPolicy } from '@/network/tcp/TcpEcn';
import type { TcpOptionPolicy } from '@/network/tcp/TcpStack';
import { TCP_INITIAL_RTO_MS } from '@/network/tcp/RttEstimator';
import { modelledRetransmitTimeoutMs, type TcpRetryPolicy } from '@/network/tcp/TcpRetryPolicy';

export const LINUX_RTO_MIN_MS = 200;
export const LINUX_RTO_MAX_MS = 120_000;

export interface KernelIpFacts {
  readonly forwarding: boolean;
  readonly defaultTtl: number;
  readonly rtoMinMs: number;
  readonly rtoMaxMs: number;
}

export interface KernelIpFactsSource {
  getKernelIpFacts(): KernelIpFacts;
}

export interface KernelByteKnob {
  readonly name: string;
  readonly initial: number;
  readonly minimum: number;
  readonly maximum: number;
}

export const LINUX_IPV4_KNOBS: readonly KernelByteKnob[] = [
  { name: 'tcp_ecn', initial: 2, minimum: 0, maximum: 255 },
  { name: 'tcp_ecn_fallback', initial: 1, minimum: 0, maximum: 255 },
  { name: 'tcp_sack', initial: 1, minimum: 0, maximum: 255 },
  { name: 'tcp_timestamps', initial: 1, minimum: 0, maximum: 255 },
  { name: 'tcp_window_scaling', initial: 1, minimum: 0, maximum: 255 },
  { name: 'tcp_slow_start_after_idle', initial: 1, minimum: 0, maximum: 255 },
  { name: 'ip_default_ttl', initial: 64, minimum: 1, maximum: 255 },
  { name: 'tcp_syn_retries', initial: 6, minimum: 1, maximum: 127 },
  { name: 'tcp_synack_retries', initial: 5, minimum: 0, maximum: 255 },
  { name: 'tcp_retries1', initial: 3, minimum: 0, maximum: 255 },
  { name: 'tcp_retries2', initial: 15, minimum: 0, maximum: 255 },
];

export const LINUX_CORE_KNOBS: readonly KernelByteKnob[] = [
  { name: 'somaxconn', initial: 4096, minimum: 0, maximum: 2_147_483_647 },
];

export class KernelKnobStore {
  private readonly values: Map<string, number>;

  constructor(private readonly knobs: readonly KernelByteKnob[]) {
    this.values = new Map(knobs.map((knob) => [knob.name, knob.initial]));
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  get(name: string): number {
    return this.values.get(name) ?? 0;
  }

  set(name: string, value: number): boolean {
    const knob = this.knobs.find((candidate) => candidate.name === name);
    if (knob === undefined || value < knob.minimum || value > knob.maximum) return false;
    this.values.set(name, value);
    return true;
  }

  write(name: string, text: string): boolean {
    const value = text.trim();
    return /^\d+$/.test(value) && this.set(name, Number(value));
  }
}

export class LinuxCoreSettings extends KernelKnobStore {
  constructor() {
    super(LINUX_CORE_KNOBS);
  }

  get listenBacklogLimit(): number {
    return this.get('somaxconn');
  }
}

export class LinuxIpv4Settings extends KernelKnobStore {
  constructor() {
    super(LINUX_IPV4_KNOBS);
  }

  get ecnPolicy(): TcpEcnPolicy {
    return ecnPolicyOfSetting(this.get('tcp_ecn'));
  }

  get ecnFallsBack(): boolean {
    return this.get('tcp_ecn_fallback') !== 0;
  }

  get optionPolicy(): TcpOptionPolicy {
    return {
      sack: this.get('tcp_sack') !== 0,
      timestamps: this.get('tcp_timestamps') !== 0,
      windowScaling: this.get('tcp_window_scaling') !== 0,
    };
  }

  get retryPolicy(): TcpRetryPolicy {
    const timeoutOf = (retries: number) => modelledRetransmitTimeoutMs(retries, LINUX_RTO_MIN_MS, LINUX_RTO_MAX_MS);
    return {
      initialRtoMs: TCP_INITIAL_RTO_MS,
      rtoFloor: { granularityMs: LINUX_RTO_MIN_MS, minRtoMs: 0 },
      maxRtoMs: LINUX_RTO_MAX_MS,
      activeOpen: { kind: 'retransmissions', count: this.get('tcp_syn_retries') },
      passiveOpen: { kind: 'retransmissions', count: this.get('tcp_synack_retries') },
      established: { kind: 'elapsed', ms: timeoutOf(this.get('tcp_retries2')), atExpiry: true },
      delivery: { kind: 'elapsed', ms: timeoutOf(this.get('tcp_retries1')), atExpiry: true },
      windowProbe: { form: 'old-sequence', unanswered: this.get('tcp_retries2') },
    };
  }

  get restartsAfterIdle(): boolean {
    return this.get('tcp_slow_start_after_idle') !== 0;
  }

  get defaultTtl(): number {
    return this.get('ip_default_ttl');
  }

  kernelIpFacts(forwarding: boolean): KernelIpFacts {
    return {
      forwarding,
      defaultTtl: this.defaultTtl,
      rtoMinMs: LINUX_RTO_MIN_MS,
      rtoMaxMs: LINUX_RTO_MAX_MS,
    };
  }
}

export const STANDALONE_KERNEL_IP_FACTS: KernelIpFacts = new LinuxIpv4Settings().kernelIpFacts(false);
