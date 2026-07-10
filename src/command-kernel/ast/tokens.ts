export enum TokenType {
  WORD,
  ASSIGN, // réservé : forme préfixée "X=1 commande" (non émis par le lexer actuel)
  PIPE,
  AND,
  OR,
  SEMI, // | && || ;
  REDIR_OUT,
  REDIR_APPEND,
  REDIR_IN, // > >> <
  IF,
  THEN,
  ELSE,
  FI,
  FOR,
  IN,
  WHILE,
  DO,
  DONE,
  LPAREN,
  RPAREN, // sous-shell
  NEWLINE,
  EOF,
}

export interface Token {
  readonly type: TokenType;
  readonly value: string;
  readonly line: number;
  readonly column: number;
}

export const KEYWORDS: ReadonlyMap<string, TokenType> = new Map([
  ["if", TokenType.IF],
  ["then", TokenType.THEN],
  ["else", TokenType.ELSE],
  ["fi", TokenType.FI],
  ["for", TokenType.FOR],
  ["in", TokenType.IN],
  ["while", TokenType.WHILE],
  ["do", TokenType.DO],
  ["done", TokenType.DONE],
]);

/** Jetons qui terminent un bloc de type "sequence" (utilisés par le parser). */
export const BLOCK_TERMINATORS: ReadonlySet<TokenType> = new Set([
  TokenType.THEN,
  TokenType.ELSE,
  TokenType.FI,
  TokenType.DO,
  TokenType.DONE,
  TokenType.RPAREN,
  TokenType.EOF,
]);
