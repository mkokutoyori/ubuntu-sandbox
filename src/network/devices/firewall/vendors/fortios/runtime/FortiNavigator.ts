import { FortiMessages } from '../FortiMessages';
import { referencesTo } from './references';
import type { FortiCommitContext, FortiTableSpec } from '../schema/types';
import { FortiConfigTree } from './FortiConfigTree';
import { FortiObject, type FortiObjectSnapshot } from './FortiObject';
import { FortiTable, type MovePosition } from './FortiTable';
import { FortiValidator } from './FortiValidator';
import { clearOf, ENC_PREFIX } from './secretEncoding';
import { reservedCharacterHint, reservedCharacterIn } from '../schema/reservedCharacters';

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

export interface FortiConfigChange {
  readonly action: 'Add' | 'Edit' | 'Delete';
  readonly path: readonly string[];
  readonly key?: string;
  readonly attributes: readonly string[];
}

function changedAttributes(
  snapshot: FortiObjectSnapshot, object: FortiObject,
): readonly string[] {
  const changed: string[] = [];
  for (const spec of object.spec.attributes) {
    const before = (snapshot.values.get(spec.name) ?? []).join(' ');
    const after = (object.explicit(spec.name) ?? []).join(' ');
    if (before !== after) changed.push(spec.name);
  }
  return changed;
}

export interface NavigatorDeps {
  readonly tree: FortiConfigTree;
  readonly validator: FortiValidator;
  readonly commitContext: () => FortiCommitContext;
  readonly onConfigured?: (change: FortiConfigChange) => void;
  readonly expandVariables?: (value: string) => string;
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
    if (frame.kind === 'table') return lastPathWord(frame.table.spec);
    const spec = frame.object.spec;
    return spec.kind === 'object' ? lastPathWord(spec) : frame.object.key;
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
    if (!spec) return this.descendWithKeyOnConfigLine(words);
    if (spec.unavailable) return FortiMessages.commandFail(spec.unavailable);

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

