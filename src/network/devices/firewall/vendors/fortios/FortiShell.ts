import { renderTable, FIXED_TABLE } from '../../../shells/cli/TextTable';
import type { FortiGate } from './FortiGate';
import { FORTIOS_PROFILE } from './FortiProfile';
import {
  FortiMessages, FORTI_COMMAND_FAIL, setHintsEnabled,
} from './FortiMessages';
import { schemaIndex } from './schema';
import type { FortiAttributeSpec, FortiCommitContext, FortiTableSpec } from './schema/types';
import { FortiConfigTree } from './runtime/FortiConfigTree';
import { FortiNavigator, unquote } from './runtime/FortiNavigator';
import { FortiValidator } from './runtime/FortiValidator';
import { renderPath, renderWholeConfig } from './render/showRenderer';
import { renderGet } from './render/getRenderer';

export { FORTI_COMMAND_FAIL };

const ROOT_VERBS: ReadonlyArray<{ word: string; help: string }> = Object.freeze([
  { word: 'config', help: 'Configure object.' },
  { word: 'diagnose', help: 'Diagnose facility.' },
  { word: 'execute', help: 'Execute static commands.' },
  { word: 'get', help: 'Get dynamic and system information.' },
  { word: 'show', help: 'Show configuration.' },
]);

const TABLE_VERBS: ReadonlyArray<{ word: string; help: string }> = Object.freeze([
  { word: 'clone', help: 'Clone an object instance.' },
  { word: 'delete', help: 'Delete a table value.' },
  { word: 'edit', help: 'Add/edit a table value.' },
  { word: 'end', help: 'End and save.' },
  { word: 'get', help: 'Get dynamic and system information.' },
  { word: 'move', help: 'Move an object instance.' },
  { word: 'purge', help: 'Purge all the table entries.' },
  { word: 'rename', help: 'Rename a table value.' },
  { word: 'show', help: 'Show configuration.' },
]);

const OBJECT_VERBS: ReadonlyArray<{ word: string; help: string }> = Object.freeze([
  { word: 'abort', help: 'Exit without saving.' },
  { word: 'append', help: 'Append a value to a list.' },
  { word: 'config', help: 'Configure a sub-table.' },
  { word: 'end', help: 'End and save.' },
  { word: 'get', help: 'Get dynamic and system information.' },
  { word: 'next', help: 'Save and exit the object.' },
  { word: 'select', help: 'Select a value from a list.' },
  { word: 'set', help: 'Set a field value.' },
  { word: 'show', help: 'Show configuration.' },
  { word: 'unselect', help: 'Remove a value from a list.' },
  { word: 'unset', help: 'Reset a field to its default.' },
]);

export class FortiShell {
  private readonly tree: FortiConfigTree;
  private readonly nav: FortiNavigator;
  private readonly validator: FortiValidator;
  private vdom = 'root';

  constructor(private readonly fw: FortiGate) {
    this.tree = new FortiConfigTree(schemaIndex());
    this.validator = new FortiValidator((target, name) => this.referenceExists(target, name));
    this.nav = new FortiNavigator({
      tree: this.tree,
      validator: this.validator,
      commitContext: () => this.commitContext(),
    });
  }

  getPrompt(): string {
    const host = this.fw.getName();
    const label = this.nav.label();
    return label === null ? `${host} # ` : `${host} (${label}) # `;
  }

  getConfigTree(): FortiConfigTree {
    return this.tree;
  }

  completions(input: string): readonly string[] {
    const prefix = input.trimStart();
    return this.candidates(prefix).filter(w => w.startsWith(prefix) && w !== prefix);
  }

  help(): readonly string[] {
    return this.describe(this.helpEntries());
  }

