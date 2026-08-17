import { argumentAccepts, type ArgumentSpec, type EnumValue } from '../../../../../cli/ArgumentTypes';
import { CommandTable, type CommandSpec } from '../../../../../cli/CommandTable';
import { newSession, type CliSession } from '../../../../../cli/CliSession';
import { parseCommand } from '../../../../../cli/CommandParser';
import { complete, type CompletionTrigger, type Suggestion } from '../../../../../cli/CompletionEngine';
import { FortiMessages } from './FortiMessages';
import type { FortiAttributeSpec, FortiTableSpec } from './schema/types';
import type { FortiConfigTree } from './runtime/FortiConfigTree';
import type { FortiNavigator } from './runtime/FortiNavigator';
import type { FortiObject } from './runtime/FortiObject';
import type { FortiTable } from './runtime/FortiTable';

const LEGENDS: ReadonlyArray<readonly [readonly string[], string]> = Object.freeze([
  [['config'], 'Configure object.'],
  [['diagnose'], 'Diagnose facility.'],
  [['set'], 'Set a field value.'],
  [['unset'], 'Reset a field to its default.'],
  [['append'], 'Append a value to a list.'],
  [['select'], 'Select a value from a list.'],
  [['unselect'], 'Remove a value from a list.'],
]);

const FORTI_MODES = Object.freeze({ forti: { parent: null } });
const FORTI_PROMPTS = Object.freeze({ forti: '{host} # ' });
const MODE = ['forti'];

export interface SocleDeps {
  readonly tree: FortiConfigTree;
  readonly nav: FortiNavigator;
  readonly hostname: () => string;
  readonly device: unknown;
  readonly candidatesFor: (targets: readonly string[]) => readonly EnumValue[];
  readonly view: (rest: readonly string[], full: boolean) => string;
  readonly inspect: (rest: readonly string[]) => string;
  readonly diagnose: (rest: readonly string[]) => string;
  readonly runExecute: (rest: readonly string[]) => string;
}

export interface FortiOutcome {
  readonly handled: boolean;
  readonly output: string;
}

const UNHANDLED: FortiOutcome = Object.freeze({ handled: false, output: '' });

function done(output: string): FortiOutcome {
  return { handled: true, output };
}

export class FortiSocle {
  private readonly cache = new Map<string, CommandTable>();

  constructor(private readonly deps: SocleDeps) {}

  execute(line: string): FortiOutcome {
    const table = this.contextTable();
    const session = this.session();
    const parsed = parseCommand(table, line, session);

    switch (parsed.status) {
      case 'empty': return done('');
      case 'ambiguous':
        return done(FortiMessages.ambiguous(parsed.token, parsed.candidates));
      case 'incomplete':
        return done(FortiMessages.incomplete('la suite de la commande'));
      case 'invalid': return UNHANDLED;
      case 'ok': {
        const output = parsed.spec.run(session, parsed.args);
        return done(typeof output === 'string' ? output : '');
      }
    }
  }

  suggestions(input: string, trigger: CompletionTrigger): readonly Suggestion[] {
    return complete(this.contextTable(), input, this.session(), trigger).suggestions;
  }

  completion(input: string): string | undefined {
    return complete(this.contextTable(), input, this.session(), 'TAB').completion;
  }

  private session(): CliSession {
    return newSession(this.deps.hostname(), this.deps.device, {
      hierarchy: FORTI_MODES, prompts: FORTI_PROMPTS,
      topLevel: 'forti', execLevel: 'forti', initialMode: 'forti',
    });
  }

  private contextTable(): CommandTable {
    const key = this.contextKey();
    const cached = this.cache.get(key);
    if (cached) return cached;

    const table = new CommandTable();
    for (const spec of this.contextSpecs()) table.declare(spec);
    for (const [path, legend] of LEGENDS) table.describePath(path, legend);
    this.cache.set(key, table);
    return table;
  }

  private contextKey(): string {
    const object = this.deps.nav.currentObject();
    if (object) {
      const shape = object.availableAttributes().map(a => a.name).join(',');
      return `object:${object.spec.path.join(' ')}:${shape}:${this.referenceStamp(object)}`;
    }
    const table = this.deps.nav.currentTable();
    if (table) return `table:${table.spec.path.join(' ')}:${table.keys().join(',')}`;
    return `root:${this.deps.tree.specPaths().length}`;
  }

