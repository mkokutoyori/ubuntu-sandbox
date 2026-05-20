/**
 * Windows feature gates — declarative service-dependency checks used by
 * every command that needs a Windows service to be Running before it
 * can succeed (e.g. `ipconfig /renew` needs Dhcp, `nslookup` needs
 * Dnscache, `netsh advfirewall` needs mpssvc).
 *
 * Centralising the error formatting here means each command stays a
 * one-line check and the wording matches real cmd.exe / PowerShell.
 */

import type { WinCommandContext } from './WinCommandExecutor';

/** Windows error message templates used when a service-gate fails. */
const ERRORS = {
  /** sc.exe / NET HELPMSG 1058: ERROR_SERVICE_DISABLED. */
  serviceNotRunning: (svc: string) =>
    `The ${svc} service is not running.\nMore help is available by typing NET HELPMSG 2185.`,
  /** Per `ipconfig /renew` when Dhcp is stopped. */
  dhcpStopped: () =>
    `An error occurred while renewing interface : The DHCP Client Service is not running.`,
  /** Per `nslookup` when Dnscache is stopped or no DNS configured. */
  dnsUnavailable: (host: string) =>
    `*** Can't find ${host}: No DNS servers available`,
  /** Per `netsh advfirewall` when mpssvc is stopped. */
  firewallStopped: () =>
    `The Windows Firewall service is not running. (mpssvc)`,
  /** Per `wevtutil` when the EventLog service is stopped. */
  eventLogStopped: () =>
    `Failed to query events. The Windows Event Log service is not running.`,
  /** Per `net use` when LanmanWorkstation is stopped. */
  workstationStopped: () =>
    `The Workstation service has not been started.\n\nMore help is available by typing NET HELPMSG 2185.`,
  /** Per `net share` when LanmanServer is stopped. */
  serverStopped: () =>
    `The Server service is not started.\n\nMore help is available by typing NET HELPMSG 2138.`,
  /** Per `schtasks` when the Schedule service is stopped. */
  scheduleStopped: () =>
    `ERROR: The Task Scheduler service is not running.`,
  /** Per `print` / printer commands when Spooler is stopped. */
  spoolerStopped: () =>
    `Print Spooler service is not running. Use 'net start spooler' to start it.`,
} as const;

/** Map a service name to the cmd.exe-style refusal it should emit. */
type ServiceErrorKey = keyof typeof ERRORS;

const SERVICE_TO_ERROR: Record<string, ServiceErrorKey> = {
  Dhcp:                'dhcpStopped',
  Dnscache:            'dnsUnavailable',
  mpssvc:              'firewallStopped',
  EventLog:            'eventLogStopped',
  LanmanWorkstation:   'workstationStopped',
  LanmanServer:        'serverStopped',
  Schedule:            'scheduleStopped',
  Spooler:             'spoolerStopped',
};

export interface GateOutcome { ok: boolean; error: string }

/**
 * Check that the named service is Running on this Windows device.
 *
 * Returns `{ ok: true, error: '' }` on pass, or `{ ok: false, error }`
 * with the right Windows-style refusal line. `templateArg` is forwarded
 * to error templates that need an interpolation (host name for DNS, …).
 */
export function requireWindowsService(
  ctx: WinCommandContext,
  service: string,
  templateArg?: string,
): GateOutcome {
  if (ctx.isServiceRunning(service)) return { ok: true, error: '' };
  const key = SERVICE_TO_ERROR[service];
  const builder = key ? ERRORS[key] : null;
  const error = builder
    ? (templateArg !== undefined ? (builder as (s: string) => string)(templateArg)
                                 : (builder as () => string)())
    : ERRORS.serviceNotRunning(service);
  return { ok: false, error };
}

/** Check multiple services in one shot; the first failure wins. */
export function requireWindowsServices(
  ctx: WinCommandContext,
  services: string[],
): GateOutcome {
  for (const s of services) {
    const r = requireWindowsService(ctx, s);
    if (!r.ok) return r;
  }
  return { ok: true, error: '' };
}