  execute(rawLine: string): string {
    const line = rawLine.trim();
    if (line.length === 0) return '';
    if (line.endsWith('?')) return this.helpFor(line.slice(0, -1)).join('\n');

    const tokens = splitTokens(line);
    const verb = tokens[0];
    const rest = tokens.slice(1);

    switch (verb) {
      case 'config':   return this.nav.descend(rest);
      case 'edit':     return this.nav.edit(rest[0]);
      case 'set':      return this.nav.set(rest[0], rest.slice(1));
      case 'unset':    return this.nav.unset(rest[0]);
      case 'append':   return this.nav.append(rest[0], rest.slice(1));
      case 'select':   return this.nav.select(rest[0], rest.slice(1));
      case 'unselect': return this.nav.unselect(rest[0], rest.slice(1));
      case 'next':     return this.nav.next();
      case 'end':      return this.nav.end();
      case 'abort':    return this.nav.abort();
      case 'delete':   return this.nav.delete(rest[0]);
      case 'purge':    return this.nav.purge();
      case 'clone':    return this.nav.clone(rest);
      case 'rename':   return this.nav.rename(rest);
      case 'move':     return this.nav.move(rest);
      case 'show':     return this.show(rest, false);
      case 'get':      return this.get(rest);
      case 'diagnose': return this.diagnose(rest);
      case 'execute':  return this.executeVerb(rest);
      case 'write':    return FortiMessages.noSaveNeeded();
      default:         return FortiMessages.unknownCommand(verb);
    }
  }

  private commitContext(): FortiCommitContext {
    return {
      policy: this.fw.getPolicyStore(),
      objects: this.fw.getObjectStore(),
      vdom: this.vdom,
      position: -1,
    };
  }

  private referenceExists(target: string, name: string): boolean {
    if (name === 'all' || name === 'any' || name === 'ALL') return true;

    const path = target.split(' ');
    const spec = this.tree.spec(path);
    if (spec && (spec.predefined ?? []).includes(name)) return true;

    const table = this.tree.existingTable(path);
    if (table?.has(name)) return true;

    if (target === 'system interface') return this.fw.getPort(name) !== undefined;
    if (target === 'system zone') return this.fw.getZoneTable().getZone(name) !== undefined;
    if (target === 'firewall service custom' || target === 'firewall service group') {
      return this.fw.getObjectStore().getService(name) !== undefined || name === 'ALL';
    }
    if (target.startsWith('firewall schedule')) return name === 'always';
    return false;
  }

  private show(rest: readonly string[], full: boolean): string {
    const words = rest[0] === 'full-configuration' ? rest.slice(1) : rest;
    const wantsFull = full || rest[0] === 'full-configuration';
    const options = { full: wantsFull };

    if (words.length === 0) return renderWholeConfig(this.tree, options).join('\n');

    const lines = renderPath(this.tree, words, options);
    if (lines === null) return FortiMessages.unknownPath(words.join(' '));
    return lines.join('\n');
  }

  private get(rest: readonly string[]): string {
    if (rest.length === 0) {
      const object = this.nav.currentObject();
      if (object) return renderGet(this.tree, object.spec.path, object.key)?.join('\n') ?? '';
      const table = this.nav.currentTable();
      if (table) return renderGet(this.tree, table.spec.path)?.join('\n') ?? '';
      return FortiMessages.incomplete('un chemin');
    }

    if (rest[0] === 'system' && rest[1] === 'status') return this.systemStatus();

    for (let take = Math.min(rest.length, 4); take >= 1; take--) {
      const path = rest.slice(0, take);
      if (!this.tree.spec(path)) continue;
      const key = rest[take] === undefined ? undefined : unquote(rest[take]);
      const lines = renderGet(this.tree, path, key);
      if (lines === null) return FortiMessages.unknownKey(key ?? '');
      return lines.join('\n');
    }
    return FortiMessages.unknownPath(rest.join(' '));
  }

  private systemStatus(): string {
    return [
      `Version: FortiGate-VM64 v${FORTIOS_PROFILE.defaultVersion},build2662`,
      `Hostname: ${this.fw.getName()}`,
      'Operation Mode: NAT',
      `Current virtual domain: ${this.vdom}`,
    ].join('\n');
  }

  private diagnose(rest: readonly string[]): string {
    if (rest[0] !== 'sys' || rest[1] !== 'session') {
      return FortiMessages.commandFail('seul `diagnose sys session` est disponible en phase 1.');
    }
    if (rest[2] === 'stat') {
      return `misc info: session_count=${this.fw.getSessionTable().count()}`;
    }
    if (rest[2] !== 'list') return FORTI_COMMAND_FAIL;

    return this.fw.getSessionTable().view().all().map(session =>
      `session info: proto=${session.c2s.protocol} proto_state=00`
      + ` duration=0 expire=${session.timeoutSec} timeout=${session.timeoutSec}\n`
      + 'hook=post dir=org act=noop'
      + ` ${session.c2s.sourceIP}:${session.c2s.sourcePort}`
      + `->${session.c2s.destIP}:${session.c2s.destPort}`).join('\n');
  }

