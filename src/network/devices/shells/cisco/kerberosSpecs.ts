import type { CommandSpec } from '@/cli/CommandTable';
import { IPAddress } from '@/network/core/types';
import type { CiscoSecurityConfig } from '../../router/security/CiscoSecurityConfig';
import {
  KERBEROS_DEFAULT_PORT, type KerberosPreauth,
} from '../../router/security/KerberosConfig';

const MODES = ['config'] as const;

export interface KerberosHost {
  security(): CiscoSecurityConfig;
}

const PREAUTH_VALUES: ReadonlyArray<{ keyword: KerberosPreauth; description: string }> = [
  { keyword: 'encrypted-kerberos-timestamp', description: 'Use RFC 1510 kerberos timestamp as quick authentication method' },
  { keyword: 'encrypted-unix-timestamp', description: 'Use encrypted unix timestamp as quick authentication method' },
  { keyword: 'none', description: 'Do not use kerberos preauthentication' },
];

export function kerberosSpecs(ctx: () => KerberosHost): CommandSpec[] {
  const kerberos = () => ctx().security().kerberos;

  return [
    {
      id: 'kerberos-local-realm',
      path: ['kerberos', 'local-realm', { name: 'realm', type: 'WORD', description: 'The name of the default Kerberos realm' }],
      description: 'Specify the Kerberos realm of this router',
      undoDescription: 'Remove the Kerberos realm of this router',
      modes: MODES, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { kerberos().localRealm = String(args.realm); return ''; },
      undo: () => { kerberos().localRealm = undefined; return ''; },
    },
    {
      id: 'kerberos-realm',
      path: ['kerberos', 'realm',
        { name: 'domain', type: 'WORD', description: 'Name of a DNS domain (leading dot) or host' },
        { name: 'realm', type: 'WORD', description: 'Name of the Kerberos realm' }],
      description: 'Map a hostname or DNS domain to a Kerberos realm',
      undoDescription: 'Remove a Kerberos realm map',
      modes: MODES, minPrivilege: 15,
      run: (_s, args) => { kerberos().realmMap.set(String(args.domain), String(args.realm)); return ''; },
      undo: (_s, args) => {
        const cfg = kerberos();
        if (cfg.realmMap.get(String(args.domain)) === String(args.realm)) cfg.realmMap.delete(String(args.domain));
        return '';
      },
    },
    {
      id: 'kerberos-server',
      path: ['kerberos', 'server',
        { name: 'realm', type: 'WORD', description: 'Name of the Kerberos realm' },
        { name: 'address', type: 'IP_ADDR', description: 'IP address of the host functioning as Kerberos server' },
        { name: 'port', type: 'INT', optional: true, range: [1, 65535], description: 'Port the KDC monitors (defaults to 88)' }],
      description: 'Specify the location of the Kerberos server for a realm',
      undoDescription: 'Remove a Kerberos server for a realm',
      modes: MODES, minPrivilege: 15,
      run: (_s, args) => {
        kerberos().addServer(String(args.realm), {
          host: new IPAddress(String(args.address)).toString(),
          port: args.port === undefined ? KERBEROS_DEFAULT_PORT : Number(args.port),
        });
        return '';
      },
      undo: (_s, args) => {
        kerberos().removeServer(String(args.realm), new IPAddress(String(args.address)).toString());
        return '';
      },
    },
    {
      id: 'kerberos-preauth',
      path: ['kerberos', 'preauth', {
        name: 'method', type: 'ENUM', values: PREAUTH_VALUES,
        description: 'Preauthentication method',
      }],
      description: 'Specify a preauthentication method to use with the KDC',
      undoDescription: 'Disable Kerberos preauthentication',
      modes: MODES, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { kerberos().preauth = args.method as KerberosPreauth; return ''; },
      undo: () => { kerberos().preauth = 'none'; return ''; },
    },
    {
      id: 'kerberos-retry',
      path: ['kerberos', 'retry', { name: 'number', type: 'INT', range: [1, 5], description: 'Number of retry attempts' }],
      description: 'Configure the number of retry attempts for KDC sessions',
      undoDescription: 'Restore the default of 4 retries',
      modes: MODES, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { kerberos().retry = Number(args.number); return ''; },
      undo: () => { kerberos().retry = undefined; return ''; },
    },
    {
      id: 'kerberos-timeout',
      path: ['kerberos', 'timeout', { name: 'seconds', type: 'INT', range: [1, 10], description: 'Timeout, in seconds, for KDC requests' }],
      description: 'Configure the timeout for KDC requests',
      undoDescription: 'Restore the default of 5 seconds',
      modes: MODES, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { kerberos().timeout = Number(args.seconds); return ''; },
      undo: () => { kerberos().timeout = undefined; return ''; },
    },
    {
      id: 'kerberos-processes',
      path: ['kerberos', 'processes', { name: 'number', type: 'INT', range: [1, 10], description: 'Number of processes' }],
      description: 'Set the number of Kerberos processes servicing requests',
      undoDescription: 'Restore the default of 1 process',
      modes: MODES, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { kerberos().processes = Number(args.number); return ''; },
      undo: () => { kerberos().processes = undefined; return ''; },
    },
    {
      id: 'kerberos-instance-map',
      path: ['kerberos', 'instance', 'map',
        { name: 'instance', type: 'WORD', description: 'Name of a Kerberos instance' },
        { name: 'level', type: 'INT', range: [0, 15], description: 'Privilege level' }],
      description: 'Map Kerberos instances to IOS privilege levels',
      undoDescription: 'Remove a Kerberos instance map',
      modes: MODES, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { kerberos().instanceMap.set(String(args.instance), Number(args.level)); return ''; },
      undo: (_s, args) => { kerberos().instanceMap.delete(String(args.instance)); return ''; },
    },
    {
      id: 'kerberos-password',
      path: ['kerberos', 'password', { name: 'text', type: 'WORD', description: 'The password shared with the KDC' }],
      description: 'Set the password shared with the key distribution center',
      undoDescription: 'Disable the configured password',
      modes: MODES, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { kerberos().password = String(args.text); return ''; },
      undo: () => { kerberos().password = undefined; return ''; },
    },
    {
      id: 'kerberos-credentials-forward',
      path: ['kerberos', 'credentials', 'forward'],
      description: "Forward users' Kerberos credentials after authentication",
      undoDescription: 'Stop forwarding Kerberos credentials',
      modes: MODES, minPrivilege: 15,
      run: () => { kerberos().credentialsForward = true; return ''; },
      undo: () => { kerberos().credentialsForward = false; return ''; },
    },
    {
      id: 'kerberos-clients-mandatory',
      path: ['kerberos', 'clients', 'mandatory'],
      description: 'Make rsh, rcp, rlogin and telnet fail without Kerberos',
      undoDescription: 'Make Kerberos optional for the network clients',
      modes: MODES, minPrivilege: 15,
      run: () => { kerberos().clientsMandatory = true; return ''; },
      undo: () => { kerberos().clientsMandatory = false; return ''; },
    },
    {
      id: 'kerberos-srvtab-entry',
      path: ['kerberos', 'srvtab', 'entry',
        { name: 'principal', type: 'WORD', description: 'A service on the router' },
        { name: 'type', type: 'INT', description: 'Version of the Kerberos SRVTAB' },
        { name: 'timestamp', type: 'INT', description: 'Date and time the SRVTAB entry was created' },
        { name: 'kvno', type: 'WORD', description: 'key-version' },
        { name: 'number', type: 'INT', description: 'Version of the encryption key format' },
        { name: 'ktype', type: 'INT', description: 'Type of encryption used' },
        { name: 'klength', type: 'INT', description: 'Length, in bytes, of the encryption key' },
        { name: 'key', type: 'WORD', description: 'Secret key the router shares with the KDC' }],
      description: 'Specify a krb5 SRVTAB entry',
      undoDescription: 'Remove a SRVTAB entry',
      modes: MODES, minPrivilege: 15,
      run: (_s, args) => {
        const entry = `${args.principal} ${args.type} ${args.timestamp} ${args.kvno} ${args.number} ${args.ktype} ${args.klength} ${args.key}`;
        kerberos().srvtabs.set(`${args.principal} ${args.type}`, entry);
        return '';
      },
      undo: (_s, args) => { kerberos().srvtabs.delete(`${args.principal} ${args.type}`); return ''; },
    },
  ];
}
