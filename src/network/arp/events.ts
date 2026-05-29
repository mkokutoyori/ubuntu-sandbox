/**
 * ARP (DAI) — reactive event taxonomy.
 *
 * Topics are published by the L2 switch's `ArpInspectionPipeline` and
 * consumed by:
 *   - the switch's own snooping-log buffer (`show logging`)
 *   - the syslog forwarder (when a server is configured)
 *   - the auto-recovery actor that pulls err-disabled ports back up
 *   - external observers (UI panel, tests).
 */
import type { ArpDropReason } from './types';

export interface ArpSwitchRef {
  switchId: string;
  switchName: string;
}

export interface ArpInspectedPayload extends ArpSwitchRef {
  ingressPort: string;
  vlan: number;
  senderIp: string;
  senderMac: string;
  targetIp: string;
  operation: 'request' | 'reply';
  verdict: 'pass' | 'drop';
  /** Pass reason or drop reason — useful for tests and audit. */
  reason: string;
}

export interface ArpViolationPayload extends ArpSwitchRef {
  ingressPort: string;
  vlan: number;
  senderIp: string;
  senderMac: string;
  reason: ArpDropReason;
  detail: string;
}

export interface ArpRateExceededPayload extends ArpSwitchRef {
  ingressPort: string;
  rateLimitPps: number;
  observedPps: number;
}

export interface ArpErrDisabledPayload extends ArpSwitchRef {
  port: string;
  cause: 'arp-inspection';
}

export interface ArpErrRecoveredPayload extends ArpSwitchRef {
  port: string;
}

export interface ArpSnoopLearnedPayload extends ArpSwitchRef {
  /** Sender IP that the switch's *management* ARP cache just absorbed. */
  ip: string;
  mac: string;
  ingressPort: string;
  vlan: number;
}

export type ArpDomainEvent =
  | { topic: 'arp.inspected';         payload: ArpInspectedPayload }
  | { topic: 'arp.violation';         payload: ArpViolationPayload }
  | { topic: 'arp.rate-limit-exceeded'; payload: ArpRateExceededPayload }
  | { topic: 'arp.errdisable.set';    payload: ArpErrDisabledPayload }
  | { topic: 'arp.errdisable.cleared'; payload: ArpErrRecoveredPayload }
  | { topic: 'arp.snoop.learned';     payload: ArpSnoopLearnedPayload };
