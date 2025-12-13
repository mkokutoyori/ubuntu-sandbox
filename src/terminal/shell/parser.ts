/**
 * Shell Parser - Parses tokens into an AST
 *
 * Grammar (simplified):
 *   program     := pipeline ((';' | '&&' | '||' | '&') pipeline)*
 *   pipeline    := command ('|' command)*
 *   command     := simple_command redirect*
 *   redirect    := ('>' | '>>' | '<' | '2>' | '2>>' | '2>&1') word
 *   simple_cmd  := word+
 *   word        := WORD | STRING | VARIABLE | COMMAND_SUB | GLOB
 */

import { Token, TokenType, LexerResult, tokenize } from './lexer';

// ============================================
// AST Node Types
// ============================================

export type ASTNode =
  | ProgramNode
  | PipelineNode
  | CommandNode
  | SimpleCommandNode
  | RedirectionNode
  | WordNode;

export interface ProgramNode {
  type: 'Program';
  body: PipelineNode[];
  operators: ('&&' | '||' | ';' | '&')[];
}

export interface PipelineNode {
  type: 'Pipeline';
  commands: CommandNode[];
  background: boolean;
}

export interface CommandNode {
  type: 'Command';
  command: SimpleCommandNode;
  redirections: RedirectionNode[];
}

export interface SimpleCommandNode {
  type: 'SimpleCommand';
  name: WordNode;
  args: WordNode[];
  assignments: AssignmentNode[];
}

export interface AssignmentNode {
  type: 'Assignment';
  name: string;
  value: WordNode;
}

export interface RedirectionNode {
  type: 'Redirection';
  operator: '>' | '>>' | '<' | '<<' | '<<<' | '2>' | '2>>' | '1>' | '1>>' | '2>&1' | '1>&2';
  target: WordNode;
  fd?: number;
}

export interface WordNode {
  type: 'Word';
  value: string;
  parts: WordPart[];
  quoted: boolean;
  glob: boolean;
}

export type WordPart =
  | { type: 'literal'; value: string }
  | { type: 'variable'; name: string; braced: boolean }
  | { type: 'command'; command: string }
  | { type: 'glob'; pattern: string };

// ============================================
// Parse Result
// ============================================

export interface ParseResult {
  success: boolean;
  ast?: ProgramNode;
  error?: string;
  position?: number;
}

// ============================================
// Parser Class
// ============================================

