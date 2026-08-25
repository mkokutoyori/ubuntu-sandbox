import { IPAddress, SubnetMask } from '../../../network/core/types';
import type { ObjectGroup } from '../../../network/devices/router/ACLEngine';
import type { CliSession } from '../../CliSession';
import type { CommandSpec } from '../../CommandTable';

export const OBJECT_GROUP_MODE = 'config-network-group';
export const OBJECT_GROUP_FIELD = 'selectedObjectGroup';

const IOS_DESCRIPTION_MAX = 200;

export interface ObjectGroupStore {
  ensureObjectGroup(name: string): ObjectGroup;
  getObjectGroup(name: string): ObjectGroup | undefined;
  listObjectGroups(): ObjectGroup[];
  removeObjectGroup(name: string): boolean;
  addObjectGroupMember(name: string, ip: IPAddress, wildcard: SubnetMask): void;
  removeObjectGroupMember(name: string, ip: IPAddress, wildcard: SubnetMask): boolean;
}

export interface ObjectGroupHost {
  objectGroupStore(): ObjectGroupStore | null;
}

function host(device: unknown): ObjectGroupHost | null {
  const candidate = device as ObjectGroupHost | null;
  return typeof candidate?.objectGroupStore === 'function' ? candidate : null;
}

function store(session: CliSession): ObjectGroupStore | null {
  return host(session.device)?.objectGroupStore() ?? null;
}

function selectedGroup(session: CliSession): string | null {
  return session.fields[OBJECT_GROUP_FIELD] ?? null;
}

export function wildcardFromMask(mask: string): SubnetMask {
  return new SubnetMask(mask.split('.').map(n => 255 - parseInt(n, 10)).join('.'));
}

export function maskFromWildcard(wildcard: string): string {
  return wildcard.split('.').map(n => 255 - parseInt(n, 10)).join('.');
}

export function objectGroupBodyLines(group: ObjectGroup): string[] {
  const lines: string[] = [];
  if (group.description) lines.push(` description ${group.description}`);
  for (const member of group.members) {
    const wildcard = member.wildcard.toString();
    if (wildcard === '0.0.0.0') lines.push(` host ${member.ip}`);
    else if (wildcard === '255.255.255.255') lines.push(' any');
    else lines.push(` ${member.ip} ${maskFromWildcard(wildcard)}`);
  }
  return lines;
}

export function showObjectGroups(groups: readonly ObjectGroup[], name?: string): string {
  const wanted = name ? groups.filter(g => g.name === name) : groups;
  if (name && wanted.length === 0) return `% Object-group ${name} not found`;

  const lines: string[] = [];
  for (const group of wanted) {
    lines.push(`Network object group ${group.name}`);
    lines.push(...objectGroupBodyLines(group));
  }
  return lines.join('\n');
}

export function runningConfigObjectGroups(groups: readonly ObjectGroup[]): string[] {
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(`object-group network ${group.name}`);
    lines.push(...objectGroupBodyLines(group));
    lines.push('!');
  }
  return lines;
}

function member(
  id: string, path: CommandSpec['path'], description: string,
  address: (args: Readonly<Record<string, string>>) => IPAddress,
  wildcard: (args: Readonly<Record<string, string>>) => SubnetMask,
): CommandSpec {
  const apply = (
    session: CliSession,
    change: (target: ObjectGroupStore, group: string) => void,
  ): string => {
    const target = store(session);
    const group = selectedGroup(session);
    if (!target || !group) return '% No object-group selected';

    change(target, group);
    return '';
  };

  return {
    id, path, description,
    modes: [OBJECT_GROUP_MODE], minPrivilege: 15,
    run: (session, args) => apply(session, (target, group) =>
      target.addObjectGroupMember(group, address(args), wildcard(args))),
    undo: (session, args) => apply(session, (target, group) =>
      target.removeObjectGroupMember(group, address(args), wildcard(args))),
  };
}

const HOST_MEMBER = member(
  'object-group-host',
  ['host', { name: 'address', type: 'IP_ADDR', description: 'Host address' }],
  'A single host address',
  args => new IPAddress(args.address),
  () => new SubnetMask('0.0.0.0'),
);

const NETWORK_MEMBER = member(
  'object-group-network',
  ['network',
    { name: 'address', type: 'IP_ADDR', description: 'Network address' },
    { name: 'mask', type: 'SUBNET_MASK', description: 'Network mask' }],
  'A network address and mask',
  args => new IPAddress(args.address),
  args => wildcardFromMask(args.mask),
);

const ANY_MEMBER = member(
  'object-group-any', ['any'], 'Any address',
  () => new IPAddress('0.0.0.0'),
  () => new SubnetMask('255.255.255.255'),
);

const DESCRIPTION: CommandSpec = {
  id: 'object-group-description',
  path: ['description', { name: 'text', type: 'REST', description: 'Up to 200 characters' }],
  description: 'Description of the object group',
  modes: [OBJECT_GROUP_MODE], minPrivilege: 15,
  run: (session, args) => {
    const group = store(session)?.getObjectGroup(selectedGroup(session) ?? '');
    if (group) group.description = args.text.trim().slice(0, IOS_DESCRIPTION_MAX);
    return '';
  },
  undo: (session) => {
    const group = store(session)?.getObjectGroup(selectedGroup(session) ?? '');
    if (group) delete group.description;
    return '';
  },
};

const NESTED: CommandSpec = {
  id: 'object-group-nested',
  path: ['group-object', { name: 'name', type: 'WORD', description: 'Nested object group' }],
  description: 'Nested object group',
  modes: [OBJECT_GROUP_MODE], minPrivilege: 15,
  run: () => '% Nested object-groups are not supported on this platform',
};

const DECLARE: CommandSpec = {
  id: 'object-group-network-declare',
  path: ['object-group', 'network',
    { name: 'name', type: 'WORD', description: 'Object group name' }],
  description: 'Define a network object group',
  undoDescription: 'Remove a network object group',
  modes: ['config'], minPrivilege: 15,
  enters: OBJECT_GROUP_MODE,
  contextField: OBJECT_GROUP_FIELD,
  contextFrom: 'name',
  run: (session, args) => {
    const target = store(session);
    if (!target) return '% Object groups are not supported on this platform';

    target.ensureObjectGroup(args.name);
    return '';
  },
  undo: (session, args) => {
    const target = store(session);
    if (!target) return '% Object groups are not supported on this platform';

    return target.removeObjectGroup(args.name) ? '' : `% Object-group ${args.name} not found`;
  },
};

const SHOW: CommandSpec = {
  id: 'show-object-group',
  path: ['show', 'object-group',
    { name: 'name', type: 'WORD', optional: true, description: 'Object group name' }],
  description: 'Display object groups',
  modes: ['user', 'privileged'], minPrivilege: 1,
  run: (session, args) => {
    const target = store(session);
    if (!target) return '';

    return showObjectGroups(target.listObjectGroups(), args.name);
  },
};

export const OBJECT_GROUP_FAMILY: readonly CommandSpec[] = Object.freeze([
  DECLARE, HOST_MEMBER, NETWORK_MEMBER, ANY_MEMBER, DESCRIPTION, NESTED, SHOW,
]);
