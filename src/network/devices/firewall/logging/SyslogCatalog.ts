import type { Severity } from '../../inspection/config/LoggingConfig';

export type FirewallLogEvent =
  | 'session-built'
  | 'session-torn-down'
  | 'policy-deny'
  | 'translation-created';

export interface FirewallLogMessage {
  readonly id: string;
  readonly severity: Severity;
}

export type FirewallSyslogCatalog =
  Readonly<Partial<Record<FirewallLogEvent, FirewallLogMessage>>>;

export interface FirewallLogFacts {
  readonly protocol: string;
  readonly ingressZone: string;
  readonly egressZone: string;
  readonly sourceIP: string;
  readonly sourcePort: number;
  readonly destinationIP: string;
  readonly destinationPort: number;
  readonly sessionId?: number;
  readonly ruleId?: string;
  readonly reason?: string;
}

export function firewallLogText(event: FirewallLogEvent, facts: FirewallLogFacts): string {
  const source = `${facts.ingressZone}:${facts.sourceIP}/${facts.sourcePort}`;
  const destination = `${facts.egressZone}:${facts.destinationIP}/${facts.destinationPort}`;

  switch (event) {
    case 'session-built':
      return `Built inbound ${facts.protocol} connection ${facts.sessionId ?? 0}`
        + ` for ${source} to ${destination}`;
    case 'session-torn-down':
      return `Teardown ${facts.protocol} connection ${facts.sessionId ?? 0}`
        + ` for ${source} to ${destination} duration 0:00:00`
        + ` bytes 0 ${facts.reason ?? 'Connection timeout'}`;
    case 'policy-deny':
      return `Deny ${facts.protocol} src ${source} dst ${destination}`
        + ` by access-group "${facts.ruleId ?? 'implicit'}"`;
    case 'translation-created':
      return `Built dynamic ${facts.protocol} translation from ${source} to ${destination}`;
  }
}
