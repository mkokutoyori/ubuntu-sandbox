import { renderTable, FIXED_TABLE } from '../../../shells/cli/TextTable';
import type { EnumValue } from '../../../../../cli/ArgumentTypes';
import type { Suggestion } from '../../../../../cli/CompletionEngine';
import type { FortiGate } from './FortiGate';
import { FORTIOS_PROFILE } from './FortiProfile';
import { FortiMessages, FORTI_COMMAND_FAIL, setHintsEnabled } from './FortiMessages';
import { FortiSocle } from './FortiSocle';
import { schemaIndex } from './schema';
import type { FortiCommitContext } from './schema/types';
import { FortiConfigTree } from './runtime/FortiConfigTree';
import { FortiNavigator, unquote } from './runtime/FortiNavigator';
import { FortiValidator } from './runtime/FortiValidator';
import { renderPath, renderWholeConfig } from './render/showRenderer';
import { renderGet } from './render/getRenderer';

export { FORTI_COMMAND_FAIL };

export class FortiShell {
  private readonly tree: FortiConfigTree;
  private readonly nav: FortiNavigator;
  private readonly socle: FortiSocle;
  private vdom = 'root';

  constructor(private readonly fw: FortiGate) {
    this.tree = new FortiConfigTree(schemaIndex());
    const validator = new FortiValidator(
      (target, name) => this.referenceExists(target, name));
    this.nav = new FortiNavigator({
      tree: this.tree,
      validator,
      commitContext: () => this.commitContext(),
    });
    this.socle = new FortiSocle({
      tree: this.tree,
      nav: this.nav,
      hostname: () => this.fw.getName(),
      device: this.fw,
      candidatesFor: (targets) => this.candidatesFor(targets),
      view: (rest, full) => this.show(rest, full),
      inspect: (rest) => this.get(rest),
      diagnose: (rest) => this.diagnose(rest),
      runExecute: (rest) => this.executeVerb(rest),
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
    const head = prefix.slice(0, prefix.lastIndexOf(' ') + 1);
    return this.socle.suggestions(prefix, 'TAB')
      .filter(s => !s.isArgument)
      .map(s => `${head}${s.value}`)
      .filter(w => w.startsWith(prefix) && w !== prefix);
  }

  help(): readonly string[] {
    return this.describe(this.socle.suggestions('', 'QUESTION_MARK'));
  }

  execute(rawLine: string): string {
    const line = rawLine.trim();
    if (line.length === 0) return '';
    if (line.endsWith('?')) {
      return this.describe(
        this.socle.suggestions(line.slice(0, -1), 'QUESTION_MARK')).join('\n');
    }

    if (/^write\b/.test(line)) return FortiMessages.noSaveNeeded();
    if (/^show\s+full-configuration\b/.test(line)) {
      return this.show(splitTokens(line).slice(2), true);
    }

    const outcome = this.socle.execute(line);
    if (outcome.handled) return outcome.output;
    return this.refusal(line);
  }

  private refusal(line: string): string {
    const tokens = splitTokens(line);
    const object = this.nav.currentObject();

    if ((tokens[0] === 'set' || tokens[0] === 'unset' || tokens[0] === 'append'
      || tokens[0] === 'select' || tokens[0] === 'unselect')) {
      if (!object) return FortiMessages.setOutside(this.nav.currentTable());
      if (tokens[1] === undefined) return FortiMessages.incomplete('un attribut');

      const attribute = object.attribute(tokens[1]);
      if (!attribute) {
        return FortiMessages.unknownAttribute(tokens[1], object.spec.path.join(' '));
      }
      if (attribute.unimplemented) {
        return FortiMessages.unimplemented(tokens[1], attribute.unimplemented);
      }
      if (!object.isAvailable(attribute)) {
        return FortiMessages.commandFail(
          `\`${tokens[1]}\` ne s'applique pas dans la configuration courante de cet objet.`);
      }
      if (tokens[0] !== 'set' && !attribute.multiValue) {
        return FortiMessages.notMultiValue(tokens[0], tokens[1]);
      }
      return this.nav.set(tokens[1], tokens.slice(2));
    }

    if (tokens[0] === 'config') {
      return FortiMessages.unknownPath(tokens.slice(1).join(' '));
    }
    if (tokens[0] === 'edit') {
      return object
        ? FortiMessages.notATable(object.spec.path.join(' '))
        : FortiMessages.outsideTable('edit');
    }
    if (tokens[0] === 'move') {
      const table = this.nav.currentTable();
      if (table && !table.spec.ordered) {
        return FortiMessages.notOrdered('move', table.spec.path.join(' '));
      }
      return this.nav.move(tokens.slice(1));
    }
    if (tokens[0] === 'delete' || tokens[0] === 'purge' || tokens[0] === 'clone'
      || tokens[0] === 'rename') {
      if (!this.nav.currentTable()) return FortiMessages.outsideTable(tokens[0]);
      return this.applyTableVerb(tokens);
    }
    if (tokens[0] === 'next' || tokens[0] === 'abort') {
      return FortiMessages.outsideObject(tokens[0]);
    }
    if (tokens[0] === 'end') return this.nav.end();

    return FortiMessages.unknownCommand(tokens[0]);
  }

  private applyTableVerb(tokens: readonly string[]): string {
    switch (tokens[0]) {
      case 'delete': return this.nav.delete(tokens[1]);
      case 'purge': return this.nav.purge();
      case 'clone': return this.nav.clone(tokens.slice(1));
      case 'rename': return this.nav.rename(tokens.slice(1));
      default: return FORTI_COMMAND_FAIL;
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

  private candidatesFor(targets: readonly string[]): readonly EnumValue[] {
    const out: EnumValue[] = [];
    const seen = new Set<string>();
    const push = (keyword: string, description: string): void => {
      if (seen.has(keyword)) return;
      seen.add(keyword);
      out.push({ keyword, description });
    };

    for (const target of targets) {
      const path = target.split(' ');
      const spec = this.tree.spec(path);
      for (const name of spec?.predefined ?? []) push(name, 'Predefined object.');

      const table = this.tree.existingTable(path);
      for (const key of table?.keys() ?? []) push(key, `Configured ${path[1] ?? target}.`);

      if (target === 'system interface') {
        for (const port of this.fw.getPortNames()) push(port, 'Physical interface.');
      }
      if (target === 'system zone') {
        for (const zone of this.fw.getZoneTable().list()) push(zone.name, 'Security zone.');
      }
      if (target === 'firewall service custom' || target === 'firewall service group') {
        push('ALL', 'All services.');
      }
      if (target.startsWith('firewall schedule')) push('always', 'Always active.');
    }
    return out;
  }

  private referenceExists(target: string, name: string): boolean {
    if (name === 'all' || name === 'any' || name === 'ALL') return true;
    return this.candidatesFor([target]).some(c => c.keyword === name);
  }

  private show(rest: readonly string[], full: boolean): string {
    const words = rest[0] === 'full-configuration' ? rest.slice(1) : rest;
    const options = { full: full || rest[0] === 'full-configuration' };

    if (words.length === 0) {
      const object = this.nav.currentObject();
      if (object) {
        return (renderPath(this.tree, object.spec.path, options) ?? []).join('\n');
      }
      const table = this.nav.currentTable();
      if (table) return (renderPath(this.tree, table.spec.path, options) ?? []).join('\n');
      return renderWholeConfig(this.tree, options).join('\n');
    }

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
    if (rest[2] === 'stat') {
      return `misc info: session_count=${this.fw.getSessionTable().count()}`;
    }
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

  private describe(suggestions: readonly Suggestion[]): readonly string[] {
    if (suggestions.length === 0) return [];
    const width = Math.max(20, ...suggestions.map(s => s.value.length + 2));
    return renderTable(suggestions, [
      { header: '', width, value: s => s.value },
      { header: '', width: 0, value: s => s.description },
    ], FIXED_TABLE).slice(1);
  }

  setHints(enabled: boolean): void {
    setHintsEnabled(enabled);
  }
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