export class ShellParser {
  private tokens: Token[];
  private position: number = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  /**
   * Parse tokens into AST
   */
  parse(): ParseResult {
    try {
      const program = this.parseProgram();
      return { success: true, ast: program };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Parse error',
        position: this.position,
      };
    }
  }

  // ============================================
  // Utility Methods
  // ============================================

  private peek(offset: number = 0): Token {
    return this.tokens[this.position + offset] || { type: TokenType.EOF, value: '', position: -1 };
  }

  private advance(): Token {
    return this.tokens[this.position++] || { type: TokenType.EOF, value: '', position: -1 };
  }

  private check(...types: TokenType[]): boolean {
    return types.includes(this.peek().type);
  }

  private match(...types: TokenType[]): Token | null {
    if (this.check(...types)) {
      return this.advance();
    }
    return null;
  }

  private isWordToken(token: Token): boolean {
    return [
      TokenType.WORD,
      TokenType.STRING_SINGLE,
      TokenType.STRING_DOUBLE,
      TokenType.VARIABLE,
      TokenType.COMMAND_SUB,
      TokenType.GLOB,
    ].includes(token.type);
  }

  private isAtEnd(): boolean {
    return this.peek().type === TokenType.EOF;
  }

  // ============================================
  // Parsing Methods
  // ============================================

  /**
   * Parse program: pipeline ((';' | '&&' | '||' | '&') pipeline)*
   */
  private parseProgram(): ProgramNode {
    const body: PipelineNode[] = [];
    const operators: ('&&' | '||' | ';' | '&')[] = [];

    // Skip leading newlines/semicolons
    while (this.match(TokenType.NEWLINE, TokenType.SEMICOLON)) {}

    // Parse first pipeline
    if (!this.isAtEnd()) {
      body.push(this.parsePipeline());
    }

    // Parse remaining pipelines
    while (!this.isAtEnd()) {
      const op = this.match(TokenType.AND, TokenType.OR, TokenType.SEMICOLON, TokenType.BACKGROUND);
      if (!op) break;

      // Skip any newlines after operator
      while (this.match(TokenType.NEWLINE)) {}

      if (this.isAtEnd()) {
        // Trailing operator is ok for ; and &
        if (op.type === TokenType.SEMICOLON || op.type === TokenType.BACKGROUND) {
          operators.push(op.value as '&&' | '||' | ';' | '&');
          break;
        }
      }

      operators.push(op.value as '&&' | '||' | ';' | '&');

      if (!this.isAtEnd()) {
        body.push(this.parsePipeline());
      }
    }

    return { type: 'Program', body, operators };
  }

  /**
   * Parse pipeline: command ('|' command)*
   */
  private parsePipeline(): PipelineNode {
    const commands: CommandNode[] = [];

    commands.push(this.parseCommand());

    while (this.match(TokenType.PIPE, TokenType.PIPE_STDERR)) {
      // Skip any newlines after pipe
      while (this.match(TokenType.NEWLINE)) {}
      commands.push(this.parseCommand());
    }

    // Check for background
    const background = this.peek().type === TokenType.BACKGROUND;

    return { type: 'Pipeline', commands, background };
  }

  /**
   * Parse command: simple_command redirect*
   */
  private parseCommand(): CommandNode {
    // Collect all redirections (can appear before, after, or between words)
    const redirections: RedirectionNode[] = [];
    const assignments: AssignmentNode[] = [];
    const words: WordNode[] = [];

    // Parse mix of words, redirections, and assignments
    while (!this.isAtEnd()) {
      // Check for redirection
      const redirection = this.tryParseRedirection();
      if (redirection) {
        redirections.push(redirection);
        continue;
      }

      // Check for word/variable/etc
      if (this.isWordToken(this.peek())) {
        const word = this.parseWord();

        // Check if it's an assignment (VAR=value)
        if (words.length === 0 && word.parts.length === 1 &&
            word.parts[0].type === 'literal' && word.parts[0].value.includes('=')) {
          const [name, ...valueParts] = word.parts[0].value.split('=');
          if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
            assignments.push({
              type: 'Assignment',
              name,
              value: { type: 'Word', value: valueParts.join('='), parts: [{ type: 'literal', value: valueParts.join('=') }], quoted: false, glob: false },
            });
            continue;
          }
        }

        words.push(word);
        continue;
      }

      // End of command
      break;
    }

    // Build simple command
    const command: SimpleCommandNode = {
      type: 'SimpleCommand',
      name: words[0] || { type: 'Word', value: '', parts: [], quoted: false, glob: false },
      args: words.slice(1),
      assignments,
    };

    return { type: 'Command', command, redirections };
  }

  /**
   * Try to parse a redirection
   */
  private tryParseRedirection(): RedirectionNode | null {
    const token = this.peek();

    // FD redirect (2>, 2>>, 2>&1, etc.)
    if (token.type === TokenType.REDIRECT_FD) {
      this.advance();
      const match = token.value.match(/^(\d)>(>?)(&?)(\d?)$/);
      if (match) {
        const [, fd, append, ampersand, targetFd] = match;

        // 2>&1 style
        if (ampersand && targetFd) {
          return {
            type: 'Redirection',
            operator: `${fd}>&${targetFd}` as any,
            target: { type: 'Word', value: targetFd, parts: [{ type: 'literal', value: targetFd }], quoted: false, glob: false },
            fd: parseInt(fd),
          };
        }

        // 2> or 2>> style
        const target = this.parseWord();
        return {
          type: 'Redirection',
          operator: (fd + '>' + append) as any,
          target,
          fd: parseInt(fd),
        };
      }
    }

    // Standard redirections
    const opMap: Record<string, RedirectionNode['operator']> = {
      [TokenType.REDIRECT_OUT]: '>',
      [TokenType.REDIRECT_APPEND]: '>>',
      [TokenType.REDIRECT_IN]: '<',
      [TokenType.HEREDOC]: '<<',
      [TokenType.HERESTRING]: '<<<',
    };

    const op = opMap[token.type];
    if (op) {
      this.advance();
      const target = this.parseWord();
      return { type: 'Redirection', operator: op, target };
    }

    return null;
  }

  /**
   * Get the expected end position of a token (after its content)
   */
  private getTokenEndPosition(token: Token): number {
    // For raw tokens (quotes, command subs), use raw length
    if (token.raw) {
      return token.position + token.raw.length;
    }
    // For strings, add 2 for the quotes
    if (token.type === TokenType.STRING_SINGLE || token.type === TokenType.STRING_DOUBLE) {
      return token.position + token.value.length + 2;
    }
    return token.position + token.value.length;
  }

  /**
   * Parse a word (can be composed of multiple parts if adjacent)
   * Only concatenates tokens that are immediately adjacent (no whitespace)
   */
  private parseWord(): WordNode {
    const parts: WordPart[] = [];
    let value = '';
    let quoted = false;
    let glob = false;
    let lastEndPosition = -1;

    // A word can be composed of multiple adjacent tokens (no whitespace between them)
    while (this.isWordToken(this.peek())) {
      const token = this.peek();

      // If there's a gap between this token and the previous one, stop
      // (tokens are only part of the same word if they're immediately adjacent)
      if (lastEndPosition >= 0 && token.position > lastEndPosition) {
        break;
      }

      this.advance();
      lastEndPosition = this.getTokenEndPosition(token);

      switch (token.type) {
        case TokenType.WORD:
          parts.push({ type: 'literal', value: token.value });
          value += token.value;
          break;

        case TokenType.STRING_SINGLE:
          parts.push({ type: 'literal', value: token.value });
          value += token.value;
          quoted = true;
          break;

        case TokenType.STRING_DOUBLE:
          // Double-quoted strings may contain variables
          parts.push({ type: 'literal', value: token.value });
          value += token.value;
          quoted = true;
          break;

        case TokenType.VARIABLE:
          const varValue = token.value;
          if (varValue.startsWith('${')) {
            const name = varValue.slice(2, -1);
            parts.push({ type: 'variable', name, braced: true });
          } else {
            const name = varValue.slice(1);
            parts.push({ type: 'variable', name, braced: false });
          }
          value += token.value;
          break;

        case TokenType.COMMAND_SUB:
          parts.push({ type: 'command', command: token.value });
          value += token.raw || `$(${token.value})`;
          break;

        case TokenType.GLOB:
          parts.push({ type: 'glob', pattern: token.value });
          value += token.value;
          glob = true;
          break;
      }
    }

    return { type: 'Word', value, parts, quoted, glob };
  }
}

