import { FortiMessages } from '../FortiMessages';
import type { FortiCommitContext, FortiTableSpec } from '../schema/types';
import { FortiConfigTree } from './FortiConfigTree';
import { FortiObject, type FortiObjectSnapshot } from './FortiObject';
import { FortiTable, type MovePosition } from './FortiTable';
import { FortiValidator } from './FortiValidator';

export interface TableFrame {
  readonly kind: 'table';
  readonly table: FortiTable;
}

export interface ObjectFrame {
  readonly kind: 'object';
  readonly object: FortiObject;
  readonly existed: boolean;
  readonly snapshot: FortiObjectSnapshot;
  readonly owner: FortiTable | null;
}

export type FortiFrame = TableFrame | ObjectFrame;

export interface NavigatorDeps {
  readonly tree: FortiConfigTree;
  readonly validator: FortiValidator;
  readonly commitContext: () => FortiCommitContext;
}

const EMPTY = '';

export class FortiNavigator {
  private readonly stack: FortiFrame[] = [];

  constructor(private readonly deps: NavigatorDeps) {}

  depth(): number {
    return this.stack.length;
  }

  frames(): readonly FortiFrame[] {
    return [...this.stack];
  }

  private top(): FortiFrame | undefined {
    return this.stack[this.stack.length - 1];
  }

  currentObject(): FortiObject | undefined {
    const frame = this.top();
    return frame?.kind === 'object' ? frame.object : undefined;
  }

  currentTable(): FortiTable | undefined {
    const frame = this.top();
    return frame?.kind === 'table' ? frame.table : undefined;
  }

  currentSpec(): FortiTableSpec | undefined {
    const frame = this.top();
    if (!frame) return undefined;
    return frame.kind === 'table' ? frame.table.spec : frame.object.spec;
  }

  label(): string | null {
    const frame = this.top();
    if (!frame) return null;
    if (frame.kind === 'object') return frame.object.key;
    return frame.table.spec.path[frame.table.spec.path.length - 1];
  }

  descend(words: readonly string[]): string {
    if (words.length === 0) return FortiMessages.incomplete('a configuration path');

    const parent = this.currentObject();
    if (parent && !parent.spec.scopeOnly) return this.descendChild(parent, words);

    if (!parent && this.currentTable()) {
      return FortiMessages.commandFail(
        '`config` from inside a table needs an object opened with `edit` first.',
      );
    }

    const spec = this.deps.tree.spec(words);
    if (!spec) return FortiMessages.unknownPath(words.join(' '));

    if (spec.kind === 'object') {
      const object = this.deps.tree.singleton(spec);
      this.stack.push({
        kind: 'object', object, existed: true, snapshot: object.snapshot(), owner: null,
      });
      return EMPTY;
    }

    this.stack.push({ kind: 'table', table: this.deps.tree.table(spec) });
    return EMPTY;
  }

  private descendChild(parent: FortiObject, words: readonly string[]): string {
    if (words.length !== 1) return FortiMessages.unknownPath(words.join(' '));

    const single = parent.childObject(words[0]);
    if (single) {
      this.stack.push({
        kind: 'object', object: single, existed: true,
        snapshot: single.snapshot(), owner: null,
      });
      return EMPTY;
    }

    const child = parent.child(words[0]);
    if (!child) return FortiMessages.unknownPath(words[0]);

    this.stack.push({ kind: 'table', table: child });
    return EMPTY;
  }

  edit(key: string | undefined): string {
    const frame = this.top();
    if (!frame) return FortiMessages.outsideTable('edit');
    if (frame.kind === 'object') {
      return FortiMessages.notATable(frame.object.spec.path.join(' '));
    }
    if (key === undefined) return FortiMessages.incomplete('the object key');

    const table = frame.table;
    const spec = table.spec;
    const resolved = spec.keyType === 'integer' && key === '0'
      ? table.nextFreeIntegerKey()
      : unquote(key);

    if (spec.keyType === 'integer' && !/^\d+$/.test(resolved)) {
      return FortiMessages.valueError(key, 'the key of this table is an integer.');
    }

    const existed = table.has(resolved);
    const object = table.ensure(resolved);
    this.stack.push({
      kind: 'object', object, existed, snapshot: object.snapshot(), owner: table,
    });
    return EMPTY;
  }

