/** ---- Nœuds de l'AST (union discriminée) ---- */

export interface SimpleCommandNode {
  readonly kind: "command";
  readonly name: string;
  readonly argv: readonly string[]; // encore bruts : expansion plus tard
  readonly redirections: readonly RedirectionNode[];
}

export interface RedirectionNode {
  readonly kind: "redirect";
  readonly mode: "in" | "out" | "append";
  readonly target: string; // chemin de fichier
}

export interface PipelineNode {
  readonly kind: "pipeline";
  readonly stages: readonly SimpleCommandNode[]; // cmd1 | cmd2 | cmd3
}

export interface LogicalNode {
  readonly kind: "and" | "or"; // && / ||
  readonly left: ScriptNode;
  readonly right: ScriptNode;
}

export interface SequenceNode {
  readonly kind: "sequence"; // cmd1 ; cmd2
  readonly statements: readonly ScriptNode[];
}

export interface IfNode {
  readonly kind: "if";
  readonly condition: ScriptNode;
  readonly thenBranch: ScriptNode;
  readonly elseBranch?: ScriptNode;
}

export interface ForNode {
  readonly kind: "for";
  readonly variable: string;
  readonly items: readonly string[];
  readonly body: ScriptNode;
}

export interface WhileNode {
  readonly kind: "while";
  readonly condition: ScriptNode;
  readonly body: ScriptNode;
}

export interface AssignmentNode {
  readonly kind: "assign"; // x=valeur
  readonly name: string;
  readonly value: string;
}

export interface SubshellNode {
  readonly kind: "subshell"; // ( … ) : session clonée
  readonly body: ScriptNode;
}

export type ScriptNode =
  | SimpleCommandNode
  | PipelineNode
  | LogicalNode
  | SequenceNode
  | IfNode
  | ForNode
  | WhileNode
  | AssignmentNode
  | SubshellNode;
