/**
 * Shell Package
 *
 * Provides proper shell parsing and execution:
 * - Lexer: Tokenizes shell input
 * - Parser: Builds AST from tokens
 * - Executor: Executes commands from AST
 *
 * This replaces the naive string-based parsing that couldn't handle
 * complex scenarios like: echo "text" >> file.txt | python file.txt
 */

export * from './lexer';
export * from './parser';
export * from './executor';
