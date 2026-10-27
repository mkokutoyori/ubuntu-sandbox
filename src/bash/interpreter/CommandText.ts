import type {
  AndOrList, BraceGroup, CommandList, Pipeline, Redirection, SimpleCommand, Subshell, Word, WordPart,
} from '../parser/ASTNode';

type Command = Pipeline['commands'][number];

function partText(part: WordPart): string {
  switch (part.type) {
    case 'text': return part.value;
    case 'variable': return part.braced ? `\${${part.name}${part.modifier ?? ''}}` : `$${part.name}`;
    case 'special': return `$${part.name}`;
    case 'command': return `$(${part.command})`;
    case 'arithmetic': return `$((${part.expression}))`;
  }
}

export function wordText(word: Word): string {
  switch (word.type) {
    case 'LiteralWord': return word.value;
    case 'SingleQuotedWord': return `'${word.value}'`;
    case 'DoubleQuotedWord': return `"${word.parts.map(partText).join('')}"`;
    case 'VariableRef': return word.braced ? `\${${word.name}${word.modifier ?? ''}}` : `$${word.name}`;
    case 'CommandSubstitution': return word.backtick ? `\`${word.command}\`` : `$(${word.command})`;
    case 'ArithmeticSubstitution': return `$((${word.expression}))`;
    case 'ProcessSubstitution': return `${word.direction === 'in' ? '<' : '>'}(${word.command})`;
    case 'CompoundWord': return word.parts.map(wordText).join('');
  }
}

function redirectionText(redirection: Redirection): string {
  const fd = redirection.fd === undefined ? '' : String(redirection.fd);
  return `${fd}${redirection.op} ${wordText(redirection.target)}`;
}

function simpleText(command: SimpleCommand): string {
  const assignments = command.assignments.map((assignment) => `${assignment.name}=${assignment.value === null ? '' : wordText(assignment.value)}`);
  return [...assignments, ...command.words.map(wordText), ...command.redirections.map(redirectionText)].join(' ');
}

function commandText(command: Command): string {
  switch (command.type) {
    case 'SimpleCommand': return simpleText(command);
    case 'Subshell': return groupText(command, '( ', ' )');
    case 'BraceGroup': return groupText(command, '{ ', '; }');
    default: return '';
  }
}

function groupText(group: Subshell | BraceGroup, open: string, close: string): string {
  const redirections = group.redirections.length === 0 ? '' : ` ${group.redirections.map(redirectionText).join(' ')}`;
  return `${open}${listText(group.body)}${close}${redirections}`;
}

function pipelineText(pipeline: Pipeline): string {
  return `${pipeline.negated ? '! ' : ''}${pipeline.commands.map(commandText).join(' | ')}`;
}

function andOrText(item: AndOrList): string {
  const text = [pipelineText(item.first), ...item.rest.map((part) => `${part.operator} ${pipelineText(part.pipeline)}`)].join(' ');
  return item.background === true ? `${text} &` : text;
}

export function listText(list: CommandList): string {
  return list.commands.map(andOrText).join('; ');
}

export function backgroundGroupText(group: Subshell | BraceGroup): string {
  return commandText(group);
}
