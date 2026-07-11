import type { ScriptNode } from '@/command-kernel/ast/nodes';

/**
 * cmd.exe command names are case-insensitive (`DIR`, `Dir`, `dir` all
 * resolve the same builtin) — but arguments are NOT (`echo Hello` must
 * keep its case). The shared `Parser` doesn't know this is cmd.exe, so it
 * preserves whatever case the `CmdLexer` handed it for `SimpleCommandNode.
 * name` — this walks the AST once after parsing and lowercases only the
 * command-name positions, never argv/redirection targets.
 */
export function lowercaseCommandNames(node: ScriptNode): ScriptNode {
  switch (node.kind) {
    case 'command':
      return { ...node, name: node.name.toLowerCase() };
    case 'pipeline':
      return { ...node, stages: node.stages.map((s) => ({ ...s, name: s.name.toLowerCase() })) };
    case 'and':
    case 'or':
      return { ...node, left: lowercaseCommandNames(node.left), right: lowercaseCommandNames(node.right) };
    case 'sequence':
      return { ...node, statements: node.statements.map(lowercaseCommandNames) };
    case 'if':
      return {
        ...node,
        condition: lowercaseCommandNames(node.condition),
        thenBranch: lowercaseCommandNames(node.thenBranch),
        elseBranch: node.elseBranch ? lowercaseCommandNames(node.elseBranch) : undefined,
      };
    case 'for':
      return { ...node, body: lowercaseCommandNames(node.body) };
    case 'while':
      return { ...node, condition: lowercaseCommandNames(node.condition), body: lowercaseCommandNames(node.body) };
    case 'subshell':
      return { ...node, body: lowercaseCommandNames(node.body) };
    case 'assign':
      return node;
  }
}
