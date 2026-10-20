import { formatRfc3164 } from './codec/Rfc3164';
import { formatRfc5424 } from './codec/Rfc5424';
import { frameNonTransparent, frameOctetCounted } from './codec/Framing';
import { FACILITY_TEXT, SEVERITY_TEXT, priorityValue } from './codec/SyslogPriority';
import type { StructuredDataElement } from './codec/StructuredData';
import { syslogTimeFromEpochMs, TIME_TYPE_RFC3164, TIME_TYPE_RFC5424 } from './codec/SyslogTime';

export type SyslogWireFormat = 'rfc3164' | 'rfc5424';
export type SyslogStreamFraming = 'octet-counting' | 'non-transparent';

export interface SyslogMessageSpec {
  readonly format: SyslogWireFormat;
  readonly facility: number;
  readonly severity: number;
  readonly epochMs: number;
  readonly offsetMinutes: number;
  readonly hostname: string;
  readonly appName: string;
  readonly procId: string | null;
  readonly msgId: string | null;
  readonly structuredData: readonly StructuredDataElement[];
  readonly message: string;
}

const SEVERITY_LONG_NAMES: Readonly<Record<string, number>> = { emergency: 0, critical: 2, informational: 6, error: 3, warn: 4 };

export function resolveFacility(name: string): number | null {
  const index = FACILITY_TEXT.indexOf(name.toLowerCase());
  return index >= 0 && index < 24 ? index : null;
}

export function resolveSeverity(name: string): number | null {
  const lower = name.toLowerCase();
  const index = SEVERITY_TEXT.indexOf(lower);
  return index >= 0 ? index : SEVERITY_LONG_NAMES[lower] ?? null;
}

export function buildSyslogMessage(spec: SyslogMessageSpec): string {
  const pri = priorityValue(spec.facility, spec.severity);
  if (spec.format === 'rfc3164') {
    const tag = spec.appName.slice(0, 32);
    return formatRfc3164({
      pri,
      timestamp: syslogTimeFromEpochMs(spec.epochMs, spec.offsetMinutes, 0, TIME_TYPE_RFC3164),
      hostname: spec.hostname,
      tag,
      ...(spec.procId === null ? {} : { pid: Number(spec.procId) }),
      content: spec.message,
    });
  }
  return formatRfc5424({
    pri,
    timestamp: syslogTimeFromEpochMs(spec.epochMs, spec.offsetMinutes, 6, TIME_TYPE_RFC5424),
    hostname: spec.hostname,
    appName: spec.appName,
    procId: spec.procId,
    msgId: spec.msgId,
    structuredData: spec.structuredData,
    message: spec.message,
  });
}

export function frameForStream(message: string, framing: SyslogStreamFraming): string {
  return framing === 'octet-counting' ? frameOctetCounted(message) : frameNonTransparent(message);
}
