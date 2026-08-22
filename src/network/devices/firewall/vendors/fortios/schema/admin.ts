import { ACCESS_GROUPS } from '../../../authz/AccessMatrix';
import { passwordPolicyRefusal } from './passwordPolicy';
import {
  addressMask, choice, refList, reference, text, word,
  type FortiAttributeSpec, type FortiObjectView, type FortiTableSpec,
} from './types';

const NO_TOKEN = 'two-factor authentication needs a token seed, a clock shared '
  + 'with the token, and a FortiToken to hold it. None of the three exists '
  + 'here, so the second factor would always be accepted — strictly worse '
  + 'than no second factor at all.';

const RIGHTS = [
  { keyword: 'none', description: 'No access.' },
  { keyword: 'read', description: 'Read access only.' },
  { keyword: 'read-write', description: 'Read and write access.' },
];

const GROUP_HELP: Readonly<Record<string, string>> = Object.freeze({
  sysgrp: 'System configuration.',
  netgrp: 'Network configuration.',
  fwgrp: 'Firewall policy and objects.',
  utmgrp: 'Security profiles.',
  vpngrp: 'VPN configuration.',
  loggrp: 'Log and report access.',
  authgrp: 'Users and authentication.',
  secfabgrp: 'Security Fabric.',
  ftviewgrp: 'FortiView.',
});

const TRUSTHOST_COUNT = 10;

function rightsAttributes(): FortiAttributeSpec[] {
  return ACCESS_GROUPS.map(group =>
    choice(group, GROUP_HELP[group] ?? group, RIGHTS, 'none'));
}

function trustHostAttributes(): FortiAttributeSpec[] {
  const out: FortiAttributeSpec[] = [];
  for (let index = 1; index <= TRUSTHOST_COUNT; index++) {
    out.push(addressMask(
      `trusthost${index}`,
      `Trusted host ${index}, from which the administrator may connect.`,
      ['0.0.0.0', '0.0.0.0']));
  }
  return out;
}

export const SYSTEM_ACCPROFILE: FortiTableSpec = {
  path: ['system', 'accprofile'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 560,
  help: 'Configure access profiles for system administrators.',
  predefined: ['super_admin', 'prof_admin'],
  attributes: [
    { ...word('name', 'Profile name.'), readOnly: true },
    text('comments', 'Comment.'),
    ...rightsAttributes(),
  ],
  onCommit(object, context) {
    const rights: Record<string, string> = {};
    for (const group of ACCESS_GROUPS) {
      rights[group] = object.effective(group)[0] ?? 'none';
    }

    context.device.applyAccessProfile({
      name: object.key,
      rights,
      comments: object.effective('comments')[0] || undefined,
    });
  },
  onDelete(key, context) {
    context.device.removeAccessProfile(key);
  },
};

export const SYSTEM_ADMIN: FortiTableSpec = {
  path: ['system', 'admin'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 570,
  help: 'Configure admin users.',
  predefined: ['admin'],
  attributes: [
    { ...word('name', 'Administrator name.'), readOnly: true },
    {
      ...text('password', 'Administrator password.'),
      quoted: true,
      secret: true,
      valueRefusal: (value, env) =>
        passwordPolicyRefusal(value, env, 'admin-password'),
    },
    reference('accprofile', 'Access profile for this administrator.',
      ['system accprofile']),
    refList('vdom', 'Virtual domains this administrator can access.',
      ['system vdom']),
    ...trustHostAttributes(),
    {
      ...choice('two-factor', 'Enable/disable two-factor authentication.', [
        { keyword: 'disable', description: 'No second factor.' },
        { keyword: 'fortitoken', description: 'FortiToken.' },
        { keyword: 'email', description: 'One-time code by email.' },
        { keyword: 'sms', description: 'One-time code by SMS.' },
      ], 'disable'),
      unimplementedValues: {
        fortitoken: NO_TOKEN, email: NO_TOKEN, sms: NO_TOKEN,
      },
    },
    text('comments', 'Comment.'),
  ],
  onCommit(object, context) {
    context.device.applyAdminAccount({
      name: object.key,
      password: object.effective('password')[0],
      profile: object.effective('accprofile')[0] ?? 'no_access',
      vdoms: [...object.effective('vdom')],
      trustHosts: readTrustHosts(object),
      comments: object.effective('comments')[0] || undefined,
    });
  },
  onDelete(key, context) {
    context.device.removeAdminAccount(key);
  },
};

function readTrustHosts(object: FortiObjectView) {
  const out: { index: number; address: string; mask: string }[] = [];
  for (let index = 1; index <= TRUSTHOST_COUNT; index++) {
    const declared = object.effective(`trusthost${index}`);
    if (declared.length < 2) continue;
    out.push({ index, address: declared[0], mask: declared[1] });
  }
  return out;
}

export const ADMIN_SPECS: readonly FortiTableSpec[] = Object.freeze([
  SYSTEM_ACCPROFILE,
  SYSTEM_ADMIN,
]);

export { NO_TOKEN };
