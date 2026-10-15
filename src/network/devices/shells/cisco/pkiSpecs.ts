import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { CiscoSecurityConfig } from '../../router/security/CiscoSecurityConfig';
import type { IosCertificateServer, EnrollmentRecord } from '../../router/pki/IosCertificateServer';

export const PKI_SERVER_MODE = 'config-ca-server';
export const TRUSTPOINT_MODE = 'config-ca-trustpoint';

export interface PkiHost {
  security(): CiscoSecurityConfig;
  authenticate(name: string): string;
  enroll(name: string): string;
  requestCrl(name: string): string;
  clearCrls(): void;
  renderCrls(): string;
  selectTrustpoint(name: string): void;
  removeTrustpoint(name: string): void;
  importCertificate(name: string, form: string): string;
  exportPem(name: string, cipher: 'des' | '3des', phrase: string, destination: string | null): string;
  importPem(name: string, source: string, phrase: string | null, exportable: boolean): string;
  selectServer(name: string | null): void;
  selectedServer(): string | null;
}

const CONFIG = Object.freeze(['config']);
const SERVER_MODE = Object.freeze([PKI_SERVER_MODE]);
const EXEC = Object.freeze(['privileged']);
const SHOW = Object.freeze(['user', 'privileged']);

const TRUSTPOINT: ArgumentSpec = { name: 'trustpoint', type: 'WORD', description: 'Trustpoint name' };
const SERVER: ArgumentSpec = { name: 'server', type: 'WORD', description: 'Certificate server name' };
const DAYS: ArgumentSpec = { name: 'days', type: 'INT', range: [1, 3650], description: 'Lifetime in days' };
const HOURS: ArgumentSpec = { name: 'hours', type: 'INT', range: [1, 336], description: 'Lifetime in hours' };

const PEM_CIPHER: ArgumentSpec = {
  name: 'cipher', type: 'ENUM', description: 'Encryption of the exported private key',
  values: [
    { keyword: '3des', description: 'Encrypt the private key with Triple DES' },
    { keyword: 'des', description: 'Encrypt the private key with DES' },
  ],
};
const PHRASE: ArgumentSpec = { name: 'phrase', type: 'WORD', description: 'Password phrase protecting the private key' };
const PEM_IMPORT_OPTIONS = [
  { keyword: 'exportable', description: 'Allow the imported key to be exported again' },
  { keyword: 'password', description: 'Password phrase protecting the private key', argument: PHRASE },
] as const;

const DATE = (ms: number): string => new Date(ms).toUTCString().replace(/^\w+, /, '').replace(' GMT', ' UTC');

function requestRow(record: EnrollmentRecord): string {
  return [String(record.id).padEnd(8), record.state.padEnd(10), DATE(record.receivedMs).padEnd(26), record.subject].join('');
}

export function renderServerSummary(server: IosCertificateServer): string {
  const root = server.caCertificate;
  return [
    `Certificate Server ${server.name}:`,
    `    Status: ${server.isRunning ? 'enabled' : 'disabled'}`,
    `    State: ${server.isRunning ? 'enabled' : 'disabled'}`,
    `    Issuer name: ${server.issuerName ?? ''}`,
    `    CA cert fingerprint serial: ${root?.serialNumber ?? ''}`,
    `    Granting mode is: ${server.grantAuto ? 'auto' : 'manual'}`,
    `    Last certificate issued serial number (hex): ${server.granted().at(-1)?.certificate?.serialNumber ?? '0'}`,
    `    CA certificate expiration timer: ${root ? DATE(root.notAfter) : ''}`,
    `    Current primary storage dir: nvram:`,
    `    Database Level: Minimum - no cert data written to storage`,
  ].join('\n');
}

