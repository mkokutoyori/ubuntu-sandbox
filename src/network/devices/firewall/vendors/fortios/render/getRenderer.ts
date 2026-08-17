import { renderTable, FIXED_TABLE } from '../../../../shells/cli/TextTable';
import { typeIsQuoted, type FortiAttributeSpec } from '../schema/types';
import type { FortiConfigTree } from '../runtime/FortiConfigTree';
import type { FortiObject } from '../runtime/FortiObject';
import type { FortiTable } from '../runtime/FortiTable';

const FIELD_WIDTH = 20;

interface FieldRow {
  readonly name: string;
  readonly value: string;
}

function fieldValue(spec: FortiAttributeSpec, values: readonly string[]): string {
  if (values.length === 0) return '';
  if (!typeIsQuoted(spec.type)) return values.join(' ');
  return values.map(v => `"${v}"`).join(' ');
}

export function renderObjectFields(object: FortiObject): string[] {
  const rows: FieldRow[] = [];
  for (const spec of object.spec.attributes) {
    if (!object.isAvailable(spec)) continue;
    if (spec.unimplemented) continue;
    rows.push({ name: spec.name, value: fieldValue(spec, object.effective(spec.name)) });
  }

  return renderTable<FieldRow>(rows, [
    { header: '', width: FIELD_WIDTH, value: r => r.name },
    { header: '', width: 0, value: r => `: ${r.value}` },
  ], FIXED_TABLE).slice(1);
}

export function renderTableKeys(table: FortiTable): string[] {
  const out: string[] = [];
  for (const object of table.all()) {
    out.push(`== [ ${object.key} ]`);
    const label = table.spec.keyType === 'integer' ? 'policyid' : 'name';
    out.push(`${label}: ${object.key}`);
  }
  return out;
}

export function renderGet(
  tree: FortiConfigTree, path: readonly string[], key?: string,
): string[] | null {
  const spec = tree.spec(path);
  if (!spec) return null;

  if (spec.kind === 'object') return renderObjectFields(tree.singleton(spec));

  const table = tree.table(spec);
  if (key === undefined) return renderTableKeys(table);

  const object = table.get(key);
  return object ? renderObjectFields(object) : null;
}
