import { UsageError } from "../errors";
import { BLOCK_TERMINATORS, Token, TokenType } from "./tokens";
import {
  AssignmentNode,
  ForNode,
  IfNode,
  PipelineNode,
  RedirectionNode,
  ScriptNode,
  SimpleCommandNode,
  SubshellNode,
  WhileNode,
  Word,
} from "./nodes";

const ASSIGNMENT_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

/**
 * Construit l'AST à partir des tokens (descente récursive).
 *
 * Grammaire (précédence croissante) :
 *   sequence  := logical ( (';'|NEWLINE)+ logical )*
 *   logical   := pipeline ( ('&&'|'||') pipeline )*
 *   pipeline  := command ( '|' command )*
 *   command   := assignation | if | for | while | subshell | simple
 */
export class Parser {
  private tokens: Token[] = [];
  private pos = 0;

  parse(tokens: readonly Token[]): ScriptNode {
    this.tokens = [...tokens];
    this.pos = 0;
    this.skipSeparators();
    const node = this.parseSequence();
    this.skipSeparators();
    this.expect(TokenType.EOF, "fin d'entrée attendue");
    return node;
  }

  // ---- sequence ----

  private parseSequence(): ScriptNode {
    const statements: ScriptNode[] = [this.parseLogical()];

    while (this.isSeparator(this.peek().type)) {
      this.skipSeparators();
      if (this.isBlockTerminator(this.peek().type)) break;
      statements.push(this.parseLogical());
    }

    return statements.length === 1
      ? statements[0]
      : { kind: "sequence", statements };
  }

  // ---- logical (&& / ||) ----

  private parseLogical(): ScriptNode {
    let left = this.parsePipeline();
    while (this.peek().type === TokenType.AND || this.peek().type === TokenType.OR) {
      const op = this.advance().type === TokenType.AND ? "and" : "or";
      this.skipNewlinesOnly();
      const right = this.parsePipeline();
      left = { kind: op, left, right };
    }
    return left;
  }

  // ---- pipeline (|) ----

  private parsePipeline(): ScriptNode {
    const first = this.parseCommand();
    if (first.kind !== "command" || this.peek().type !== TokenType.PIPE) {
      return first;
    }

    const stages: SimpleCommandNode[] = [first];
    while (this.peek().type === TokenType.PIPE) {
      this.advance();
      this.skipNewlinesOnly();
      const next = this.parseCommand();
      if (next.kind !== "command") {
        throw new UsageError("le pipeline ne supporte que des commandes simples");
      }
      stages.push(next);
    }
    const pipeline: PipelineNode = { kind: "pipeline", stages };
    return pipeline;
  }

  // ---- command (dispatch) ----

  private parseCommand(): ScriptNode {
    const tok = this.peek();
    switch (tok.type) {
      case TokenType.IF:
        return this.parseIf();
      case TokenType.FOR:
        return this.parseFor();
      case TokenType.WHILE:
        return this.parseWhile();
      case TokenType.LPAREN:
        return this.parseSubshell();
      case TokenType.WORD:
        return this.parseSimpleOrAssignment();
      default:
        throw new UsageError(
          `erreur de syntaxe près de "${tok.value}" (ligne ${tok.line}, colonne ${tok.column})`,
        );
    }
  }

  private parseIf(): IfNode {
    this.expect(TokenType.IF, "'if' attendu");
    this.skipSeparators();
    const condition = this.parseSequence();
    this.skipSeparators();
    this.expect(TokenType.THEN, "'then' attendu après la condition du 'if'");
    this.skipSeparators();
    const thenBranch = this.parseSequence();
    this.skipSeparators();

    let elseBranch: ScriptNode | undefined;
    if (this.peek().type === TokenType.ELSE) {
      this.advance();
      this.skipSeparators();
      elseBranch = this.parseSequence();
      this.skipSeparators();
    }

    this.expect(TokenType.FI, "'fi' attendu pour clore le 'if'");
    return { kind: "if", condition, thenBranch, elseBranch };
  }