  set(attribute: string | undefined, values: readonly string[]): string {
    const object = this.currentObject();
    if (!object) return FortiMessages.setOutside(this.currentTable());
    if (attribute === undefined) return FortiMessages.incomplete('an attribute');

    const spec = object.attribute(attribute);
    if (!spec) {
      return FortiMessages.unknownAttribute(attribute, object.spec.path.join(' '));
    }
    if (!object.isAvailable(spec)) {
      return FortiMessages.commandFail(
        `\`${attribute}\` does not apply in the current configuration of this object.`,
      );
    }

    const cleaned = values.map(unquote);
    const verdict = this.deps.validator.validate(spec, cleaned);
    if (!verdict.ok) return verdict.error;

    object.set(attribute, verdict.values);
    return EMPTY;
  }

  unset(attribute: string | undefined): string {
    const object = this.currentObject();
    if (!object) return FortiMessages.outsideObject('unset');
    if (attribute === undefined) return FortiMessages.incomplete('an attribute');
    if (!object.attribute(attribute)) {
      return FortiMessages.unknownAttribute(attribute, object.spec.path.join(' '));
    }

    object.unset(attribute);
    return EMPTY;
  }

  append(attribute: string | undefined, values: readonly string[]): string {
    return this.listVerb('append', attribute, values,
      (object, name, cleaned) => object.appendTo(name, cleaned));
  }

  select(attribute: string | undefined, values: readonly string[]): string {
    return this.listVerb('select', attribute, values,
      (object, name, cleaned) => object.keepOnly(name, cleaned));
  }

  unselect(attribute: string | undefined, values: readonly string[]): string {
    return this.listVerb('unselect', attribute, values,
      (object, name, cleaned) => object.removeFrom(name, cleaned));
  }

  private listVerb(
    verb: string,
    attribute: string | undefined,
    values: readonly string[],
    apply: (object: FortiObject, name: string, cleaned: string[]) => void,
  ): string {
    const object = this.currentObject();
    if (!object) return FortiMessages.outsideObject(verb);
    if (attribute === undefined) return FortiMessages.incomplete('an attribute');

    const spec = object.attribute(attribute);
    if (!spec) return FortiMessages.unknownAttribute(attribute, object.spec.path.join(' '));
    if (!spec.multiValue) return FortiMessages.notMultiValue(verb, attribute);
    if (values.length === 0) return FortiMessages.incomplete('at least one value');

    const cleaned = values.map(unquote);
    if (verb === 'append') {
      const verdict = this.deps.validator.validate(spec, cleaned);
      if (!verdict.ok) return verdict.error;
    }

    apply(object, attribute, cleaned);
    return EMPTY;
  }

  next(): string {
    const frame = this.top();
    if (!frame) return FortiMessages.outsideObject('next');
    if (frame.kind !== 'object') {
      return FortiMessages.commandFail('`next` closes an object; use `end` here.');
    }

    this.commit(frame.object);
    this.stack.pop();
    return EMPTY;
  }

  end(): string {
    const frame = this.top();
    if (!frame) return EMPTY;

    if (frame.kind === 'object') {
      this.commit(frame.object);
      this.stack.pop();
      if (this.currentTable() !== undefined) this.stack.pop();
      return EMPTY;
    }

    this.stack.pop();
    return EMPTY;
  }

  abortToRoot(): void {
    while (this.stack.length > 0) this.end();
  }

  abort(): string {
    while (this.stack.length > 0) {
      const frame = this.stack.pop()!;
      if (frame.kind !== 'object') continue;
      if (!frame.existed && frame.owner) frame.owner.remove(frame.object.key);
      else frame.object.restore(frame.snapshot);
    }
    return EMPTY;
  }

