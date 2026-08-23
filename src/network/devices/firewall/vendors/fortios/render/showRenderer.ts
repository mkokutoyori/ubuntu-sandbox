import { encodeSecret } from '../runtime/secretEncoding';
import {
  isQuoted, keyAttributeName,
  type FortiAttributeSpec, type FortiTableSpec,
} from '../schema/types';
import type { FortiConfigTree } from '../runtime/FortiConfigTree';
import type { FortiObject } from '../runtime/FortiObject';
import type { FortiTable } from '../runtime/FortiTable';

const STEP = '    ';

export interface ShowOptions {
  readonly full: boolean;
}

export function renderValue(spec: FortiAttributeSpec, values: readonly string[]): string {
  if (spec.secret === true) return `ENC ${encodeSecret(values.join(' '))}`;
  if (spec.quoteValue) {
    return values.map(v => (spec.quoteValue?.(v) === true ? `"${v}"` : v)).join(' ');
  }
  if (!isQuoted(spec)) return values.join(' ');
  return values.map(v => `"${v}"`).join(' ');
}


export function renderKey(spec: FortiTableSpec, key: string): string {
  if (spec.quotedKey !== undefined) return spec.quotedKey ? `"${key}"` : key;
  return spec.keyType === 'integer' || spec.keyType === 'address' ? key : `"${key}"`;
}

function attributeLines(
  object: FortiObject, options: ShowOptions, indent: string,
): string[] {
  const out: string[] = [];
  const key = keyAttributeName(object.spec);
  for (const spec of object.spec.attributes) {
    if (spec.name === key) continue;
    if (!object.isAvailable(spec)) continue;
    if (spec.unimplemented) continue;
    if (spec.hidden === true) continue;
    if (!options.full && !object.isExplicit(spec.name)) continue;

    const values = object.effective(spec.name);
    if (values.length === 0) continue;
    out.push(`${indent}set ${spec.name} ${renderValue(spec, values)}`);
  }
  return out;
}

function childLines(object: FortiObject, options: ShowOptions, indent: string): string[] {
  const out: string[] = [];
  for (const name of object.childNames()) {
    const table = object.child(name);
    if (table) {
      if (table.size() === 0) continue;
      out.push(`${indent}config ${name}`);
      out.push(...tableBody(table, options, indent + STEP));
      out.push(`${indent}end`);
      continue;
    }

    const single = object.childObject(name);
    if (!single) continue;

    const body = objectLines(single, options, indent + STEP);
    if (body.length === 0) continue;

    out.push(`${indent}config ${name}`);
    out.push(...body);
    out.push(`${indent}end`);
  }
  return out;
}

function objectLines(object: FortiObject, options: ShowOptions, indent: string): string[] {
  return [...attributeLines(object, options, indent), ...childLines(object, options, indent)];
}

function tableBody(
  table: FortiTable, options: ShowOptions, indent: string, only?: string,
): string[] {
  const out: string[] = [];
  for (const object of table.all()) {
    if (only !== undefined && object.key !== only) continue;
    out.push(`${indent}edit ${renderKey(table.spec, object.key)}`);
    out.push(...objectLines(object, options, indent + STEP));
    out.push(`${indent}next`);
  }
  return out;
}

export function renderTableConfig(
  table: FortiTable, options: ShowOptions, only?: string,
): string[] {
  const path = table.spec.path.join(' ');
  if (table.spec.keyOnConfigLine === true) {
    return keyedTableConfig(table, options, path, only);
  }
  return [`config ${path}`, ...tableBody(table, options, STEP, only), 'end'];
}

function keyedTableConfig(
  table: FortiTable, options: ShowOptions, path: string, only?: string,
): string[] {
  const out: string[] = [];
  for (const object of table.all()) {
    if (only !== undefined && object.key !== only) continue;
    const body = objectLines(object, options, STEP);
    if (body.length === 0) continue;
    out.push(`config ${path} ${renderKey(table.spec, object.key)}`, ...body, 'end');
  }
  return out;
}

export function renderSingletonConfig(
  object: FortiObject, options: ShowOptions,
): string[] {
  const path = object.spec.path.join(' ');
  return [`config ${path}`, ...objectLines(object, options, STEP), 'end'];
}

export function renderPath(
  tree: FortiConfigTree, path: readonly string[], options: ShowOptions,
  key?: string,
): string[] | null {
  const spec = tree.spec(path);
  if (!spec) return null;

  if (spec.kind === 'table') {
    const table = tree.table(spec);
    if (key !== undefined && !table.has(key)) return null;
    return renderTableConfig(table, options, key);
  }
  if (key !== undefined) return null;
  return renderSingletonConfig(tree.singleton(spec), options);
}

export function renderWholeConfig(tree: FortiConfigTree, options: ShowOptions): string[] {
  const out: string[] = [];
  for (const spec of tree.populatedPaths()) {
    out.push(...(renderPath(tree, spec.path, options) ?? []));
  }
  return out;
}
