import type { ArgumentSpec, EnumValue } from '../../../../../../cli/ArgumentTypes';
import type { ObjectStore } from '../../../model/ObjectStore';
import type { PolicyStore } from '../../../model/PolicyStore';

export type FortiAccessGroup =
  | 'sysgrp' | 'netgrp' | 'fwgrp' | 'utmgrp' | 'vpngrp'
  | 'loggrp' | 'authgrp' | 'secfabgrp' | 'ftviewgrp';

export type FortiScope = 'global' | 'vdom' | 'both';

export interface FortiObjectView {
  key: string;
  effective(attribute: string): readonly string[];
  isExplicit(attribute: string): boolean;
}

export interface FortiAttributeSpec {
  readonly name: string;
  readonly help: string;
  readonly parts: readonly ArgumentSpec[];
  readonly multiValue?: boolean;
  readonly referenceTo?: readonly string[];
  readonly quoted?: boolean;
  readonly defaultValue?: readonly string[];
  readonly availableWhen?: (object: FortiObjectView) => boolean;
  readonly unimplemented?: string;
  readonly readOnly?: boolean;
}

export interface FortiInterfacePatch {
  readonly ip?: string;
  readonly mask?: string;
  readonly up?: boolean;
  readonly allowAccess?: readonly string[];
  readonly type?: string;
  readonly parent?: string;
  readonly vlanId?: number;
}

export interface FortiStaticRoute {
  readonly id: string;
  readonly destination: string;
  readonly mask: string;
  readonly gateway: string;
  readonly iface: string;
  readonly distance: number;
  readonly blackhole: boolean;
  readonly enabled: boolean;
}

export interface FortiSchedulePatch {
  readonly name: string;
  readonly days: readonly string[];
  readonly start: string;
  readonly end: string;
  readonly onetime: boolean;
}

export interface FortiCommitDevice {
  applyInterface(name: string, patch: FortiInterfacePatch): void;
  applyZone(name: string, members: readonly string[], intrazone: string): void;
  removeZone(name: string): void;
  applyStaticRoute(route: FortiStaticRoute): void;
  removeStaticRoute(id: string): void;
  applySchedule(schedule: FortiSchedulePatch): void;
  removeSchedule(name: string): void;
}

export interface FortiCommitContext {
  readonly policy: PolicyStore;
  readonly objects: ObjectStore;
  readonly device: FortiCommitDevice;
  readonly vdom: string;
  readonly position: number;
}

export interface FortiTableSpec {
  readonly path: readonly string[];
  readonly kind: 'table' | 'object';
  readonly keyType?: 'name' | 'integer';
  readonly ordered?: boolean;
  readonly scope: FortiScope;
  readonly accessGroup: FortiAccessGroup;
  readonly help: string;
  readonly renderOrder: number;
  readonly attributes: readonly FortiAttributeSpec[];
  readonly children?: readonly FortiTableSpec[];
  readonly predefined?: readonly string[];
  readonly onCommit?: (object: FortiObjectView, context: FortiCommitContext) => void;
  readonly onDelete?: (key: string, context: FortiCommitContext) => void;
}

export function pathKey(path: readonly string[]): string {
  return path.join(' ');
}

export function attributeMap(
  spec: FortiTableSpec,
): ReadonlyMap<string, FortiAttributeSpec> {
  const map = new Map<string, FortiAttributeSpec>();
  for (const attribute of spec.attributes) map.set(attribute.name, attribute);
  return map;
}

export function childMap(spec: FortiTableSpec): ReadonlyMap<string, FortiTableSpec> {
  const map = new Map<string, FortiTableSpec>();
  for (const child of spec.children ?? []) {
    map.set(child.path[child.path.length - 1], child);
  }
  return map;
}

export function attributeArity(spec: FortiAttributeSpec): number {
  return spec.parts.length;
}

export function isQuoted(spec: FortiAttributeSpec): boolean {
  if (spec.quoted !== undefined) return spec.quoted;
  return spec.referenceTo !== undefined
    || spec.parts.every(part => part.type === 'WORD' || part.type === 'LINE');
}

const ENABLE_VALUES: readonly EnumValue[] = Object.freeze([
  { keyword: 'enable', description: 'Enable setting.' },
  { keyword: 'disable', description: 'Disable setting.' },
]);

export function enable(
  name: string, help: string, byDefault = false,
): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: false,
    parts: [{ name, type: 'ENUM', description: help, values: ENABLE_VALUES }],
    defaultValue: [byDefault ? 'enable' : 'disable'],
  };
}

export function text(
  name: string, help: string, defaultValue = '',
): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: true,
    parts: [{ name, type: 'LINE', description: help }],
    defaultValue: [defaultValue],
  };
}

export function word(
  name: string, help: string, defaultValue = '',
): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: true,
    parts: [{ name, type: 'WORD', description: help }],
    defaultValue: [defaultValue],
  };
}

export function choice(
  name: string, help: string, values: readonly EnumValue[], byDefault: string,
): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: false,
    parts: [{ name, type: 'ENUM', description: help, values }],
    defaultValue: [byDefault],
  };
}

export function count(
  name: string, help: string, min: number, max: number, byDefault: number,
): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: false,
    parts: [{ name, type: 'INT', description: help, range: [min, max] }],
    defaultValue: [String(byDefault)],
  };
}

export function refList(
  name: string, help: string, targets: readonly string[],
): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: true,
    multiValue: true,
    referenceTo: targets,
    parts: [{ name, type: 'WORD', description: help }],
  };
}

export function reference(
  name: string, help: string, targets: readonly string[], defaultValue?: string,
): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: true,
    referenceTo: targets,
    parts: [{ name, type: 'WORD', description: help }],
    defaultValue: defaultValue === undefined ? undefined : [defaultValue],
  };
}

export function address(name: string, help: string, byDefault?: string): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: false,
    parts: [{ name, type: 'IP_ADDR', description: help }],
    defaultValue: byDefault === undefined ? undefined : [byDefault],
  };
}

export function addressMask(
  name: string, help: string, byDefault?: readonly string[],
): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: false,
    parts: [
      { name, type: 'IP_ADDR', description: help },
      { name: `${name}-mask`, type: 'SUBNET_MASK', description: 'Subnet mask.' },
    ],
    defaultValue: byDefault === undefined ? undefined : [...byDefault],
  };
}

export function clock(name: string, help: string, byDefault?: string): FortiAttributeSpec {
  return {
    name,
    help,
    quoted: false,
    parts: [{ name, type: 'TIME', description: help }],
    defaultValue: byDefault === undefined ? undefined : [byDefault],
  };
}