  private parseFor(): ForNode {
    this.expect(TokenType.FOR, "'for' attendu");
    const nameTok = this.expect(TokenType.WORD, "nom de variable attendu après 'for'");
    this.expect(TokenType.IN, "'in' attendu après le nom de variable du 'for'");

    const items: string[] = [];
    while (this.peek().type === TokenType.WORD) {
      items.push(this.advance().value);
    }

    this.skipSeparators();
    this.expect(TokenType.DO, "'do' attendu dans la boucle 'for'");
    this.skipSeparators();
    const body = this.parseSequence();
    this.skipSeparators();
    this.expect(TokenType.DONE, "'done' attendu pour clore le 'for'");

    return { kind: "for", variable: nameTok.value, items, body };
  }

  private parseWhile(): WhileNode {
    this.expect(TokenType.WHILE, "'while' attendu");
    this.skipSeparators();
    const condition = this.parseSequence();
    this.skipSeparators();
    this.expect(TokenType.DO, "'do' attendu dans la boucle 'while'");
    this.skipSeparators();
    const body = this.parseSequence();
    this.skipSeparators();
    this.expect(TokenType.DONE, "'done' attendu pour clore le 'while'");

    return { kind: "while", condition, body };
  }

  private parseSubshell(): SubshellNode {
    this.expect(TokenType.LPAREN, "'(' attendu");
    this.skipSeparators();
    const body = this.parseSequence();
    this.skipSeparators();
    this.expect(TokenType.RPAREN, "')' attendu pour clore le sous-shell");
    return { kind: "subshell", body };
  }

  private parseSimpleOrAssignment(): AssignmentNode | SimpleCommandNode {
    const tok = this.expect(TokenType.WORD, "mot attendu");
    const match = ASSIGNMENT_PATTERN.exec(tok.value);
    const nextType = this.peek().type;
    const isStandaloneStatement =
      this.isSeparator(nextType) || this.isBlockTerminator(nextType);

    if (match && isStandaloneStatement) {
      return { kind: "assign", name: match[1], value: match[2] };
    }

    const argv: Word[] = [];
    const redirections: RedirectionNode[] = [];
    const name = tok.value;

    while (!this.isCommandBoundary(this.peek().type)) {
      const current = this.peek();
      if (
        current.type === TokenType.REDIR_OUT ||
        current.type === TokenType.REDIR_APPEND ||
        current.type === TokenType.REDIR_IN
      ) {
        this.advance();
        const target = this.expect(TokenType.WORD, "cible de redirection attendue");
        redirections.push({
          kind: "redirect",
          mode:
            current.type === TokenType.REDIR_OUT
              ? "out"
              : current.type === TokenType.REDIR_APPEND
                ? "append"
                : "in",
          target: target.value,
        });
        continue;
      }
      if (current.type === TokenType.WORD) {
        const word = this.advance();
        argv.push({ text: word.value, noExpand: word.noExpand ?? false });
        continue;
      }
      throw new UsageError(
        `erreur de syntaxe près de "${current.value}" (ligne ${current.line}, colonne ${current.column})`,
      );
    }

    return { kind: "command", name, argv, redirections };
  }

  // ---- helpers ----

  private isSeparator(type: TokenType): boolean {
    return type === TokenType.SEMI || type === TokenType.NEWLINE;
  }

  private isBlockTerminator(type: TokenType): boolean {
    return BLOCK_TERMINATORS.has(type);
  }

  /** Frontière d'une commande simple : tout ce qui n'est ni un mot ni une redirection. */
  private isCommandBoundary(type: TokenType): boolean {
    return (
      type === TokenType.PIPE ||
      type === TokenType.AND ||
      type === TokenType.OR ||
      this.isSeparator(type) ||
      this.isBlockTerminator(type)
    );
  }

  private skipSeparators(): void {
    while (this.isSeparator(this.peek().type)) this.advance();
  }

  private skipNewlinesOnly(): void {
    while (this.peek().type === TokenType.NEWLINE) this.advance();
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private advance(): Token {
    const tok = this.peek();
    if (tok.type !== TokenType.EOF) this.pos++;
    return tok;
  }

  private expect(type: TokenType, message: string): Token {
    const tok = this.peek();
    if (tok.type !== type) {
      throw new UsageError(
        `${message} (trouvé "${tok.value || "<fin>"}" ligne ${tok.line}, colonne ${tok.column})`,
      );
    }
    return this.advance();
  }
}
