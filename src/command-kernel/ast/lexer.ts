import { UsageError } from "../errors";
import { KEYWORDS, Token, TokenType } from "./tokens";

/**
 * Découpe la source en tokens : gère les guillemets simples/doubles,
 * les échappements ('\'), les opérateurs (| || && ; > >> < ( )),
 * les mots-clés (if/then/else/fi/for/in/while/do/done) et les
 * séparateurs de ligne.
 *
 * Les segments quotés adjacents sont fusionnés dans le même mot :
 * `foo"bar baz"qux` produit un seul WORD `foobar bazqux`.
 */
export class Lexer {
  private source = "";
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

      if (ch === "\n") {
        tokens.push(this.emit(TokenType.NEWLINE, "\n"));
        this.advance();
        continue;
      }
      if (ch === "#") {
        this.skipComment();
        continue;
      }
      if (ch === "|") {
        tokens.push(this.readOperator("|", "||", TokenType.PIPE, TokenType.OR));
        continue;
      }
      if (ch === "&") {
        if (this.peek(1) === "&") {
          tokens.push(this.emit(TokenType.AND, "&&"));
          this.advance();
          this.advance();
        } else {
          throw new UsageError(
            `caractère inattendu '&' (ligne ${this.line}, colonne ${this.column}) : les tâches de fond ne sont pas supportées`,
          );
        }
        continue;
      }
      if (ch === ";") {
        tokens.push(this.emit(TokenType.SEMI, ";"));
        this.advance();
        continue;
      }
      if (ch === ">") {
        if (this.peek(1) === ">") {
          tokens.push(this.emit(TokenType.REDIR_APPEND, ">>"));
          this.advance();
          this.advance();
        } else {
          tokens.push(this.emit(TokenType.REDIR_OUT, ">"));
          this.advance();
        }
        continue;
      }
      if (ch === "<") {
        tokens.push(this.emit(TokenType.REDIR_IN, "<"));
        this.advance();
        continue;
      }
      if (ch === "(") {
        tokens.push(this.emit(TokenType.LPAREN, "("));
        this.advance();
        continue;
      }
      if (ch === ")") {
        tokens.push(this.emit(TokenType.RPAREN, ")"));
        this.advance();
        continue;
      }

      tokens.push(this.readWord());
    }

    tokens.push(this.emit(TokenType.EOF, ""));
    return tokens;
  }

  private readOperator(
    single: string,
    double: string,
    singleType: TokenType,
    doubleType: TokenType,
  ): Token {
    if (this.peek(1) === single) {
      const tok = this.emit(doubleType, double);
      this.advance();
      this.advance();
      return tok;
    }
    const tok = this.emit(singleType, single);
    this.advance();
    return tok;
  }

  /** Lit un mot, en fusionnant segments nus, guillemets simples/doubles et échappements. */
  private readWord(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    let value = "";
    let sawSingleQuote = false;

    while (!this.atEnd() && !this.isWordBoundary(this.peek())) {
      const ch = this.peek();
      if (ch === "\\") {
        this.advance();
        if (this.atEnd()) {
          throw new UsageError("échappement '\\' incomplet en fin d'entrée");
        }
        value += this.peek();
        this.advance();
        continue;
      }
      if (ch === '"') {
        value += this.readDoubleQuoted();
        continue;
      }
      if (ch === "'") {
        sawSingleQuote = true;
        value += this.readSingleQuoted();
        continue;
      }
      value += ch;
      this.advance();
    }

    const type = KEYWORDS.get(value) ?? TokenType.WORD;
    return { type, value, line: startLine, column: startColumn, noExpand: sawSingleQuote };
  }

  private readDoubleQuoted(): string {
    this.advance(); // consomme '"'
    let value = "";
    while (!this.atEnd() && this.peek() !== '"') {
      const ch = this.peek();
      if (ch === "\\" && (this.peek(1) === '"' || this.peek(1) === "\\" || this.peek(1) === "$")) {
        this.advance();
        value += this.peek();
        this.advance();
        continue;
      }
      value += ch;
      this.advance();
    }
    if (this.atEnd()) throw new UsageError("guillemet double non fermé");
    this.advance(); // consomme '"' fermant
    return value;
  }

  private readSingleQuoted(): string {
    this.advance(); // consomme "'"
    let value = "";
    while (!this.atEnd() && this.peek() !== "'") {
      value += this.peek();
      this.advance();
    }
    if (this.atEnd()) throw new UsageError("guillemet simple non fermé");
    this.advance(); // consomme "'" fermant
    return value;
  }

  private isWordBoundary(ch: string): boolean {
    return " \t\n|&;><()".includes(ch);
  }

  private skipInlineWhitespace(): void {
    while (!this.atEnd() && (this.peek() === " " || this.peek() === "\t")) {
      this.advance();
    }
  }

  private skipComment(): void {
    while (!this.atEnd() && this.peek() !== "\n") this.advance();
  }

  private atEnd(): boolean {
    return this.pos >= this.source.length;
  }

  private peek(offset = 0): string {
    return this.source[this.pos + offset] ?? "";
  }

  private advance(): void {
    if (this.source[this.pos] === "\n") {
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
