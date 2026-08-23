import { CommandTable, type CommandSpec } from '../../CommandTable';
import { newSession, type CliSession } from '../../CliSession';
import { parseCommand } from '../../CommandParser';
import { complete, type CompletionTrigger } from '../../CompletionEngine';
import { VRP_MODES, VRP_PROMPTS, VRP_TOP_LEVEL, VRP_EXEC_LEVEL } from './vrpModes';
import type { ModeHierarchy } from '../../../network/devices/shells/CLIStateMachine';
import { HUAWEI_ERRORS } from '../../../network/devices/shells/cli-utils';

export interface VrpHelpLine {
  readonly keyword: string;
  readonly description: string;
}

export function offsetOfWord(line: string, index: number): number {
  const re = /\S+/g;
  let n = 0;
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    if (n === index) return m.index;
    n += 1;
  }
  return line.trimEnd().length;
}

export class VrpSocle {
  private table: CommandTable | null = null;

  constructor(
    private readonly hostname: () => string,
    private readonly device: unknown,
    private readonly specs: () => readonly CommandSpec[],
    private readonly hierarchy: ModeHierarchy = VRP_MODES,
  ) {}

  private built(): CommandTable {
    if (!this.table) {
      this.table = new CommandTable();
      for (const spec of this.specs()) this.table.declare(spec);
    }
    return this.table;
  }

  private session(mode: string, fields: Record<string, string | undefined> = {}): CliSession {
    const s = newSession(this.hostname(), this.device, {
      hierarchy: this.hierarchy, prompts: VRP_PROMPTS,
      topLevel: VRP_TOP_LEVEL, execLevel: VRP_EXEC_LEVEL,
      initialMode: mode,
    });
    for (const [k, v] of Object.entries(fields)) s.fields[k] = v;
    return s;
  }

  private static negationVrp(line: string): string {
    return line.replace(/^\s*undo\s+/i, 'no ');
  }

  knows(line: string, mode: string): boolean {
    const l = VrpSocle.negationVrp(line);
    return parseCommand(this.built(), l, this.session(mode)).status === 'ok';
  }

  run(line: string, mode: string, fields?: Record<string, string | undefined>): string | null {
    const session = this.session(mode, fields);
    const parsed = parseCommand(this.built(), VrpSocle.negationVrp(line), session);
    if (parsed.status !== 'ok') return null;
    const handler = parsed.negated && parsed.spec.undo ? parsed.spec.undo : parsed.spec.run;
    const output = handler(session, parsed.args);
    return typeof output === 'string' ? output : null;
  }

  diagnostic(line: string, mode: string): string | null {
    const parsed = parseCommand(this.built(), VrpSocle.negationVrp(line), this.session(mode));
    if (parsed.status === 'ok') return null;
    if (parsed.status === 'incomplete') return HUAWEI_ERRORS.INCOMPLETE(line);
    if (parsed.status === 'ambiguous') return HUAWEI_ERRORS.AMBIGUOUS(line);
    if (parsed.status === 'invalid' && parsed.position > 0) {
      const offset = offsetOfWord(line, parsed.position);
      return parsed.refusePar === 'argument'
        ? HUAWEI_ERRORS.WRONG(line, offset)
        : HUAWEI_ERRORS.UNRECOGNIZED(line, offset);
    }
    return null;
  }

  /**
   * Le refus a opposer AVANT de laisser le trie repondre.
   *
   * Un enregistrement gourmand du trie (`registerGreedy('clock', …)`)
   * accepte tout ce qui commence par son mot-cle, donc il masquerait le
   * refus d'une famille migree. La question n'est posee que lorsque le
   * socle a RECONNU le chemin et refuse ce qui suit : un argument mal
   * forme, ou une commande incomplete dont il a deja consomme au moins
   * deux mots-cles. Toute autre issue rend `null`, et le trie garde la
   * main sur les formes qu'il est seul a connaitre.
   */
  refusalBeforeTrie(line: string, mode: string): string | null {
    const l = VrpSocle.negationVrp(line);
    const parsed = parseCommand(this.built(), l, this.session(mode));
    if (parsed.status === 'invalid' && parsed.refusePar === 'argument') {
      return HUAWEI_ERRORS.WRONG(line, offsetOfWord(line, parsed.position));
    }
    if (parsed.status === 'incomplete' && parsed.consumed >= 2) {
      return HUAWEI_ERRORS.INCOMPLETE(line);
    }
    // Un mot EN TROP derriere une commande que le socle connait
    // entierement : la ligne sans son dernier mot s'analyse, donc c'est
    // bien lui qui est de trop, et non la commande qui est etrangere.
    if (parsed.status === 'invalid' && parsed.position > 0) {
      const mots = l.trim().split(/\s+/);
      const sansDernier = mots.slice(0, -1).join(' ');
      if (parseCommand(this.built(), sansDernier, this.session(mode)).status === 'ok') {
        return HUAWEI_ERRORS.WRONG(line, offsetOfWord(line, mots.length - 1));
      }
    }
    return null;
  }

  suggestions(input: string, mode: string, trigger: CompletionTrigger): VrpHelpLine[] {
    return complete(this.built(), VrpSocle.negationVrp(input), this.session(mode), trigger).suggestions
      .map(s => ({ keyword: s.value, description: s.description }));
  }

  candidates(input: string, mode: string): string[] {
    const prefixe = input.trimStart();
    const tete = prefixe.endsWith(' ')
      ? prefixe
      : prefixe.slice(0, prefixe.lastIndexOf(' ') + 1);
    return this.suggestions(input, mode, 'TAB').map(s => `${tete}${s.keyword}`);
  }
}
