import { keyAttributeName, pathKey, type FortiTableSpec } from '../schema/types';
import type { FortiConfigTree } from './FortiConfigTree';
import type { FortiObject } from './FortiObject';

export interface FortiReference {
  readonly table: string;
  readonly keyAttribute: string;
  readonly key: string;
  readonly childTable?: string;
  readonly referencedKey: string;
  readonly attribute: string;
}

export function dottedPath(spec: FortiTableSpec): string {
  return spec.path.join('.');
}

export function referencesTo(
  tree: FortiConfigTree, target: readonly string[], key: string,
): FortiReference[] {
  const wanted = pathKey(target);
  const out: FortiReference[] = [];

  for (const spec of tree.specPaths()) {
    const declared = tree.spec(spec);
    if (!declared) continue;
    const node = tree.node(spec);
    if (!node) continue;

    const objects: readonly FortiObject[] = declared.kind === 'table'
      ? tree.table(declared).all()
      : [tree.singleton(declared)];

    for (const object of objects) {
      collect(declared, object, wanted, key, out);
    }
  }
  return out;
}

function collect(
  spec: FortiTableSpec, object: FortiObject,
  wanted: string, key: string, out: FortiReference[],
): void {
  const holder = keyAttributeName(spec) ?? spec.attributes[0]?.name ?? 'name';

  for (const attribute of spec.attributes) {
    if (!attribute.referenceTo?.includes(wanted)) continue;
    if (!object.effective(attribute.name).includes(key)) continue;

    out.push({
      table: dottedPath(spec), keyAttribute: holder, key: object.key,
      childTable: attribute.multiValue === true ? attribute.name : undefined,
      referencedKey: key, attribute: attribute.name,
    });
  }

  for (const name of object.childNames()) {
    const childSpec = object.childSpec(name);
    const child = object.child(name);
    if (!childSpec || !child) continue;
    for (const entry of child.all()) collect(childSpec, entry, wanted, key, out);
  }
}

export function renderReference(reference: FortiReference): string {
  if (reference.childTable !== undefined) {
    return `entry used by child table ${reference.childTable}:name`
      + ` '${reference.referencedKey}' of table ${reference.table}:`
      + `${reference.keyAttribute} '${reference.key}'`;
  }
  return `entry used by table ${reference.table}:`
    + `${reference.keyAttribute} '${reference.key}'`;
}
