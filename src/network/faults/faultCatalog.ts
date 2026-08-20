/**
 * faultCatalog — static presentation data per fault code.
 *
 * Separated from the registry so that "what does this code mean, and what
 * do I type to fix it" is a lookup table a contributor can extend without
 * touching any logic. Severity lives here as the DEFAULT; a projection may
 * override it when the consequence differs (docs/PRD-Pannes.md §5, P7).
 */

import type { FaultCatalogEntry, FaultCode } from './FaultTypes';

export const FAULT_CATALOG: Readonly<Record<FaultCode, FaultCatalogEntry>> = {
  LINK_DOWN: {
    category: 'physical',
    severity: 'critical',
    label: 'Link down',
    investigate: 'ip link show',
    remedy: 'Reconnect the cable, or bring the peer port back up.',
  },
  LINK_ADMIN_DOWN: {
    category: 'physical',
    severity: 'notice',
    label: 'Interface administratively down',
    investigate: 'ip link show',
    remedy: 'ip link set <iface> up',
  },
  LINK_ERRDISABLE: {
    category: 'switching',
    severity: 'critical',
    label: 'Port err-disabled',
    investigate: 'show interfaces status err-disabled',
    remedy: 'shutdown, then no shutdown',
  },
  DEVICE_POWERED_OFF: {
    category: 'power',
    severity: 'notice',
    label: 'Device powered off',
    remedy: 'Power the device back on.',
  },
  SERVICE_FAILED: {
    category: 'service',
    severity: 'critical',
    label: 'Service failed',
    investigate: 'systemctl status <unit>',
    remedy: 'Fix the cause, then systemctl restart <unit>',
  },
  SERVICE_START_LIMITED: {
    category: 'service',
    severity: 'critical',
    label: 'Service start limit hit',
    investigate: 'systemctl status <unit>',
    remedy: 'systemctl reset-failed <unit>, then systemctl start <unit>',
  },
};

export function catalogEntry(code: FaultCode): FaultCatalogEntry {
  return FAULT_CATALOG[code];
}
