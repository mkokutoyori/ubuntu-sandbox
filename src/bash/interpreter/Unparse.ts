import type {
  AndOrList, Assignment, Command, CommandList, DBExpr, Pipeline, Redirection, SimpleCommand, Word,
} from '@/bash/parser/ASTNode';

const INDENT = '    ';

function word(node: Word): string {
  switch (node.type) {
    case 'LiteralWord': return node.value;
    case 'SingleQuotedWord': return `'${node.value}'`;
    case 'DoubleQuotedWord':
      return `"${node.parts.map((part) => {
        switch (part.type) {
          case 'text': return part.value;
          case 'variable': return part.braced ? `\${${part.name}${part.modifier ?? ''}}` : `$${part.name}`;
          case 'special': return `$${part.name}`;
          case 'command': return `$(${part.command})`;
          case 'arithmetic': return `$((${part.expression}))`;
        }
      }).join('')}"`;
    case 'VariableRef': return node.braced ? `\${${node.name}${node.modifier ?? ''}}` : `$${node.name}`;
    case 'CommandSubstitution': return node.backtick ? `\`${node.command}\`` : `$(${node.command})`;
    case 'ArithmeticSubstitution': return `$((${node.expression}))`;
    case 'ProcessSubstitution': return `${node.direction === 'in' ? '<' : '>'}(${node.command})`;
    case 'CompoundWord': return node.parts.map(word).join('');
  }
}

function redirection(node: Redirection): string {
  const target = word(node.target);
  if (node.op === '<<<' || node.op === '<<') return `${node.fd ?? ''}${node.op} ${target}`;
  if (node.op === '>&' || node.op === '<&') return `${node.fd ?? (node.op === '>&' ? 1 : 0)}${node.op}${target}`;
  return `${node.fd ?? ''}${node.op} ${target}`;
}

function assignment(node: Assignment): string {
  const subscript = node.subscript === undefined ? '' : `[${node.subscript}]`;
  const operator = node.append ? '+=' : '=';
  if (node.arrayElements !== undefined) return `${node.name}${subscript}${operator}(${node.arrayElements.map(word).join(' ')})`;
  return `${node.name}${subscript}${operator}${node.value === null ? '' : word(node.value)}`;
}

function simple(node: SimpleCommand): string {
  return [...node.assignments.map(assignment), ...node.words.map(word), ...node.redirections.map(redirection)].join(' ');
}

function trailing(redirections: readonly Redirection[]): string {
  return redirections.length === 0 ? '' : ` ${redirections.map(redirection).join(' ')}`;
}

function expression(node: DBExpr): string {
  switch (node.kind) {
    case 'or': return `${expression(node.left)} || ${expression(node.right)}`;
    case 'and': return `${expression(node.left)} && ${expression(node.right)}`;
    case 'not': return `! ${expression(node.expr)}`;
    case 'unary': return `${node.op} ${word(node.arg)}`;
    case 'binary': return `${word(node.lhs)} ${node.op} ${word(node.rhs)}`;
    case 'lit': return word(node.word);
  }
}

function pipeline(node: Pipeline, depth: number): string {
  const body = node.commands.map((command) => block(command, depth)).join(' | ');
  return node.negated ? `! ${body}` : body;
}

function andOr(node: AndOrList, depth: number): string {
  const rest = node.rest.map((part) => ` ${part.operator} ${pipeline(part.pipeline, depth)}`).join('');
  return `${pipeline(node.first, depth)}${rest}${node.background ? ' &' : ''}`;
}

function list(node: CommandList, depth: number, terminateLast: boolean): string {
  const pad = INDENT.repeat(depth);
  const entries = node.commands.map((entry) => `${pad}${andOr(entry, depth)}`);
  return entries.map((entry, index) => `${entry}${index < entries.length - 1 || terminateLast ? ';' : ''}\n`).join('');
}

function block(node: Command, depth: number): string {
  const pad = INDENT.repeat(depth);
  switch (node.type) {
    case 'SimpleCommand': return simple(node);
    case 'IfClause': {
      let out = `if ${listInline(node.condition)}; then\n${list(node.thenBody, depth + 1, true)}`;
      for (const elif of node.elifClauses) out += `${pad}elif ${listInline(elif.condition)}; then\n${list(elif.body, depth + 1, true)}`;
      if (node.elseBody !== null) out += `${pad}else\n${list(node.elseBody, depth + 1, true)}`;
      return `${out}${pad}fi${trailing(node.redirections)}`;
    }
    case 'ForClause': {
      const words = node.words === null ? '' : ` in ${node.words.map(word).join(' ')}`;
      return `${node.select ? 'select' : 'for'} ${node.variable}${words};\n${pad}do\n${list(node.body, depth + 1, true)}${pad}done${trailing(node.redirections)}`;
    }
    case 'CStyleForClause':
      return `for ((${node.init}; ${node.cond}; ${node.update}))\n${pad}do\n${list(node.body, depth + 1, true)}${pad}done`;
    case 'WhileClause':
      return `while ${listInline(node.condition)}; do\n${list(node.body, depth + 1, true)}${pad}done${trailing(node.redirections)}`;
    case 'UntilClause':
      return `until ${listInline(node.condition)}; do\n${list(node.body, depth + 1, true)}${pad}done${trailing(node.redirections)}`;
    case 'CaseClause': {
      let out = `case ${word(node.word)} in \n`;
      for (const item of node.items) {
        out += `${pad}${INDENT}${item.patterns.map(word).join(' | ')})\n`;
        if (item.body !== null) out += list(item.body, depth + 2, false);
        out += `${pad}${INDENT}${item.terminator ?? ';;'}\n`;
      }
      return `${out}${pad}esac${trailing(node.redirections)}`;
    }
    case 'FunctionDef': return `${node.name} () \n${block(node.body, depth)}`;
    case 'BraceGroup': return `{ \n${list(node.body, depth + 1, false)}${pad}}${trailing(node.redirections)}`;
    case 'Subshell': return `( ${node.body.commands.map((entry) => andOr(entry, depth)).join(`;\n${pad}`)} )${trailing(node.redirections)}`;
    case 'DoubleBracket': return `[[ ${expression(node.expr)} ]]`;
    case 'ArithmeticCommand': return `((${node.expression}))`;
  }
}

function listInline(node: CommandList): string {
  return node.commands.map((entry) => andOr(entry, 0)).join('; ');
}

export function functionDefinition(name: string, body: Command): string {
  return `${name} () \n${block(body, 0)}\n`;
}
