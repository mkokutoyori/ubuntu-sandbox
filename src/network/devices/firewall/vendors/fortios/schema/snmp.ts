import { IPAddress, SubnetMask } from '../../../../../core/types';
import { PortNumber } from '../../../../../core/ports/PortNumber';
import type { SnmpManagerHost, SnmpManagerHostType } from '../../../mgmt/FirewallSnmp';
import {
  addressMask, choice, count, enable, reference, refList, text, word,
  type FortiObjectView, type FortiTableSpec,
} from './types';

export const SYSTEM_SNMP_SYSINFO: FortiTableSpec = {
  path: ['system', 'snmp', 'sysinfo'],
  kind: 'object',
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 80,
  help: 'SNMP system info configuration.',
  attributes: [
    text('contact-info', 'Contact information.'),
    text('description', 'System description.'),
    text('location', 'System location.'),
    enable('status', 'Enable/disable SNMP.'),
  ],
  onCommit(object, context) {
    context.device.applySnmpSysinfo({
      enabled: object.effective('status')[0] === 'enable',
      description: object.effective('description')[0] ?? '',
      contactInfo: object.effective('contact-info')[0] ?? '',
      location: object.effective('location')[0] ?? '',
    });
  },
};

const MIB_VIEW_MAX_INCLUDES = 16;
const MIB_VIEW_MAX_EXCLUDES = 64;
const OBJECT_IDENTIFIER = /^\.?\d+(\.\d+)*$/;

function subtrees(values: readonly string[]): string[] {
  return values.map((value) => value.replace(/^\./, ''));
}

export const SYSTEM_SNMP_MIB_VIEW: FortiTableSpec = {
  path: ['system', 'snmp', 'mib-view'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 81,
  help: 'SNMP Access Control MIB View configuration.',
  attributes: [
    { ...word('name', 'MIB view name.'), readOnly: true },
    { ...word('exclude', 'OID subtrees to be excluded in the view. Maximum 64 allowed.'), multiValue: true, defaultValue: [] },
    { ...word('include', 'OID subtrees to be included in the view. Maximum 16 allowed.'), multiValue: true, defaultValue: [] },
  ],
  onCommit(object, context) {
    const include = object.effective('include');
    const exclude = object.effective('exclude');
    if (include.length > MIB_VIEW_MAX_INCLUDES) return `a MIB view includes at most ${MIB_VIEW_MAX_INCLUDES} subtrees.`;
    if (exclude.length > MIB_VIEW_MAX_EXCLUDES) return `a MIB view excludes at most ${MIB_VIEW_MAX_EXCLUDES} subtrees.`;
    const invalid = [...include, ...exclude].find((oid) => !OBJECT_IDENTIFIER.test(oid));
    if (invalid !== undefined) return `invalid OID "${invalid}".`;
    context.device.applySnmpMibView({
      name: object.key, include: subtrees(include), exclude: subtrees(exclude),
    });
  },
  onDelete(key, context) {
    context.device.removeSnmpMibView(key);
  },
};

const SNMP_COMMUNITY_HOSTS: FortiTableSpec = {
  path: ['hosts'],
  kind: 'table',
  keyType: 'integer',
  ordered: false,
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 83,
  help: 'Configure IPv4 SNMP managers (hosts).',
  attributes: [
    { ...word('id', 'Host entry ID.'), readOnly: true },
    enable('ha-direct', 'Enable/disable direct management of HA cluster members.'),
    choice('host-type', 'Control whether the SNMP manager sends SNMP queries, receives SNMP traps, or both.', [
      { keyword: 'any', description: 'Accept queries from and send traps to this SNMP manager.' },
      { keyword: 'query', description: 'Accept queries from this SNMP manager but do not send traps.' },
      {
        keyword: 'trap',
        description: 'Send traps to this SNMP manager but do not accept SNMP queries from this SNMP manager.',
      },
    ], 'any'),
    addressMask('ip', 'IPv4 address of the SNMP manager (host).', ['0.0.0.0', '0.0.0.0']),
  ],
};

function managerHosts(object: FortiObjectView): SnmpManagerHost[] {
  return object.childEntries('hosts').map((entry) => {
    const [address, mask] = entry.effective('ip');
    return {
      id: entry.key,
      address: new IPAddress(address ?? '0.0.0.0'),
      mask: new SubnetMask(mask ?? '0.0.0.0'),
      hostType: (entry.effective('host-type')[0] ?? 'any') as SnmpManagerHostType,
      haDirect: entry.effective('ha-direct')[0] === 'enable',
    };
  });
}

function queryPort(object: FortiObjectView, attribute: string): PortNumber {
  return PortNumber.of(Number.parseInt(object.effective(attribute)[0] ?? '161', 10));
}

export const SYSTEM_SNMP_COMMUNITY: FortiTableSpec = {
  path: ['system', 'snmp', 'community'],
  kind: 'table',
  keyType: 'integer',
  ordered: false,
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 82,
  help: 'SNMP community configuration.',
  attributes: [
    { ...word('id', 'Community ID.'), readOnly: true },
    reference('mib-view', 'SNMP access control MIB view.', ['system snmp mib-view']),
    word('name', 'Community name.'),
    count('query-v1-port', 'SNMP v1 query port (default = 161).', 1, 65535, 161),
    enable('query-v1-status', 'Enable/disable SNMP v1 queries.', true),
    count('query-v2c-port', 'SNMP v2c query port (default = 161).', 0, 65535, 161),
    enable('query-v2c-status', 'Enable/disable SNMP v2c queries.', true),
    enable('status', 'Enable/disable this SNMP community.', true),
    refList('vdoms', 'SNMP access control VDOMs.', ['vdom']),
  ],
  children: [SNMP_COMMUNITY_HOSTS],
  maxEntries: () => 3,
  onCommit(object, context) {
    context.device.applySnmpCommunity({
      id: object.key,
      name: object.effective('name')[0] ?? '',
      enabled: object.effective('status')[0] === 'enable',
      hosts: managerHosts(object),
      queryV1: {
        enabled: object.effective('query-v1-status')[0] === 'enable',
        port: queryPort(object, 'query-v1-port'),
      },
      queryV2c: {
        enabled: object.effective('query-v2c-status')[0] === 'enable',
        port: queryPort(object, 'query-v2c-port'),
      },
      mibView: object.effective('mib-view')[0] ?? '',
      vdoms: [...object.effective('vdoms')],
    });
  },
  onDelete(key, context) {
    context.device.removeSnmpCommunity(key);
  },
};

export const SNMP_SPECS: readonly FortiTableSpec[] = [
  SYSTEM_SNMP_SYSINFO, SYSTEM_SNMP_MIB_VIEW, SYSTEM_SNMP_COMMUNITY,
];