  private descendWithKeyOnConfigLine(words: readonly string[]): string {
    const spec = words.length > 1 ? this.deps.tree.spec(words.slice(0, -1)) : undefined;
    if (!spec || spec.keyOnConfigLine !== true) {
      return FortiMessages.unknownPath(words.join(' '));
    }
    if (spec.unavailable) return FortiMessages.commandFail(spec.unavailable);

    this.stack.push({ kind: 'table', table: this.deps.tree.table(spec) });
    const opened = this.edit(words[words.length - 1]);
    if (opened !== EMPTY) this.stack.pop();
    return opened;
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

    const refusedKey = this.refusedKey(resolved);
    if (refusedKey) return refusedKey;

    const full = this.refusedWhenFull(table, resolved);
    if (full) return full;

    if (spec.fixedKeys && !spec.fixedKeys.includes(resolved)) {
      return FortiMessages.unknownKey(resolved);
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

    const verdict = this.deps.validator.validate(spec, values);
    if (!verdict.ok) return verdict.error;

    const expanded = verdict.values.map(
      value => this.deps.expandVariables?.(unquote(value)) ?? unquote(value));
    const cleaned = spec.secret === true
      ? [decodeStoredSecret(expanded)]
      : expanded;

    object.set(attribute, cleaned);
    spec.appliesImmediately?.(cleaned, {
      ...this.deps.commitContext(), position: -1,
    });
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

    const refusal = this.commit(frame.object);
    if (refusal) return FortiMessages.commandFail(refusal);

    this.announce(frame);
    this.stack.pop();
    return EMPTY;
  }

  end(): string {
    const frame = this.top();
    if (!frame) return EMPTY;

    if (frame.kind === 'object') {
      const refusal = this.commit(frame.object);
      if (refusal) return FortiMessages.commandFail(refusal);

      this.announce(frame);
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
      else {
        frame.object.restore(frame.snapshot);
        this.reapplyImmediate(frame.object);
      }
    }
    return EMPTY;
  }

  private reapplyImmediate(object: FortiObject): void {
    for (const spec of object.availableAttributes()) {
      if (!spec.appliesImmediately) continue;
      spec.appliesImmediately(object.effective(spec.name), this.deps.commitContext());
    }
  }

  delete(key: string | undefined): string {
    const table = this.currentTable();
    if (!table) return FortiMessages.outsideTable('delete');
    if (key === undefined) return FortiMessages.incomplete('the key to delete');

    const resolved = unquote(key);
    if (!table.has(resolved)) return FortiMessages.unknownKey(resolved);
    if (referencesTo(this.deps.tree, table.spec.path, resolved).length > 0) {
      return FortiMessages.commandFail(
        'Entry is used by other entries. Cannot be deleted.');
    }
    table.remove(resolved);

    table.spec.onDelete?.(resolved, this.deps.commitContext());
    this.deps.onConfigured?.({
      action: 'Delete', path: table.spec.path, key: resolved, attributes: [],
    });
    return EMPTY;
  }

  purge(): string {
    const table = this.currentTable();
    if (!table) return FortiMessages.outsideTable('purge');

    const context = this.deps.commitContext();
    for (const key of table.purge()) table.spec.onDelete?.(key, context);
    return EMPTY;
  }

  private refusedWhenFull(table: FortiTable, key: string): string | null {
    const ceiling = table.spec.maxEntries?.(
      { ...this.deps.commitContext(), position: -1 });
    if (ceiling === undefined || table.has(key)) return null;
    if (table.keys().length < ceiling) return null;
    return FortiMessages.commandFail(
      `maximum number of entries has been reached (${ceiling}).`);
  }

  private refusedKey(key: string): string | null {
    const character = reservedCharacterIn(key);
    if (character === null) return null;
    return FortiMessages.valueError(key, reservedCharacterHint(character));
  }

  clone(words: readonly string[]): string {
    const table = this.currentTable();
    if (!table) return FortiMessages.outsideTable('clone');

    const parsed = parsePair(words, 'to');
    if (!parsed) return FortiMessages.incomplete('`clone <key> to <new-key>`');
    const refused = this.refusedKey(parsed.to);
    if (refused) return refused;
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
    const refused = this.refusedKey(parsed.to);
    if (refused) return refused;
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

  deleteEveryObject(): void {
    const base = { ...this.deps.commitContext(), position: -1 };
    const tables = [...this.deps.tree.existingTables()]
      .sort((a, b) => b.spec.renderOrder - a.spec.renderOrder);
    for (const table of tables) {
      const onDelete = table.spec.onDelete;
      if (onDelete === undefined) continue;
      for (const key of table.keys()) {
        if (table.spec.predefined?.includes(key)) continue;
        try { onDelete(key, base); } catch { continue; }
      }
    }
  }

  commitDefaults(spec: FortiTableSpec): void {
    if (spec.kind !== 'object' || spec.onCommit === undefined) return;
    const object = this.deps.tree.singleton(spec);
    spec.onCommit(object, { ...this.deps.commitContext(), position: -1 });
  }

  private commit(object: FortiObject, owner?: FortiTable | null): string | void {
    const table = owner ?? this.ownerOf(object);
    const position = table ? table.keys().indexOf(object.key) : -1;
    return object.spec.onCommit?.(object, { ...this.deps.commitContext(), position });
  }

  private announce(frame: ObjectFrame): void {
    const announce = this.deps.onConfigured;
    if (!announce) return;

    const changed = changedAttributes(frame.snapshot, frame.object);
    if (!frame.existed) {
      announce({
        action: 'Add', path: frame.object.spec.path,
        key: frame.owner ? frame.object.key : undefined, attributes: changed,
      });
      return;
    }
    if (changed.length === 0) return;
    announce({
      action: 'Edit', path: frame.object.spec.path,
      key: frame.owner ? frame.object.key : undefined, attributes: changed,
    });
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

function lastPathWord(spec: { path: readonly string[] }): string {
  return spec.path[spec.path.length - 1];
}

function decodeStoredSecret(values: readonly string[]): string {
  const joined = values.join(' ');
  return joined.startsWith(ENC_PREFIX) ? clearOf(joined) : joined;
}