  private referenceStamp(object: FortiObject): string {
    const parts: string[] = [];
    for (const attribute of object.availableAttributes()) {
      if (!attribute.referenceTo) continue;
      parts.push(this.deps.candidatesFor(attribute.referenceTo).map(v => v.keyword).join('|'));
    }
    return parts.join(';');
  }

  private contextSpecs(): CommandSpec[] {
    const object = this.deps.nav.currentObject();
    if (object) return this.objectSpecs(object);

    const table = this.deps.nav.currentTable();
    if (table) return this.tableSpecs(table);

    return this.rootSpecs();
  }

  private rootSpecs(): CommandSpec[] {
    const out: CommandSpec[] = [];
    for (const path of this.deps.tree.specPaths()) {
      const spec = this.deps.tree.spec(path);
      if (!spec) continue;
      out.push(this.plain(
        `config ${path.join(' ')}`, ['config', ...path], spec.help,
        () => this.deps.nav.descend(path),
      ));
    }
    out.push(...this.viewSpecs());
    out.push(this.plain('diagnose sys session list',
      ['diagnose', 'sys', 'session', 'list'], 'List the session table.',
      () => this.deps.diagnose(['sys', 'session', 'list'])));
    out.push(this.plain('diagnose sys session stat',
      ['diagnose', 'sys', 'session', 'stat'], 'Session table statistics.',
      () => this.deps.diagnose(['sys', 'session', 'stat'])));
    out.push(this.withArgument('execute', ['execute',
      { name: 'command', type: 'REST', description: 'Command to execute.' }],
      'Execute static commands.',
      (_s, args) => this.deps.runExecute((args.command ?? '').split(/\s+/).filter(Boolean))));
    return out;
  }

  private tableSpecs(table: FortiTable): CommandSpec[] {
    const spec = table.spec;
    const keys: readonly EnumValue[] = table.keys().map(k => ({
      keyword: k, description: `Existing entry ${k}.`,
    }));
    const keyArgument: ArgumentSpec = {
      name: 'key',
      type: spec.keyType === 'integer' ? 'INT' : 'WORD',
      description: spec.keyType === 'integer' ? 'Entry ID.' : 'Entry name.',
    };

    const out: CommandSpec[] = [
      this.withArgument('edit', ['edit', { ...keyArgument, alternatives: keys }],
        'Add/edit a table value.', (_s, args) => this.deps.nav.edit(args.key)),
      this.withArgument('delete', ['delete', { ...keyArgument, alternatives: keys }],
        'Delete a table value.', (_s, args) => this.deps.nav.delete(args.key)),
      this.plain('purge', ['purge'], 'Purge all the table entries.',
        () => this.deps.nav.purge()),
      this.withArgument('clone', ['clone',
        { ...keyArgument, name: 'from', alternatives: keys }, 'to',
        { ...keyArgument, name: 'to' }],
        'Clone an object instance.',
        (_s, args) => this.deps.nav.clone([args.from, 'to', args.to])),
      this.withArgument('rename', ['rename',
        { ...keyArgument, name: 'from', alternatives: keys }, 'to',
        { ...keyArgument, name: 'to' }],
        'Rename a table value.',
        (_s, args) => this.deps.nav.rename([args.from, 'to', args.to])),
      this.plain('end', ['end'], 'End and save.', () => this.deps.nav.end()),
      this.plain('abort', ['abort'], 'Exit without saving.', () => this.deps.nav.abort()),
    ];

    if (spec.ordered) {
      out.push(this.withArgument('move', ['move',
        { ...keyArgument, name: 'from', alternatives: keys },
        {
          name: 'position', type: 'ENUM', description: 'Placement.',
          values: [
            { keyword: 'before', description: 'Place before the target.' },
            { keyword: 'after', description: 'Place after the target.' },
          ],
        },
        { ...keyArgument, name: 'to', alternatives: keys }],
        'Move an object instance.',
        (_s, args) => this.deps.nav.move([args.from, args.position, args.to])));
    }

    out.push(...this.viewSpecs());
    return out;
  }

