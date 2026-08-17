import { isQuoted, type FortiAttributeSpec, type FortiTableSpec } from '../schema/types';
import type { FortiConfigTree } from '../runtime/FortiConfigTree';
import type { FortiObject } from '../runtime/FortiObject';
import type { FortiTable } from '../runtime/FortiTable';

const STEP = '    ';

export interface ShowOptions {
  readonly full: boolean;
}

export function renderValue(spec: FortiAttributeSpec, values: readonly string[]): string {
  if (!isQuoted(spec)) return values.join(' ');
  return values.map(v => `"${v}"`).join(' ');
}

export function renderKey(spec: FortiTableSpec, key: string): string {
  return spec.keyType === 'integer' ? key : `"${key}"`;
}

function attributeLines(
  object: FortiObject, options: ShowOptions, indent: string,
): string[] {
  const out: string[] = [];
  for (const spec of object.spec.attributes) {
    if (!object.isAvailable(spec)) continue;
    if (spec.unimplemented) continue;
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
    if (!table || table.size() === 0) continue;

    out.push(`${indent}config ${name}`);
    out.push(...tableBody(table, options, indent + STEP));
    out.push(`${indent}end`);
  }
  return out;
}

function objectLines(object: FortiObject, options: ShowOptions, indent: string): string[] {
  return [...attributeLines(object, options, indent), ...childLines(object, options, indent)];
}

function tableBody(table: FortiTable, options: ShowOptions, indent: string): string[] {
  const out: string[] = [];
  for (const object of table.all()) {
    out.push(`${indent}edit ${renderKey(table.spec, object.key)}`);
    out.push(...objectLines(object, options, indent + STEP));
    out.push(`${indent}next`);
  }
  return out;
}

export function renderTableConfig(
  table: FortiTable, options: ShowOptions,
): string[] {
  const path = table.spec.path.join(' ');
  return [`config ${path}`, ...tableBody(table, options, STEP), 'end'];
}

export function renderSingletonConfig(
  object: FortiObject, options: ShowOptions,
): string[] {
  const path = object.spec.path.join(' ');
  return [`config ${path}`, ...objectLines(object, options, STEP), 'end'];
}

export function renderPath(
  tree: FortiConfigTree, path: readonly string[], options: ShowOptions,
): string[] | null {
  const spec = tree.spec(path);
  if (!spec) return null;

  if (spec.kind === 'table') return renderTableConfig(tree.table(spec), options);
  return renderSingletonConfig(tree.singleton(spec), options);
}

export function renderWholeConfig(tree: FortiConfigTree, options: ShowOptions): string[] {
  const out: string[] = [];
  for (const spec of tree.populatedPaths()) {
    out.push(...(renderPath(tree, spec.path, options) ?? []));
  }
  return out;
}
