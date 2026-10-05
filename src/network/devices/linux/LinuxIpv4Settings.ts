import { ecnPolicyOfSetting, type TcpEcnPolicy } from '@/network/tcp/TcpEcn';
import type { TcpOptionPolicy } from '@/network/tcp/TcpStack';

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
];

export class LinuxIpv4Settings {
  private readonly values = new Map<string, number>(LINUX_IPV4_KNOBS.map((knob) => [knob.name, knob.initial]));

  has(name: string): boolean {
    return this.values.has(name);
  }

  get(name: string): number {
    return this.values.get(name) ?? 0;
  }

  set(name: string, value: number): boolean {
    const knob = LINUX_IPV4_KNOBS.find((candidate) => candidate.name === name);
    if (knob === undefined || value < knob.minimum || value > knob.maximum) return false;
    this.values.set(name, value);
    return true;
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

  get restartsAfterIdle(): boolean {
    return this.get('tcp_slow_start_after_idle') !== 0;
  }

  get defaultTtl(): number {
    return this.get('ip_default_ttl');
  }
}