  private executeVerb(rest: readonly string[]): string {
    if (rest.length === 0) return FortiMessages.incomplete('une commande');
    return FortiMessages.commandFail(
      `\`execute ${rest[0]}\` arrive en phase 4 ; la phase 1 ne livre que la grammaire.`,
    );
  }

  private helpFor(input: string): readonly string[] {
    const words = splitTokens(input.trim());
    if (words.length === 0) return this.describe(this.helpEntries());

    const verb = words[0];
    if (verb === 'config' && this.nav.currentObject() === undefined) {
      return this.describeBranches(words.slice(1));
    }
    if (verb === 'set' || verb === 'unset' || verb === 'append'
      || verb === 'select' || verb === 'unselect') {
      return this.describeAttributes(words.slice(1));
    }
    return this.describe(this.helpEntries());
  }

  private helpEntries(): ReadonlyArray<{ word: string; help: string }> {
    if (this.nav.currentObject()) return OBJECT_VERBS;
    if (this.nav.currentTable()) return TABLE_VERBS;
    return ROOT_VERBS;
  }

  private describeBranches(prefix: readonly string[]): readonly string[] {
    const names = this.tree.branchNames(prefix);
    if (names.length === 0) return [FORTI_COMMAND_FAIL];

    return this.describe(names.map(name => {
      const spec = this.tree.spec([...prefix, name]);
      return { word: name, help: spec ? spec.help : `Configure ${name}.` };
    }));
  }

  private describeAttributes(words: readonly string[]): readonly string[] {
    const object = this.nav.currentObject();
    if (!object) return [FORTI_COMMAND_FAIL];

    if (words.length >= 1 && words[0].length > 0) {
      const spec = object.attribute(words[0]);
      if (spec?.enumValues) {
        return this.describe(spec.enumValues.map(e => ({ word: e.value, help: e.help })));
      }
      if (spec) return this.describe([{ word: spec.name, help: spec.help }]);
    }
    return this.describe(object.availableAttributes()
      .filter(a => !a.readOnly)
      .map(a => ({ word: a.name, help: a.help })));
  }

  private describe(entries: ReadonlyArray<{ word: string; help: string }>): readonly string[] {
    if (entries.length === 0) return [];
    const width = Math.max(20, ...entries.map(e => e.word.length + 2));
    return renderTable(entries, [
      { header: '', width, value: e => e.word },
      { header: '', width: 0, value: e => e.help },
    ], FIXED_TABLE).slice(1);
  }

  private candidates(prefix: string): readonly string[] {
    const words = splitTokens(prefix);
    const verbs = this.helpEntries().map(e => e.word);

    if (words.length <= 1 && !prefix.endsWith(' ')) return verbs;

    const verb = words[0];
    if (verb === 'config' && this.nav.currentObject() === undefined) {
      const typed = prefix.endsWith(' ') ? words.slice(1) : words.slice(1, -1);
      return this.tree.branchNames(typed).map(n => ['config', ...typed, n].join(' '));
    }
    if (verb === 'set' || verb === 'unset') {
      const object = this.nav.currentObject();
      if (!object) return [];
      return object.availableAttributes()
        .filter(a => !a.readOnly)
        .map(a => `${verb} ${a.name}`);
    }
    return verbs;
  }

  setHints(enabled: boolean): void {
    setHintsEnabled(enabled);
  }
}

export function attributesOf(spec: FortiTableSpec): readonly FortiAttributeSpec[] {
  return spec.attributes;
}

function splitTokens(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;

  for (const character of line) {
    if (character === '"') { quoted = !quoted; current += character; continue; }
    if (!quoted && /\s/.test(character)) {
      if (current.length > 0) { out.push(current); current = ''; }
      continue;
    }
    current += character;
  }
  if (current.length > 0) out.push(current);
  return out;
}