export function renderServerRequests(server: IosCertificateServer): string {
  const header = ['Enrollment Request Database:', '', 'Subordinate CA certificate requests:', 'ReqID  State      Fingerprint                      SubjectName', '--------------------------------------------------------------',
    '', 'RA certificate requests:', 'ReqID  State      Fingerprint                      SubjectName', '--------------------------------------------------------------',
    '', 'Router certificates requests:', 'ReqID  State     Fingerprint                      SubjectName', '--------------------------------------------------------------'];
  return [...header, ...server.enrollments.map(requestRow)].join('\n');
}

export function renderServerCertificates(server: IosCertificateServer): string {
  const rows = server.granted().map((r) => `${r.certificate!.serialNumber.padEnd(18)}${DATE(r.certificate!.notAfter).padEnd(26)}${r.subject}`);
  return ['Certificates Database:', 'Serial     Expires                   Subject', ...rows].join('\n');
}

export function renderServerCrl(server: IosCertificateServer): string {
  const crl = server.crl();
  if (!crl) return '';
  return [`Certificate Revocation List:`, `    Issuer: ${crl.issuer}`, `    This Update: ${DATE(crl.thisUpdate)}`, `    Next Update: ${DATE(crl.nextUpdate)}`,
    ...crl.revoked.map((entry) => `    Revoked Certificate: Serial Number: ${entry.serialNumber}`)].join('\n');
}

