import type { ObjectStore } from '../../../model/ObjectStore';
import type { PolicyStore } from '../../../model/PolicyStore';

export type FortiValueType =
  | 'string'
  | 'integer'
  | 'ipv4-address'
  | 'ipv4-netmask'
  | 'ipv4-address-mask'
  | 'ipv4-range'
  | 'mac-address'
  | 'enum'
  | 'reference'
  | 'time'
  | 'password'
  | 'user-name'
  | 'boolean-enable'
  | 'port-range'
  | 'uuid';

export type FortiAccessGroup =
  | 'sysgrp' | 'netgrp' | 'fwgrp' | 'utmgrp' | 'vpngrp'
  | 'loggrp' | 'authgrp' | 'secfabgrp' | 'ftviewgrp';

export type FortiScope = 'global' | 'vdom' | 'both';

export interface FortiEnumValue {
  readonly value: string;
  readonly help: string;
}

export interface FortiObjectView {
  key: string;
  effective(attribute: string): readonly string[];
  isExplicit(attribute: string): boolean;
}

export interface FortiAttributeSpec {
  readonly name: string;
  readonly type: FortiValueType;
  readonly help: string;
  readonly enumValues?: readonly FortiEnumValue[];
  readonly referenceTo?: readonly string[];
  readonly multiValue?: boolean;
  readonly defaultValue?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly maxLength?: number;
  readonly arity?: number;
  readonly availableWhen?: (object: FortiObjectView) => boolean;
  readonly unimplemented?: string;
  readonly readOnly?: boolean;
}

export interface FortiCommitContext {
  readonly policy: PolicyStore;
  readonly objects: ObjectStore;
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

const QUOTED_TYPES: ReadonlySet<FortiValueType> = new Set<FortiValueType>([
  'string', 'reference', 'user-name', 'password',
]);

export function typeIsQuoted(type: FortiValueType): boolean {
  return QUOTED_TYPES.has(type);
}

export function typeArity(spec: FortiAttributeSpec): number {
  if (spec.arity !== undefined) return spec.arity;
  if (spec.type === 'ipv4-address-mask' || spec.type === 'ipv4-range') return 2;
  return 1;
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

export function enable(name: string, help: string, byDefault = false): FortiAttributeSpec {
  return {
    name,
    type: 'boolean-enable',
    help,
    enumValues: [
      { value: 'enable', help: 'Enable setting.' },
      { value: 'disable', help: 'Disable setting.' },
    ],
    defaultValue: [byDefault ? 'enable' : 'disable'],
  };
}

export function text(
  name: string, help: string, maxLength: number, defaultValue = '',
): FortiAttributeSpec {
  return { name, type: 'string', help, maxLength, defaultValue: [defaultValue] };
}

export function choice(
  name: string, help: string, values: readonly FortiEnumValue[], byDefault: string,
): FortiAttributeSpec {
  return { name, type: 'enum', help, enumValues: values, defaultValue: [byDefault] };
}

export function refList(
  name: string, help: string, targets: readonly string[],
): FortiAttributeSpec {
  return { name, type: 'reference', help, referenceTo: targets, multiValue: true };
}

export function count(
  name: string, help: string, min: number, max: number, byDefault: number,
): FortiAttributeSpec {
  return {
    name, type: 'integer', help, min, max, defaultValue: [String(byDefault)],
  };
}