// ============================================
// Convenience Functions
// ============================================

/**
 * Parse shell input string into AST
 */
export function parseShellInput(input: string): ParseResult {
  const lexerResult = tokenize(input);
  if (!lexerResult.success) {
    return {
      success: false,
      error: lexerResult.error,
      position: lexerResult.position,
    };
  }

  const parser = new ShellParser(lexerResult.tokens);
  return parser.parse();
}

/**
 * Convert AST back to string (for debugging)
 */
export function astToString(node: ASTNode): string {
  switch (node.type) {
    case 'Program':
      return node.body.map((p, i) =>
        astToString(p) + (node.operators[i] ? ' ' + node.operators[i] + ' ' : '')
      ).join('').trim();

    case 'Pipeline':
      return node.commands.map(c => astToString(c)).join(' | ');

    case 'Command': {
      let result = astToString(node.command);
      for (const redir of node.redirections) {
        result += ' ' + astToString(redir);
      }
      return result;
    }

    case 'SimpleCommand': {
      const parts: string[] = [];
      for (const assign of node.assignments) {
        parts.push(`${assign.name}=${astToString(assign.value)}`);
      }
      parts.push(astToString(node.name));
      for (const arg of node.args) {
        parts.push(astToString(arg));
      }
      return parts.join(' ');
    }

    case 'Redirection':
      return `${node.operator} ${astToString(node.target)}`;

    case 'Word':
      return node.value;

    default:
      return '';
  }
}