export function pkiSpecs(host: () => PkiHost): CommandSpec[] {
  const sec = (): CiscoSecurityConfig => host().security();
  const selected = (): IosCertificateServer | null => {
    const name = host().selectedServer();
    return name ? sec().pkiServers.get(name) ?? null : null;
  };
  const specs: CommandSpec[] = [];
  for (const family of ['pki', 'ca'] as const) {
    const where = family === 'pki' ? 'pki' : 'ca';
    const named = (id: string) => `${id}-${family}`;
    specs.push(
      {
        id: named('crypto-authenticate'),
        path: ['crypto', where, 'authenticate', TRUSTPOINT],
        description: 'Get the CA certificate and authenticate it',
        modes: CONFIG, minPrivilege: 15,
        run: (_s, args) => host().authenticate(args.trustpoint),
      },
      {
        id: named('crypto-crl-request'),
        path: ['crypto', where, 'crl', 'request', TRUSTPOINT],
        description: 'Request a new certificate revocation list from the certificate authority',
        modes: CONFIG, minPrivilege: 15,
        run: (_s, args) => host().requestCrl(args.trustpoint),
      },
      {
        id: named('show-crls'),
        path: ['show', 'crypto', where, 'crls'],
        description: 'Display the certificate revocation lists',
        modes: SHOW, minPrivilege: 1,
        run: () => host().renderCrls(),
      },
      {
        id: named('crypto-enroll'),
        path: ['crypto', where, 'enroll', TRUSTPOINT],
        description: 'Obtain a certificate from the certificate authority',
        modes: CONFIG, minPrivilege: 15,
        run: (_s, args) => host().enroll(args.trustpoint),
      },
      {
        id: named('clear-crls'),
        path: ['clear', 'crypto', where, 'crls'],
        description: 'Remove the certificate revocation list database',
        modes: EXEC, minPrivilege: 15,
        run: () => { host().clearCrls(); return ''; },
      },
      {
        id: named('crypto-server'),
        path: ['crypto', where, 'server', SERVER],
        description: 'Certificate server configuration',
        undoDescription: 'Remove the certificate server',
        modes: CONFIG, minPrivilege: 15,
        enters: PKI_SERVER_MODE,
        run: (_s, args) => { sec().ensurePkiServer(args.server); host().selectServer(args.server); return ''; },
        undo: (_s, args) => { sec().pkiServers.get(args.server)?.stop(); sec().pkiServers.delete(args.server); return ''; },
      },
      {
        id: named('crypto-server-grant'),
        path: ['crypto', where, 'server', SERVER, 'grant', {
          name: 'target', type: 'WORD', description: 'all, or the request id',
        }],
        description: 'Grant pending enrollment requests',
        modes: EXEC, minPrivilege: 15,
        run: (_s, args) => {
          const server = sec().pkiServers.get(args.server);
          if (!server) return `% Certificate server ${args.server} is not configured`;
          const target = args.target === 'all' ? 'all' : Number(args.target);
          if (target !== 'all' && !Number.isInteger(target)) return `% Invalid request id ${args.target}`;
          const count = server.grant(target);
          return count === 0 ? '% No pending enrollment request matches' : `% ${count} request(s) granted`;
        },
      },
      {
        id: named('crypto-server-reject'),
        path: ['crypto', where, 'server', SERVER, 'reject', {
          name: 'target', type: 'WORD', description: 'all, or the request id',
        }],
        description: 'Reject pending enrollment requests',
        modes: EXEC, minPrivilege: 15,
        run: (_s, args) => {
          const server = sec().pkiServers.get(args.server);
          if (!server) return `% Certificate server ${args.server} is not configured`;
          const target = args.target === 'all' ? 'all' : Number(args.target);
          if (target !== 'all' && !Number.isInteger(target)) return `% Invalid request id ${args.target}`;
          const count = server.reject(target);
          return count === 0 ? '% No pending enrollment request matches' : `% ${count} request(s) rejected`;
        },
      },
      {
        id: named('crypto-server-revoke'),
        path: ['crypto', where, 'server', SERVER, 'revoke', { name: 'serial', type: 'WORD', description: 'Certificate serial number (hex)' }],
        description: 'Revoke a certificate',
        modes: EXEC, minPrivilege: 15,
        run: (_s, args) => {
          const server = sec().pkiServers.get(args.server);
          if (!server) return `% Certificate server ${args.server} is not configured`;
          return server.revoke(args.serial) ? '' : `% Certificate with serial ${args.serial} was not issued by this server`;
        },
      },
      {
        id: named('show-server'),
        path: ['show', 'crypto', where, 'server'],
        description: 'Show the certificate server',
        modes: SHOW, minPrivilege: 1,
        run: () => [...sec().pkiServers.values()].map(renderServerSummary).join('\n') || '% Certificate server is not configured',
      },
      ...(['', 'requests', 'certificates', 'crl'] as const).map((view): CommandSpec => ({
        id: named(`show-server-${view || 'label'}`),
        path: ['show', 'crypto', where, 'server', SERVER, ...(view ? [view] : [])],
        description: view ? `Show the ${view === 'crl' ? 'revocation list' : view === 'requests' ? 'enrollment requests' : 'issued certificates'}` : 'Show one certificate server',
        modes: SHOW, minPrivilege: 1,
        run: (_s, args) => {
          const server = sec().pkiServers.get(args.server);
          if (!server) return `% Certificate server ${args.server} is not configured`;
          if (view === 'requests') return renderServerRequests(server);
          if (view === 'certificates') return renderServerCertificates(server);
          if (view === 'crl') return renderServerCrl(server);
          return renderServerSummary(server);
        },
      })),
      ...(['start', 'stop'] as const).map((action): CommandSpec => ({
        id: named(`crypto-server-${action}`),
        path: ['crypto', where, 'server', SERVER, action],
        description: action === 'start' ? 'Start the certificate server' : 'Stop the certificate server',
        modes: EXEC, minPrivilege: 15,
        run: (_s, args) => {
          const server = sec().pkiServers.get(args.server);
          if (!server) return `% Certificate server ${args.server} is not configured`;
          if (action === 'stop') { server.stop(); return ''; }
          return server.start() ?? '';
        },
      })),
      {
        id: named('crypto-server-unrevoke'),
        path: ['crypto', where, 'server', SERVER, 'unrevoke', { name: 'serial', type: 'WORD', description: 'Certificate serial number (hex)' }],
        description: 'Lift the revocation of a certificate',
        modes: EXEC, minPrivilege: 15,
        run: (_s, args) => {
          const server = sec().pkiServers.get(args.server);
          if (!server) return `% Certificate server ${args.server} is not configured`;
          return server.unrevoke(args.serial) ? '' : `% Certificate with serial ${args.serial} is not revoked`;
        },
      },
      {
        id: named('crypto-server-remove'),
        path: ['crypto', where, 'server', SERVER, 'remove', { name: 'target', type: 'WORD', description: 'all, or the request id' }],
        description: 'Remove enrollment requests from the database',
        modes: EXEC, minPrivilege: 15,
        run: (_s, args) => {
          const server = sec().pkiServers.get(args.server);
          if (!server) return `% Certificate server ${args.server} is not configured`;
          const target = args.target === 'all' ? 'all' : Number(args.target);
          if (target !== 'all' && !Number.isInteger(target)) return `% Invalid request id ${args.target}`;
          return server.remove(target) === 0 ? '% No enrollment request matches' : '';
        },
      },
      ...(['requests', 'crl'] as const).map((view): CommandSpec => ({
        id: named(`crypto-server-info-${view}`),
        path: ['crypto', where, 'server', SERVER, 'info', view],
        description: view === 'crl' ? 'Display the revocation list' : 'Display the enrollment requests',
        modes: EXEC, minPrivilege: 15,
        run: (_s, args) => {
          const server = sec().pkiServers.get(args.server);
          if (!server) return `% Certificate server ${args.server} is not configured`;
          return view === 'crl' ? renderServerCrl(server) : renderServerRequests(server);
        },
      })),
    );
  }
  specs.push(
    {
      id: 'crypto-pki-trustpoint',
      path: ['crypto', 'pki', 'trustpoint', TRUSTPOINT],
      description: 'Declare a PKI trustpoint',
      undoDescription: 'Remove a PKI trustpoint',
      modes: CONFIG, minPrivilege: 15,
      enters: TRUSTPOINT_MODE,
      run: (_s, args) => { sec().ensurePkiTrustpoint(args.trustpoint); host().selectTrustpoint(args.trustpoint); return ''; },
      undo: (_s, args) => { host().removeTrustpoint(args.trustpoint); return ''; },
    },
    {
      id: 'crypto-pki-import',
      path: ['crypto', 'pki', 'import', TRUSTPOINT, { name: 'form', type: 'REST', literal: 'LINE', description: 'Certificate format and source' }],
      description: 'Import certificate',
      modes: CONFIG, minPrivilege: 15,
      run: (_s, args) => host().importCertificate(args.trustpoint, args.form),
    },
    {
      id: 'crypto-pki-export-pem-terminal',
      path: ['crypto', 'pki', 'export', TRUSTPOINT, 'pem', 'terminal', PEM_CIPHER, 'password', PHRASE],
      description: 'Export the trustpoint certificates and key as PEM on the terminal',
      modes: CONFIG, minPrivilege: 15,
      run: (_s, args) => host().exportPem(args.trustpoint, args.cipher as 'des' | '3des', args.phrase, null),
    },
    {
      id: 'crypto-pki-export-pem-url',
      path: ['crypto', 'pki', 'export', TRUSTPOINT, 'pem', 'url', { name: 'destination', type: 'WORD', description: 'Destination URL' }, PEM_CIPHER, 'password', PHRASE],
      description: 'Export the trustpoint certificates and key as PEM to a URL',
      modes: CONFIG, minPrivilege: 15,
      run: (_s, args) => host().exportPem(args.trustpoint, args.cipher as 'des' | '3des', args.phrase, args.destination),
    },
    {
      id: 'crypto-pki-import-pem-url',
      path: ['crypto', 'pki', 'import', TRUSTPOINT, 'pem', 'url', { name: 'source', type: 'WORD', description: 'Source URL' }],
      description: 'Import PEM certificates and key from a URL',
      modes: CONFIG, minPrivilege: 15,
      options: PEM_IMPORT_OPTIONS,
      run: (_s, args) => host().importPem(args.trustpoint, args.source, args.phrase ?? null, args.exportable !== undefined),
    },
    {
      id: 'crypto-pki-import-pem-terminal',
      path: ['crypto', 'pki', 'import', TRUSTPOINT, 'pem', 'terminal'],
      description: 'Paste PEM certificates and key on the terminal',
      modes: CONFIG, minPrivilege: 15,
      options: PEM_IMPORT_OPTIONS,
      run: () => '% Pasting PEM text needs an interactive terminal session',
    },
    {
      id: 'ca-server-issuer-name',
      path: ['issuer-name', { name: 'dn', type: 'REST', description: 'Distinguished name of the CA' }],
      description: 'Set the issuer name of the certificate server',
      modes: SERVER_MODE, minPrivilege: 15,
      run: (_s, args) => {
        const server = selected();
        if (server) {
          if (server.isRunning) return '% Cannot change the issuer name while the server is enabled';
          server.issuerName = args.dn;
        }
        return '';
      },
    },
    {
      id: 'ca-server-grant-auto',
      path: ['grant', 'auto'],
      description: 'Grant every enrollment request automatically',
      undoDescription: 'Hold requests until an operator grants them',
      modes: SERVER_MODE, minPrivilege: 15,
      run: () => { const server = selected(); if (server) server.grantAuto = true; return ''; },
      undo: () => { const server = selected(); if (server) server.grantAuto = false; return ''; },
    },
    {
      id: 'ca-server-lifetime-certificate',
      path: ['lifetime', 'certificate', DAYS],
      description: 'Lifetime of issued certificates',
      modes: SERVER_MODE, minPrivilege: 15,
      run: (_s, args) => { const server = selected(); if (server) server.lifetimes.certificateDays = Number(args.days); return ''; },
      undo: () => { const server = selected(); if (server) server.lifetimes.certificateDays = 365; return ''; },
      undoOmitsArguments: true,
    },
    {
      id: 'ca-server-lifetime-ca-certificate',
      path: ['lifetime', 'ca-certificate', DAYS],
      description: 'Lifetime of the CA certificate',
      modes: SERVER_MODE, minPrivilege: 15,
      run: (_s, args) => { const server = selected(); if (server) server.lifetimes.caCertificateDays = Number(args.days); return ''; },
      undo: () => { const server = selected(); if (server) server.lifetimes.caCertificateDays = 1825; return ''; },
      undoOmitsArguments: true,
    },
    {
      id: 'ca-server-lifetime-crl',
      path: ['lifetime', 'crl', HOURS],
      description: 'Lifetime of the revocation list',
      modes: SERVER_MODE, minPrivilege: 15,
      run: (_s, args) => { const server = selected(); if (server) server.lifetimes.crlHours = Number(args.hours); return ''; },
      undo: () => { const server = selected(); if (server) server.lifetimes.crlHours = 168; return ''; },
      undoOmitsArguments: true,
    },
    {
      id: 'ca-server-cdp-url',
      path: ['cdp-url', { name: 'url', type: 'WORD', description: 'CRL distribution point' }],
      description: 'Set the CRL distribution point of issued certificates',
      modes: SERVER_MODE, minPrivilege: 15,
      run: (_s, args) => { const server = selected(); if (server) server.cdpUrl = args.url; return ''; },
      undo: () => { const server = selected(); if (server) server.cdpUrl = null; return ''; },
      undoOmitsArguments: true,
    },
    {
      id: 'ca-server-shutdown',
      path: ['shutdown'],
      description: 'Shut the certificate server down',
      undoDescription: 'Enable the certificate server',
      modes: SERVER_MODE, minPrivilege: 15,
      run: () => { selected()?.stop(); return ''; },
      undo: () => selected()?.start() ?? '',
    },
  );
  return specs;
}
