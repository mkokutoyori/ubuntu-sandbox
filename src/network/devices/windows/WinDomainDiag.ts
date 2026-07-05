/**
 * Domain diagnostic commands: `nltest /dsgetdc:` and `dcdiag` (basic
 * checks) from PRD-Windows-Server.md §5 P6; `klist` now reflects the real
 * `KerberosTicketCache` populated by a genuine AS/TGS exchange
 * (PRD-Windows-Server-Advanced.md §5 P2) rather than a cosmetic canned
 * string.
 */

import type { DomainMembership } from './domain/DomainTypes';
import type { KerberosTicketCache } from '@/network/kerberos/KerberosTicketCache';
import { ticketFlagsToHex } from '@/network/kerberos/codec';
import type { TicketFlags } from '@/network/kerberos/types';

// ─── nltest ───────────────────────────────────────────────────────────────

export interface NltestContext {
  domainMembership: DomainMembership | null;
  /** Real TCP/389 reachability probe against the DC address. */
  probeDc: (address: string) => boolean;
}

export function cmdNltest(ctx: NltestContext, args: string[]): string {
  const dsgetdc = args.find(a => a.toLowerCase().startsWith('/dsgetdc:'));
  if (!dsgetdc) {
    return 'NLTEST usage: NLTEST [/DSGETDC:domain]';
  }
  const domain = dsgetdc.slice('/dsgetdc:'.length);
  if (!ctx.domainMembership || ctx.domainMembership.dnsName.toLowerCase() !== domain.toLowerCase()) {
    return `Getting DC name failed: Status = 1355 0x54b ERROR_NO_SUCH_DOMAIN`;
  }
  if (!ctx.probeDc(ctx.domainMembership.dcAddress)) {
    return `Getting DC name failed: Status = 1722 0x6ba RPC_S_SERVER_UNAVAILABLE`;
  }
  return [
    `           DC: \\\\${ctx.domainMembership.dcAddress}`,
    `      Address: \\\\${ctx.domainMembership.dcAddress}`,
    `     Dom Name: ${ctx.domainMembership.dnsName}`,
    ` Dc Site Name: Default-First-Site-Name`,
    `The command completed successfully`,
  ].join('\n');
}

// ─── dcdiag ───────────────────────────────────────────────────────────────

export interface DcdiagContext {
  hostname: string;
  dnsName: string;
  isDc: boolean;
  servicesRunning: { ntds: boolean; netlogon: boolean; kdc: boolean };
  sysvolShareExists: boolean;
}

export function cmdDcdiag(ctx: DcdiagContext): string {
  if (!ctx.isDc) {
    return 'Directory Server Diagnosis\n\nDcdiag can only be run on a domain controller.';
  }
  const test = (name: string, ok: boolean, server = ctx.hostname): string =>
    `      Starting test: ${name}\n         ${'.'.repeat(25)} ${server} ${ok ? 'passed' : 'failed'} test ${name}`;

  return [
    'Directory Server Diagnosis',
    '',
    'Performing initial setup:',
    `   * Verifying that the local machine ${ctx.hostname}, is a DC.`,
    `   * Connecting to directory service on server ${ctx.hostname}.`,
    '   Done gathering initial info.',
    '',
    'Doing initial required tests',
    '',
    `   Testing server: Default-First-Site-Name\\${ctx.hostname}`,
    test('Connectivity', true),
    '',
    'Doing primary tests',
    '',
    `   Testing server: Default-First-Site-Name\\${ctx.hostname}`,
    test('Advertising', ctx.servicesRunning.netlogon),
    test('NetLogons', ctx.servicesRunning.netlogon),
    test('SysVolCheck', ctx.sysvolShareExists),
    test('KdcEvent', ctx.servicesRunning.kdc),
    '',
    `Running enterprise tests on : ${ctx.dnsName}`,
    test('LocatorCheck', ctx.servicesRunning.netlogon, ctx.dnsName),
  ].join('\n');
}

// ─── klist ────────────────────────────────────────────────────────────────

export interface KlistContext {
  ticketCache: KerberosTicketCache;
}

const FLAG_NAMES: ReadonlyArray<[keyof TicketFlags, string]> = [
  ['forwardable', 'forwardable'], ['forwarded', 'forwarded'],
  ['proxiable', 'proxiable'], ['proxy', 'proxy'],
  ['renewable', 'renewable'], ['initial', 'initial'],
  ['preAuthent', 'pre_authent'], ['hwAuthent', 'hw_authent'],
];

function formatFlags(flags: TicketFlags): string {
  const names = FLAG_NAMES.filter(([key]) => flags[key]).map(([, name]) => name);
  return `${ticketFlagsToHex(flags)} -> ${names.join(' ')}`;
}

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toUTCString();
}

/** `klist` — real ticket cache state (PRD-Windows-Server-Advanced.md §5 P2), populated by an actual AS/TGS exchange rather than a canned string. */
export function cmdKlist(ctx: KlistContext): string {
  const tickets = ctx.ticketCache.list();
  if (tickets.length === 0) {
    return 'Current LogonId is 0:0x3e7\n\nCached Tickets: (0)\n';
  }
  const lines = ['Current LogonId is 0:0x186a5', '', `Cached Tickets: (${tickets.length})`, ''];
  tickets.forEach((t, i) => {
    const e = t.encKdcRepPart;
    lines.push(
      `#${i}>     Client: ${t.clientPrincipal}`,
      `        Server: ${t.serverPrincipal}`,
      `        KerbTicket Encryption Type: AES-256-CTS-HMAC-SHA1-96`,
      `        Ticket Flags ${formatFlags(e.flags)}`,
      `        Start Time: ${formatTime(e.starttime ?? e.authtime)}`,
      `        End Time:   ${formatTime(e.endtime)}`,
      `        Renew Time: ${e.renewTill !== undefined ? formatTime(e.renewTill) : 'none'}`,
      '        Session Key Type: AES-256-CTS-HMAC-SHA1-96',
      '',
    );
  });
  return lines.join('\n').trimEnd() + '\n';
}
