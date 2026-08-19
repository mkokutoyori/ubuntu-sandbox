import {
  ARGUMENT_TYPES,
  isArgumentSpec,
  type ArgumentSpec,
} from './ArgumentTypes';
import type { CliSession } from './CliSession';

export type CommandStep = string | ArgumentSpec;

/**
 * Ce qu'on demande a une commande : peut-on l'EXECUTER, ou doit-on la
 * PROPOSER ?
 *
 * `hidden` distingue les deux. Une commande cachee s'execute et ne se
 * propose pas — c'est ce que le trie exprimait par son filtre de
 * completion, et le champ existait au socle sans que personne ne le
 * lise. `modeStrict` refuse les modes ANCETRES, que l'execution admet.
 */
export interface ReachabilityOptions {
  readonly modeStrict?: boolean;
  readonly forHelp?: boolean;
}

export type CommandHandler = (
  session: CliSession,
  args: Readonly<Record<string, string>>,
) => string | Promise<string>;

export interface CommandSpec {
  readonly id: string;
  readonly path: readonly CommandStep[];
  readonly description: string;
  readonly modes: readonly string[];
  readonly enters?: string;
  readonly contextField?: string;
  readonly contextFrom?: string;
  readonly minPrivilege: number;
  readonly run: CommandHandler;
  readonly undo?: CommandHandler;
  readonly hidden?: boolean;
  /**
   * Ce que le CONTEXTE autorise, quand le mode ne suffit pas a le dire.
   *
   * `parity` existe sur une ligne console et pas sur une vty : ce n'est
   * ni un mode different ni un niveau different, c'est la ligne
   * selectionnee. Le predicat est consulte par l'aide ET par
   * l'execution, sans quoi `?` cacherait une commande que la machine
   * accepte — ou l'inverse.
   */
  readonly reachableWhen?: (session: CliSession) => boolean;
  readonly existsOnlyNegated?: boolean;
  readonly undoDescription?: string;
}

export class DuplicateCommandError extends Error {
  constructor(readonly path: string) {
    super(`command already declared: ${path}`);
    this.name = 'DuplicateCommandError';
  }
}

export class UnknownArgumentTypeError extends Error {
  constructor(readonly type: string) {
    super(`unknown argument type: ${type}`);
    this.name = 'UnknownArgumentTypeError';
  }
}

export class EmptyCommandPathError extends Error {
  constructor(readonly id: string) {
    super(`command '${id}' declares no path`);
    this.name = 'EmptyCommandPathError';
  }
}

export interface TreeNode {
  readonly keyword?: string;
  readonly argument?: ArgumentSpec;
  readonly children: Map<string, TreeNode>;
  argumentChild?: TreeNode;
  spec?: CommandSpec;
  /**
   * Ce que `?` ecrit d'un noeud qui n'est PAS une commande.
   *
   * Sans elle, un noeud intermediaire herite de la description de son
   * premier descendant : `config ?` annoncait « Configure IPv4
   * addresses. » pour le mot `config`, c'est-a-dire la description
   * d'UNE des branches pour le nom de TOUTES. L'heritage reste le
   * defaut — il convient quand la branche est unique — et cette
   * legende le remplace quand le noeud merite le sien.
   */
  legend?: string;
}

function newNode(keyword?: string, argument?: ArgumentSpec): TreeNode {
  return { keyword, argument, children: new Map() };
}

export interface AuthorizationPort {
  authorizes(commandText: string, defaultLevel: number, session: CliSession): boolean;
}

export class CommandTable {
  private readonly root: TreeNode = newNode();
  private readonly byId = new Map<string, CommandSpec>();
  private readonly privilegeOverrides = new Map<string, number>();
  private authorization: AuthorizationPort | null = null;

  declare(spec: CommandSpec): void {
    if (spec.path.length === 0) throw new EmptyCommandPathError(spec.id);

    let node = this.root;
    for (const step of spec.path) {
      if (isArgumentSpec(step) && step.optional && !node.spec) node.spec = spec;
      node = isArgumentSpec(step)
        ? this.descendArgument(node, step)
        : this.descendKeyword(node, step);
    }

    if (node.spec) throw new DuplicateCommandError(pathText(spec.path));
    node.spec = spec;
    this.byId.set(spec.id, spec);
  }

  private descendKeyword(node: TreeNode, keyword: string): TreeNode {
    const existing = node.children.get(keyword);
    if (existing) return existing;

    const created = newNode(keyword);
    node.children.set(keyword, created);
    return created;
  }

  private descendArgument(node: TreeNode, argument: ArgumentSpec): TreeNode {
    if (!(argument.type in ARGUMENT_TYPES)) {
      throw new UnknownArgumentTypeError(argument.type);
    }
    if (!node.argumentChild) node.argumentChild = newNode(undefined, argument);
    return node.argumentChild;
  }

  rootNode(): TreeNode { return this.root; }

  describePath(path: readonly string[], legend: string): void {
    let node = this.root;
    for (const keyword of path) node = this.descendKeyword(node, keyword);
    node.legend = legend;
  }

  specs(): readonly CommandSpec[] { return [...this.byId.values()]; }

  byIdentifier(id: string): CommandSpec | undefined { return this.byId.get(id); }

  setPrivilegeOverride(path: readonly string[], level: number): void {
    this.privilegeOverrides.set(path.join(' '), level);
  }

  clearPrivilegeOverride(path: readonly string[]): void {
    this.privilegeOverrides.delete(path.join(' '));
  }

  requiredPrivilege(spec: CommandSpec): number {
    const keywords = spec.path.filter((step): step is string => !isArgumentSpec(step));
    return this.privilegeOverrides.get(keywords.join(' ')) ?? spec.minPrivilege;
  }

  attachAuthorization(port: AuthorizationPort | null): void {
    this.authorization = port;
  }

  isReachable(
    spec: CommandSpec, session: CliSession, options: ReachabilityOptions = {},
  ): boolean {
    if (options.forHelp && spec.hidden) return false;
    if (spec.reachableWhen && !spec.reachableWhen(session)) return false;
    if (options.modeStrict ? !spec.modes.includes(session.mode)
      : !this.modeAdmits(spec, session)) return false;

    const required = this.requiredPrivilege(spec);
    if (this.authorization) {
      return this.authorization.authorizes(pathTextOf(spec), required, session);
    }
    return session.privilegeLevel >= required;
  }

  admetLeMode(spec: CommandSpec, session: CliSession): boolean {
    return this.modeAdmits(spec, session);
  }

  private modeAdmits(spec: CommandSpec, session: CliSession): boolean {
    if (spec.modes.includes(session.mode)) return true;
    return session.configAncestors().some(mode => spec.modes.includes(mode));
  }

  childKeywordsOf(path: readonly string[]): readonly string[] {
    let node: TreeNode | undefined = this.root;
    for (const keyword of path) {
      node = node?.children.get(keyword);
      if (!node) return [];
    }
    return [...node.children.keys()];
  }
}

export function pathTextOf(spec: CommandSpec): string {
  return spec.path.filter((step): step is string => !isArgumentSpec(step)).join(' ');
}

function pathText(path: readonly CommandStep[]): string {
  return path.map(step => (isArgumentSpec(step) ? `<${step.name}>` : step)).join(' ');
}
