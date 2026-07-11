import type { ITokenizer } from '@/command-kernel/ast/lexer';
import { Token, TokenType } from '@/command-kernel/ast/tokens';

/**
 * Tokenizer cmd.exe — délibérément séparé du `Lexer` bash de
 * command-kernel (voir `createWindowsHostShell.ts`) : guillemets doubles
 * qui basculent et se suppriment sans échappement (mêmes règles que
 * `splitCmdArgs`/`WindowsPC.parseCommandLine`, seule source déjà validée
 * par la suite de tests legacy — reproduite ici, pas réinventée), pas de
 * guillemets simples spéciaux, `&` seul est un opérateur de séquence
 * inconditionnelle (mappé sur `TokenType.SEMI`, sémantique identique au
 * `;` bash : toujours exécuter la suite), `#` n'est jamais un commentaire.
 */
export class CmdLexer implements ITokenizer {
  private source = '';
  private pos = 0;
  private line = 1;
  private column = 1;

  tokenize(source: string): Token[] {
    this.source = source;
    this.pos = 0;
    this.line = 1;
    this.column = 1;

    const tokens: Token[] = [];
    while (!this.atEnd()) {
      this.skipInlineWhitespace();
      if (this.atEnd()) break;

      const ch = this.peek();

      if (ch === '\n') {
        tokens.push(this.emit(TokenType.NEWLINE, '\n'));
        this.advance();
        continue;
      }
      if (ch === '|') {
        if (this.peek(1) === '|') {
          tokens.push(this.emit(TokenType.OR, '||'));
          this.advance();
          this.advance();
        } else {
          tokens.push(this.emit(TokenType.PIPE, '|'));
          this.advance();
        }
        continue;
      }
      if (ch === '&') {
        if (this.peek(1) === '&') {
          tokens.push(this.emit(TokenType.AND, '&&'));
          this.advance();
          this.advance();
        } else {
          // `&` seul : toujours exécuter la suite, quel que soit le code
          // de sortie — sémantique du `;` bash, donc TokenType.SEMI.
          tokens.push(this.emit(TokenType.SEMI, '&'));
          this.advance();
        }
        continue;
      }
      if (ch === '>') {
        if (this.peek(1) === '>') {
          tokens.push(this.emit(TokenType.REDIR_APPEND, '>>'));
          this.advance();
          this.advance();
        } else {
          tokens.push(this.emit(TokenType.REDIR_OUT, '>'));
          this.advance();
        }
        continue;
      }
      if (ch === '<') {
        tokens.push(this.emit(TokenType.REDIR_IN, '<'));
        this.advance();
        continue;
      }

      tokens.push(this.readWord());
    }

    tokens.push(this.emit(TokenType.EOF, ''));
    return tokens;
  }

  /** Règles exactes de `splitCmdArgs` : `"` bascule dedans/dehors et est
   *  supprimé, pas d'échappement, l'espace ne sépare que hors guillemets. */
  private readWord(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    let value = '';
    let inQuote = false;

    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === '"') {
        inQuote = !inQuote;
        this.advance();
        continue;
      }
      if (!inQuote && this.isWordBoundary(ch)) break;
      value += ch;
      this.advance();
    }

    // Un guillemet non fermé n'est PAS une erreur — `splitCmdArgs` (déjà
    // validé par la suite legacy) laisse simplement le reste de la ligne
    // en mode guillemet, comme le vrai cmd.exe.
    return { type: TokenType.WORD, value, line: startLine, column: startColumn };
  }

  private isWordBoundary(ch: string): boolean {
    return ' \t\n|&><'.includes(ch);
  }

  private skipInlineWhitespace(): void {
    while (!this.atEnd() && (this.peek() === ' ' || this.peek() === '\t')) this.advance();
  }

  private atEnd(): boolean {
    return this.pos >= this.source.length;
  }

  private peek(offset = 0): string {
    return this.source[this.pos + offset] ?? '';
  }

  private advance(): void {
    if (this.source[this.pos] === '\n') {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    this.pos++;
  }

  private emit(type: TokenType, value: string): Token {
    return { type, value, line: this.line, column: this.column };
  }
}
