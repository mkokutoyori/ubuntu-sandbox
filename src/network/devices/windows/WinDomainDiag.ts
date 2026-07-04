/**
 * Domain diagnostic commands (PRD-Windows-Server.md §5 P6): `nltest
 * /dsgetdc:`, `dcdiag` (basic checks), `klist` (simulated tickets — real
 * Kerberos ticket cryptography is out of scope per PRD §2.2).
 */

import type { DomainMembership, DomainSession } from './domain/DomainTypes';

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
  domainSession: DomainSession | null;
  dnsName: string | null;
}

export function cmdKlist(ctx: KlistContext): string {
  if (!ctx.domainSession || !ctx.dnsName) {
    return 'Current LogonId is 0:0x3e7\n\nCached Tickets: (0)\n';
  }
  const realm = ctx.dnsName.toUpperCase();
  return [
    'Current LogonId is 0:0x186a5',
    '',
    'Cached Tickets: (1)',
    '',
    `#0>     Client: ${ctx.domainSession.sam} @ ${realm}`,
    `        Server: krbtgt/${realm} @ ${realm}`,
    '        KerbTicket Encryption Type: AES-256-CTS-HMAC-SHA1-96',
    '        Ticket Flags 0x40e10000 -> forwardable renewable initial pre_authent name_canonicalize',
    '        Start Time: (simulated)',
    '        End Time:   (simulated)',
    '        Renew Time: (simulated)',
    '        Session Key Type: AES-256-CTS-HMAC-SHA1-96',
  ].join('\n');
}
