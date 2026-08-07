import type { SyslogSeverityName, SyslogFacilityName } from './types';

export interface SyslogDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface SyslogPacketSentPayload extends SyslogDeviceRef {
  serverIp: string;
  facility: SyslogFacilityName;
  severity: SyslogSeverityName;
  tag: string;
  message: string;
}

export interface SyslogPacketDroppedPayload extends SyslogDeviceRef {
  serverIp: string;
  /**
   * `no-tcp` : le collecteur est configuré en `transport tcp` sur un
   * équipement dont l'agent n'a pas reçu de pile TCP. Distinct de
   * `no-route` : le chemin peut être parfait, c'est la machine qui ne
   * sait pas ouvrir la connexion.
   */
  reason: 'no-route' | 'no-source-ip' | 'threshold' | 'disabled' | 'link-down' | 'no-tcp' | 'queue-full';
}

export interface SyslogServerChangedPayload extends SyslogDeviceRef {
  serverIp: string;
  added: boolean;
}

export type SyslogDomainEvent =
  | { topic: 'syslog.packet.sent'; payload: SyslogPacketSentPayload }
  | { topic: 'syslog.packet.dropped'; payload: SyslogPacketDroppedPayload }
  | { topic: 'syslog.server.changed'; payload: SyslogServerChangedPayload };