  private objectSpecs(object: FortiObject): CommandSpec[] {
    const out: CommandSpec[] = [
      this.plain('next', ['next'], 'Save and exit the object.', () => this.deps.nav.next()),
      this.plain('end', ['end'], 'End and save.', () => this.deps.nav.end()),
      this.plain('abort', ['abort'], 'Exit without saving.', () => this.deps.nav.abort()),
    ];

    for (const attribute of object.availableAttributes()) {
      if (attribute.readOnly) continue;
      out.push(...this.attributeSpecs(attribute));
    }

    for (const name of object.childNames()) {
      const child = object.child(name);
      if (!child) continue;
      out.push(this.plain(`config ${name}`, ['config', name], child.spec.help,
        () => this.deps.nav.descend([name])));
    }

    out.push(...this.viewSpecs());
    return out;
  }

  private attributeSpecs(attribute: FortiAttributeSpec): CommandSpec[] {
    const value = this.valueArgument(attribute);
    const out: CommandSpec[] = [
      this.withArgument(`set ${attribute.name}`, ['set', attribute.name, ...value],
        attribute.help,
        (_s, args) => this.deps.nav.set(attribute.name, collect(value, args))),
      this.plain(`unset ${attribute.name}`, ['unset', attribute.name], attribute.help,
        () => this.deps.nav.unset(attribute.name)),
    ];

    if (!attribute.multiValue) return out;

    for (const verb of ['append', 'select', 'unselect'] as const) {
      out.push(this.withArgument(`${verb} ${attribute.name}`,
        [verb, attribute.name, ...value], attribute.help,
        (_s, args) => this.deps.nav[verb](attribute.name, collect(value, args))));
    }
    return out;
  }

  private valueArgument(attribute: FortiAttributeSpec): ArgumentSpec[] {
    if (attribute.unimplemented) {
      return [{ name: 'value', type: 'REST', description: attribute.help }];
    }
    if (attribute.multiValue) {
      const alternatives = attribute.referenceTo
        ? this.deps.candidatesFor(attribute.referenceTo)
        : undefined;
      return [{
        ...attribute.parts[0], name: 'value', type: 'REST',
        alternatives: alternatives && alternatives.length > 0 ? alternatives : undefined,
      }];
    }
    if (attribute.referenceTo) {
      const alternatives = this.deps.candidatesFor(attribute.referenceTo);
      return [{
        ...attribute.parts[0],
        alternatives: alternatives.length > 0 ? alternatives : undefined,
      }];
    }
    return [...attribute.parts];
  }

  private viewSpecs(): CommandSpec[] {
    return [
      this.withArgument('show', ['show',
        { name: 'path', type: 'REST', optional: true, description: 'Configuration path.' }],
        'Show configuration.',
        (_s, args) => this.deps.view(words(args.path), false)),
      this.withArgument('get', ['get',
        { name: 'path', type: 'REST', optional: true, description: 'Object path.' }],
        'Get dynamic and system information.',
        (_s, args) => this.deps.inspect(words(args.path))),
    ];
  }

  private plain(
    id: string, path: readonly string[], description: string, run: () => string,
  ): CommandSpec {
    return { id, path, description, modes: MODE, minPrivilege: 0, run: () => run() };
  }

  private withArgument(
    id: string,
    path: readonly (string | ArgumentSpec)[],
    description: string,
    run: (session: CliSession, args: Readonly<Record<string, string>>) => string,
  ): CommandSpec {
    return { id, path, description, modes: MODE, minPrivilege: 0, run };
  }
}

function words(raw: string | undefined): string[] {
  return (raw ?? '').split(/\s+/).filter(Boolean);
}

function collect(
  parts: readonly ArgumentSpec[], args: Readonly<Record<string, string>>,
): string[] {
  if (parts.length === 1 && parts[0].type === 'REST') return words(args[parts[0].name]);
  return parts.map(part => args[part.name]).filter(v => v !== undefined);
}

export function valueAccepted(part: ArgumentSpec, token: string): boolean {
  return argumentAccepts(part, token);
}

export function tableHelp(spec: FortiTableSpec): string {
  return spec.help;
}
