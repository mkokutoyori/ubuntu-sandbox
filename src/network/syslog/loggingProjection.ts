import type { LoggingConfig } from '../devices/inspection/config/LoggingConfig';
import type { SyslogAgent } from './SyslogAgent';
import type { SyslogFacilityName, SyslogSeverityName } from './types';

const SEVERITY_TABLE: Readonly<Record<string, SyslogSeverityName>> = Object.freeze({
  emergencies: 'emergency', alerts: 'alert', critical: 'critical', errors: 'error',
  warnings: 'warning', notifications: 'notification',
  informational: 'informational', debugging: 'debugging',
});

export function syslogSeverityOf(name: string): SyslogSeverityName {
  return SEVERITY_TABLE[name] ?? 'informational';
}

export function projectLoggingOntoSyslogAgent(logging: LoggingConfig, agent: SyslogAgent): void {
  const facility = logging.facility as SyslogFacilityName;
  const threshold = syslogSeverityOf(logging.trapSeverity);

  agent.setEnabled(logging.enabled);
  agent.setDefaultFacility(facility);
  agent.setDefaultSeverityThreshold(threshold);
  agent.setSourceInterface(logging.sourceInterface);

  const desired = new Set(logging.hosts);
  for (const server of agent.listServers()) {
    if (!desired.has(server.ip)) agent.removeServer(server.ip);
  }

  if (logging.queueLimit && logging.queueLimit.scope !== 'esm') {
    agent.setQueueLimit(logging.queueLimit.size);
  }

  for (const host of logging.hostConfigs) {
    agent.addServer(host.ip, {
      facility, severityThreshold: threshold,
      port: host.port, transport: host.transport, delimiter: logging.delimiterTcp,
    });
  }

  if (logging.serverArp) agent.arpForServers();
}
