import {
  address, choice, count, enable, refList, reference, text, word,
  type FortiObjectView, type FortiTableSpec,
} from './types';

const NO_FSSO = 'Fortinet Single Sign-On reads the logon events of a Windows '
  + 'domain controller through a collector agent. Neither the agent nor the '
  + 'event source exists here, so no identity could ever be learned.';

const NO_SAML = 'SAML needs an identity provider, signed assertions and a '
  + 'browser redirection dance; none of the three exists here.';

const USER_TYPES = [
  { keyword: 'password', description: 'Authenticate against the local password.' },
  { keyword: 'radius', description: 'Authenticate against a RADIUS server.' },
  { keyword: 'tacacs+', description: 'Authenticate against a TACACS+ server.' },
  { keyword: 'ldap', description: 'Authenticate against an LDAP server.' },
];

export const USER_LOCAL: FortiTableSpec = {
  path: ['user', 'local'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'authgrp',
  renderOrder: 500,
  help: 'Configure local users.',
  attributes: [
    { ...word('name', 'User name.'), readOnly: true },
    choice('type', 'Authentication method.', USER_TYPES, 'password'),
    { ...text('passwd', 'User password.'), quoted: true, secret: true },
    reference('radius-server', 'Name of the RADIUS server.', ['user radius']),
    reference('tacacs+-server', 'Name of the TACACS+ server.', ['user tacacs+']),
    reference('ldap-server', 'Name of the LDAP server.', ['user ldap']),
    enable('status', 'Enable/disable this user.', true),
    text('email-to', 'Two-factor recipient address.'),
  ],
  onCommit(object, context) {
    context.device.applyLocalUser({
      name: object.key,
      type: object.effective('type')[0] ?? 'password',
      password: object.effective('passwd')[0],
      server: serverOf(object),
      enabled: object.effective('status')[0] !== 'disable',
      emailTo: object.effective('email-to')[0] || undefined,
    });
  },
  onDelete(key, context) {
    context.device.removeLocalUser(key);
  },
};

export const USER_GROUP: FortiTableSpec = {
  path: ['user', 'group'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'authgrp',
  renderOrder: 510,
  help: 'Configure user groups.',
  attributes: [
    { ...word('name', 'Group name.'), readOnly: true },
    choice('group-type', 'Set the group to be for firewall or guest use.', [
      { keyword: 'firewall', description: 'Firewall authentication group.' },
      { keyword: 'guest', description: 'Guest management group.' },
    ], 'firewall'),
    refList('member', 'Names of the users or servers in the group.',
      ['user local', 'user radius', 'user tacacs+', 'user ldap']),
    count('authtimeout', 'Authentication timeout in minutes, 0 inherits.', 0, 43200, 0),
  ],
  children: [
    {
      path: ['match'],
      kind: 'table',
      keyType: 'integer',
      ordered: true,
      scope: 'vdom',
      accessGroup: 'authgrp',
      renderOrder: 511,
      help: 'Group matches for remote servers.',
      attributes: [
        {
          name: 'id', help: 'ID.', quoted: false, readOnly: true,
          parts: [{ name: 'id', type: 'INT', description: 'ID.', range: [0, 65535] }],
        },
        reference('server-name', 'Name of the remote authentication server.',
          ['user radius', 'user tacacs+', 'user ldap']),
        { ...text('group-name', 'Name of the remote group.'), quoted: true },
      ],
      onCommit() {},
    },
  ],
  onCommit(object, context) {
    context.device.applyUserGroup({
      name: object.key,
      groupType: object.effective('group-type')[0] ?? 'firewall',
      members: [...object.effective('member')],
      matches: object.childEntries('match').map(entry => ({
        id: entry.key,
        serverName: field(entry, 'server-name'),
        groupName: field(entry, 'group-name'),
      })),
      authTimeoutMin: Number.parseInt(object.effective('authtimeout')[0] ?? '0', 10),
    });
  },
  onDelete(key, context) {
    context.device.removeUserGroup(key);
  },
};

export const USER_RADIUS: FortiTableSpec = {
  path: ['user', 'radius'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'authgrp',
  renderOrder: 520,
  help: 'Configure RADIUS server entries.',
  attributes: [
    { ...word('name', 'RADIUS server entry name.'), readOnly: true },
    address('server', 'Primary RADIUS server IP address.'),
    {
      ...text('secret', 'Pre-shared secret to access the RADIUS server.'),
      quoted: true, secret: true,
    },
    count('radius-port', 'RADIUS service port number.', 0, 65535, 1812),
    choice('auth-type', 'Authentication methods.', [
      { keyword: 'auto', description: 'Try PAP, then MS-CHAPv2, then CHAP.' },
      { keyword: 'pap', description: 'PAP only.' },
      { keyword: 'chap', description: 'CHAP only.' },
    ], 'auto'),
  ],
  onCommit(object, context) {
    context.device.applyRemoteAuthServer({
      name: object.key,
      kind: 'radius',
      address: object.effective('server')[0] ?? '',
      secret: object.effective('secret')[0] ?? '',
      port: Number.parseInt(object.effective('radius-port')[0] ?? '1812', 10),
      authType: object.effective('auth-type')[0],
    });
  },
  onDelete(key, context) {
    context.device.removeRemoteAuthServer(key);
  },
};

export const USER_TACACS: FortiTableSpec = {
  path: ['user', 'tacacs+'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'authgrp',
  renderOrder: 530,
  help: 'Configure TACACS+ server entries.',
  attributes: [
    { ...word('name', 'TACACS+ server entry name.'), readOnly: true },
    address('server', 'Primary TACACS+ server IP address.'),
    { ...text('key', 'Key to access the primary server.'), quoted: true },
    count('port', 'Port number of the TACACS+ server.', 1, 65535, 49),
    choice('authen-type', 'Authentication type.', [
      { keyword: 'auto', description: 'Try PAP, then MS-CHAP, then CHAP.' },
      { keyword: 'ascii', description: 'ASCII.' },
      { keyword: 'pap', description: 'PAP.' },
      { keyword: 'chap', description: 'CHAP.' },
    ], 'auto'),
  ],
  onCommit(object, context) {
    context.device.applyRemoteAuthServer({
      name: object.key,
      kind: 'tacacs+',
      address: object.effective('server')[0] ?? '',
      secret: object.effective('key')[0] ?? '',
      port: Number.parseInt(object.effective('port')[0] ?? '49', 10),
      authType: object.effective('authen-type')[0],
    });
  },
  onDelete(key, context) {
    context.device.removeRemoteAuthServer(key);
  },
};

export const USER_LDAP: FortiTableSpec = {
  path: ['user', 'ldap'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'authgrp',
  renderOrder: 540,
  help: 'Configure LDAP server entries.',
  attributes: [
    { ...word('name', 'LDAP server entry name.'), readOnly: true },
    address('server', 'LDAP server CN domain name or IP.'),
    count('port', 'Port to be used for communication with the LDAP server.',
      1, 65535, 389),
    { ...text('dn', 'Distinguished name used to look up entries.'), quoted: true },
    { ...text('cnid', 'Common name identifier.'), quoted: false },
    choice('type', 'Authentication type for LDAP searches.', [
      { keyword: 'simple', description: 'Bind directly with the user DN.' },
      { keyword: 'regular', description: 'Bind with a service account, then search.' },
      { keyword: 'anonymous', description: 'Bind anonymously, then search.' },
    ], 'simple'),
    { ...text('username', 'Username for a regular bind.'), quoted: true },
    { ...text('password', 'Password for a regular bind.'), quoted: true, secret: true },
  ],
  onCommit(object, context) {
    context.device.applyLdapServer({
      name: object.key,
      address: object.effective('server')[0] ?? '',
      port: Number.parseInt(object.effective('port')[0] ?? '389', 10),
      baseDn: object.effective('dn')[0] ?? '',
      cnid: object.effective('cnid')[0] || 'cn',
      bindType: object.effective('type')[0] ?? 'simple',
      username: object.effective('username')[0] || undefined,
      password: object.effective('password')[0] || undefined,
    });
  },
  onDelete(key, context) {
    context.device.removeRemoteAuthServer(key);
  },
};

export const USER_FSSO: FortiTableSpec = {
  path: ['user', 'fsso'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'authgrp',
  renderOrder: 541,
  help: 'Configure Fortinet Single Sign On agents.',
  attributes: [
    { ...word('name', 'FSSO agent name.'), unimplemented: NO_FSSO },
  ],
  onCommit() {},
};

export const USER_SAML: FortiTableSpec = {
  path: ['user', 'saml'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'authgrp',
  renderOrder: 542,
  help: 'Configure SAML service provider entries.',
  attributes: [
    { ...word('name', 'SAML entry name.'), unimplemented: NO_SAML },
  ],
  onCommit() {},
};

export const USER_SETTING: FortiTableSpec = {
  path: ['user', 'setting'],
  kind: 'object',
  scope: 'vdom',
  accessGroup: 'authgrp',
  renderOrder: 550,
  help: 'Configure user authentication setting.',
  attributes: [
    count('auth-timeout', 'Authentication timeout in minutes.', 1, 1440, 5),
    choice('auth-timeout-type', 'How the timeout is counted.', [
      { keyword: 'idle-timeout', description: 'Reset on traffic.' },
      { keyword: 'hard-timeout', description: 'Absolute, from authentication.' },
      { keyword: 'new-session', description: 'Reset on a new session.' },
    ], 'idle-timeout'),
    enable('auth-secure-http', 'Enable/disable redirecting the login page to HTTPS.', false),
  ],
  onCommit(object, context) {
    context.device.applyAuthSetting({
      timeoutMinutes: Number.parseInt(object.effective('auth-timeout')[0] ?? '5', 10),
      timeoutType: object.effective('auth-timeout-type')[0] ?? 'idle-timeout',
      secureHttp: object.effective('auth-secure-http')[0] === 'enable',
    });
  },
};

function serverOf(object: FortiObjectView): string | undefined {
  const type = object.effective('type')[0] ?? 'password';
  if (type === 'radius') return object.effective('radius-server')[0];
  if (type === 'tacacs+') return object.effective('tacacs+-server')[0];
  if (type === 'ldap') return object.effective('ldap-server')[0];
  return undefined;
}

function field(entry: FortiObjectView, name: string): string {
  return entry.effective(name)[0] ?? '';
}

export const USER_SPECS: readonly FortiTableSpec[] = Object.freeze([
  USER_LOCAL,
  USER_GROUP,
  USER_RADIUS,
  USER_TACACS,
  USER_LDAP,
  USER_FSSO,
  USER_SAML,
  USER_SETTING,
]);

export { NO_FSSO, NO_SAML };
