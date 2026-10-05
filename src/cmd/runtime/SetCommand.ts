import type { BatchHost, CommandOutcome } from '../BatchHost';
import { ArithmeticError, evaluateArithmetic } from './Arithmetic';

const SYNTAX_ERROR = 'The syntax of the command is incorrect.';

function listVariables(host: BatchHost, prefix: string): string[] {
  const wanted = prefix.toUpperCase();
  return host.env.names()
    .filter(name => name.toUpperCase().startsWith(wanted))
    .sort((left, right) => left.toUpperCase().localeCompare(right.toUpperCase()))
    .map(name => `${name}=${host.env.get(name) ?? ''}`);
}

function unwrapQuotes(text: string): string {
  const trimmed = text.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

function assign(host: BatchHost, definition: string): CommandOutcome {
  const equals = definition.indexOf('=');
  const name = definition.slice(0, equals);
  if (name.trim() === '') return { output: SYNTAX_ERROR, exitCode: 1 };
  const value = definition.slice(equals + 1);
  if (value === '') host.env.unset(name);
  else host.env.set(name, value);
  return { output: '', exitCode: 0 };
}

export async function executeSet(
  host: BatchHost, argumentText: string, options: { printsResult: boolean },
): Promise<CommandOutcome> {
  const text = argumentText.replace(/^\s+/, '');
  if (text === '') return { output: listVariables(host, '').join('\n'), exitCode: 0 };

  const switchMatch = /^\/([ap])\s*(.*)$/is.exec(text);
  if (switchMatch && switchMatch[1].toLowerCase() === 'a') {
    const expression = unwrapQuotes(switchMatch[2]);
    try {
      const value = evaluateArithmetic(expression, {
        get: name => host.env.get(name),
        set: (name, assigned) => host.env.set(name, assigned),
      });
      return { output: options.printsResult ? String(value) : '', exitCode: 0 };
    } catch (error) {
      if (error instanceof ArithmeticError) return { output: error.message, exitCode: 1 };
      throw error;
    }
  }
  if (switchMatch && switchMatch[1].toLowerCase() === 'p') {
    const definition = unwrapQuotes(switchMatch[2]);
    const equals = definition.indexOf('=');
    if (equals < 0) return { output: SYNTAX_ERROR, exitCode: 1 };
    const name = definition.slice(0, equals).trim();
    const answer = host.readInputLine ? await host.readInputLine(definition.slice(equals + 1)) : null;
    if (answer === null) return { output: '', exitCode: 1 };
    if (answer === '') host.env.unset(name);
    else host.env.set(name, answer);
    return { output: '', exitCode: 0 };
  }

  if (text.startsWith('"')) {
    const inner = unwrapQuotes(text);
    return inner.includes('=') ? assign(host, inner) : showVariable(host, inner);
  }
  if (!text.includes('=')) return showVariable(host, text.trim());
  return assign(host, text);
}

function showVariable(host: BatchHost, prefix: string): CommandOutcome {
  const found = listVariables(host, prefix);
  if (found.length === 0) return { output: `Environment variable ${prefix} not defined`, exitCode: 1 };
  return { output: found.join('\n'), exitCode: 0 };
}