  delete(key: string | undefined): string {
    const table = this.currentTable();
    if (!table) return FortiMessages.outsideTable('delete');
    if (key === undefined) return FortiMessages.incomplete('the key to delete');

    const resolved = unquote(key);
    if (!table.remove(resolved)) return FortiMessages.unknownKey(resolved);

    table.spec.onDelete?.(resolved, this.deps.commitContext());
    return EMPTY;
  }

  purge(): string {
    const table = this.currentTable();
    if (!table) return FortiMessages.outsideTable('purge');

    const context = this.deps.commitContext();
    for (const key of table.purge()) table.spec.onDelete?.(key, context);
    return EMPTY;
  }

  clone(words: readonly string[]): string {
    const table = this.currentTable();
    if (!table) return FortiMessages.outsideTable('clone');

    const parsed = parsePair(words, 'to');
    if (!parsed) return FortiMessages.incomplete('`clone <key> to <new-key>`');
    if (!table.has(parsed.from)) return FortiMessages.unknownKey(parsed.from);
    if (table.has(parsed.to)) return FortiMessages.duplicate(parsed.to);

    const copy = table.clone(parsed.from, parsed.to);
    if (!copy) return FortiMessages.commandFail('the copy failed.');

    this.commit(copy, table);
    return EMPTY;
  }

  rename(words: readonly string[]): string {
    const table = this.currentTable();
    if (!table) return FortiMessages.outsideTable('rename');

    const parsed = parsePair(words, 'to');
    if (!parsed) return FortiMessages.incomplete('`rename <key> to <new-key>`');
    if (!table.has(parsed.from)) return FortiMessages.unknownKey(parsed.from);
    if (table.has(parsed.to)) return FortiMessages.duplicate(parsed.to);

    table.spec.onDelete?.(parsed.from, this.deps.commitContext());
    table.rename(parsed.from, parsed.to);
    const renamed = table.get(parsed.to);
    if (renamed) this.commit(renamed, table);
    return EMPTY;
  }

  move(words: readonly string[]): string {
    const table = this.currentTable();
    if (!table) return FortiMessages.outsideTable('move');
    if (!table.spec.ordered) {
      return FortiMessages.notOrdered('move', table.spec.path.join(' '));
    }

    const [key, positionWord, target] = words;
    if (!key || !positionWord || !target) {
      return FortiMessages.incomplete('`move <key> {before|after} <key>`');
    }
    if (positionWord !== 'before' && positionWord !== 'after') {
      return FortiMessages.valueError(positionWord, 'expected `before` or `after`.');
    }
    if (!table.move(unquote(key), positionWord as MovePosition, unquote(target))) {
      return FortiMessages.unknownKey(unquote(key));
    }

    this.recommitTable(table);
    return EMPTY;
  }

  private commit(object: FortiObject, owner?: FortiTable | null): void {
    const table = owner ?? this.ownerOf(object);
    const position = table ? table.keys().indexOf(object.key) : -1;
    object.spec.onCommit?.(object, { ...this.deps.commitContext(), position });
  }

  private ownerOf(object: FortiObject): FortiTable | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const frame = this.stack[i];
      if (frame.kind === 'object' && frame.object === object) return frame.owner;
    }
    return null;
  }

  private recommitTable(table: FortiTable): void {
    const base = this.deps.commitContext();
    for (const key of table.keys()) table.spec.onDelete?.(key, base);
    table.all().forEach((object, position) => {
      table.spec.onCommit?.(object, { ...base, position });
    });
  }
}

export function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function parsePair(
  words: readonly string[], keyword: string,
): { from: string; to: string } | null {
  const at = words.indexOf(keyword);
  if (at !== 1 || words.length !== 3) return null;
  return { from: unquote(words[0]), to: unquote(words[2]) };
}
