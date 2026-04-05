/**
 * BashLexer — Unit Tests
 *
 * TDD tests covering the tokenizer for the bash interpreter.
 * Organized by token category: words, strings, variables, operators,
 * redirections, substitutions, assignments, edge cases.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BashLexer } from '@/bash/lexer/BashLexer';
import { TokenType } from '@/bash/lexer/Token';
import { LexerError } from '@/bash/lexer/LexerError';

let lexer: BashLexer;

beforeEach(() => {
  lexer = new BashLexer();
});

/** Helper: tokenize and return types (excluding EOF). */
function types(input: string): TokenType[] {
  return lexer.tokenize(input).filter(t => t.type !== TokenType.EOF).map(t => t.type);
}

/** Helper: tokenize and return values (excluding EOF). */
function values(input: string): string[] {
  return lexer.tokenize(input).filter(t => t.type !== TokenType.EOF).map(t => t.value);
}

// ═══════════════════════════════════════════════════════════════════
// Group 1: Basic Words
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Basic Words', () => {
  it('should tokenize a single word', () => {
    expect(types('echo')).toEqual([TokenType.WORD]);
    expect(values('echo')).toEqual(['echo']);
  });

  it('should tokenize multiple words', () => {
    expect(types('echo hello world')).toEqual([
      TokenType.WORD, TokenType.WORD, TokenType.WORD,
    ]);
    expect(values('echo hello world')).toEqual(['echo', 'hello', 'world']);
  });

  it('should tokenize words with special path characters', () => {
    expect(values('/usr/bin/ls')).toEqual(['/usr/bin/ls']);
    expect(values('file.txt')).toEqual(['file.txt']);
    expect(values('~/Documents')).toEqual(['~/Documents']);
  });

  it('should tokenize words with dashes and dots', () => {
    expect(values('ls -la --color=auto')).toEqual(['ls', '-la', '--color=auto']);
  });

  it('should handle escaped characters in words', () => {
    const toks = lexer.tokenize('hello\\ world');
    const words = toks.filter(t => t.type !== TokenType.EOF);
    expect(words[0].value).toBe('hello world');
  });

  it('should return EOF for empty input', () => {
    const toks = lexer.tokenize('');
    expect(toks.length).toBe(1);
    expect(toks[0].type).toBe(TokenType.EOF);
  });

  it('should skip spaces and tabs', () => {
    expect(values('  echo   hello  ')).toEqual(['echo', 'hello']);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 2: Strings
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: Strings', () => {
  it('should tokenize single-quoted strings', () => {
    const toks = lexer.tokenize("echo 'hello world'");
    expect(toks[1].type).toBe(TokenType.SINGLE_QUOTED);
    expect(toks[1].value).toBe('hello world');
  });

  it('should tokenize double-quoted strings', () => {
    const toks = lexer.tokenize('echo "hello world"');
    expect(toks[1].type).toBe(TokenType.DOUBLE_QUOTED);
    expect(toks[1].value).toBe('hello world');
  });

  it('should handle escapes in double-quoted strings', () => {
    const toks = lexer.tokenize('echo "hello \\"world\\""');
    expect(toks[1].type).toBe(TokenType.DOUBLE_QUOTED);
    expect(toks[1].value).toBe('hello \\"world\\"');
  });

  it('should handle empty single-quoted string', () => {
    const toks = lexer.tokenize("echo ''");
    expect(toks[1].type).toBe(TokenType.SINGLE_QUOTED);
    expect(toks[1].value).toBe('');
  });

  it('should handle empty double-quoted string', () => {
    const toks = lexer.tokenize('echo ""');
    expect(toks[1].type).toBe(TokenType.DOUBLE_QUOTED);
    expect(toks[1].value).toBe('');
  });

  it('should throw on unterminated single-quoted string', () => {
    expect(() => lexer.tokenize("echo 'hello")).toThrow(LexerError);
  });

  it('should throw on unterminated double-quoted string', () => {
    expect(() => lexer.tokenize('echo "hello')).toThrow(LexerError);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 3: Variable References
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: Variable References', () => {
  it('should tokenize simple variable $VAR', () => {
    const toks = lexer.tokenize('echo $HOME');
    expect(toks[1].type).toBe(TokenType.VAR_SIMPLE);
    expect(toks[1].value).toBe('HOME');
  });

  it('should tokenize braced variable ${VAR}', () => {
    const toks = lexer.tokenize('echo ${HOME}');
    expect(toks[1].type).toBe(TokenType.VAR_BRACED);
    expect(toks[1].value).toBe('HOME');
  });

  it('should tokenize braced variable with default ${VAR:-default}', () => {
    const toks = lexer.tokenize('echo ${NAME:-World}');
    expect(toks[1].type).toBe(TokenType.VAR_BRACED);
    expect(toks[1].value).toBe('NAME:-World');
  });

  it('should tokenize braced variable with length ${#VAR}', () => {
    const toks = lexer.tokenize('echo ${#array}');
    expect(toks[1].type).toBe(TokenType.VAR_BRACED);
    expect(toks[1].value).toBe('#array');
  });

  it('should tokenize special variables', () => {
    expect(lexer.tokenize('echo $?')[1].type).toBe(TokenType.VAR_SPECIAL);
    expect(lexer.tokenize('echo $?')[1].value).toBe('?');

    expect(lexer.tokenize('echo $$')[1].type).toBe(TokenType.VAR_SPECIAL);
    expect(lexer.tokenize('echo $$')[1].value).toBe('$');

    expect(lexer.tokenize('echo $#')[1].type).toBe(TokenType.VAR_SPECIAL);
    expect(lexer.tokenize('echo $#')[1].value).toBe('#');

    expect(lexer.tokenize('echo $@')[1].type).toBe(TokenType.VAR_SPECIAL);
    expect(lexer.tokenize('echo $@')[1].value).toBe('@');

    expect(lexer.tokenize('echo $0')[1].type).toBe(TokenType.VAR_SPECIAL);
    expect(lexer.tokenize('echo $0')[1].value).toBe('0');

    expect(lexer.tokenize('echo $1')[1].type).toBe(TokenType.VAR_SPECIAL);
    expect(lexer.tokenize('echo $1')[1].value).toBe('1');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 4: Operators
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: Operators', () => {
  it('should tokenize pipe |', () => {
    expect(types('ls | grep')).toContain(TokenType.PIPE);
  });

  it('should tokenize AND_IF &&', () => {
    expect(types('cmd1 && cmd2')).toContain(TokenType.AND_IF);
  });

  it('should tokenize OR_IF ||', () => {
    expect(types('cmd1 || cmd2')).toContain(TokenType.OR_IF);
  });

  it('should tokenize semicolon ;', () => {
    expect(types('cmd1; cmd2')).toContain(TokenType.SEMI);
  });

  it('should tokenize double semicolon ;;', () => {
    expect(types('echo A;;')).toContain(TokenType.DSEMI);
  });

  it('should tokenize ampersand &', () => {
    expect(types('cmd &')).toContain(TokenType.AMP);
  });

  it('should tokenize newline', () => {
    expect(types('cmd1\ncmd2')).toContain(TokenType.NEWLINE);
  });

  it('should tokenize parentheses', () => {
    const t = types('(echo hello)');
    expect(t).toContain(TokenType.LPAREN);
    expect(t).toContain(TokenType.RPAREN);
  });

  it('should tokenize braces', () => {
    const t = types('{ echo hello; }');
    expect(t).toContain(TokenType.LBRACE);
    expect(t).toContain(TokenType.RBRACE);
  });

  it('should tokenize brackets', () => {
    const t = types('[ -f file ]');
    expect(t).toContain(TokenType.LBRACKET);
    expect(t).toContain(TokenType.RBRACKET);
  });

  it('should tokenize double brackets', () => {
    const t = types('[[ -f file ]]');
    expect(t).toContain(TokenType.DLBRACKET);
    expect(t).toContain(TokenType.DRBRACKET);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 5: Redirections
// ═══════════════════════════════════════════════════════════════════

describe('Group 5: Redirections', () => {
  it('should tokenize > (stdout redirect)', () => {
    expect(types('echo hi > file')).toContain(TokenType.GREAT);
  });

  it('should tokenize >> (append)', () => {
    expect(types('echo hi >> file')).toContain(TokenType.DGREAT);
  });

  it('should tokenize < (stdin)', () => {
    expect(types('cat < file')).toContain(TokenType.LESS);
  });

  it('should tokenize 2> (stderr redirect)', () => {
    const toks = lexer.tokenize('cmd 2> /dev/null');
    const fdTok = toks.find(t => t.type === TokenType.FD_GREAT);
    expect(fdTok).toBeDefined();
    expect(fdTok!.value).toBe('2>');
  });

  it('should tokenize 2>> (stderr append)', () => {
    const toks = lexer.tokenize('cmd 2>> log.txt');
    const fdTok = toks.find(t => t.type === TokenType.FD_DGREAT);
    expect(fdTok).toBeDefined();
    expect(fdTok!.value).toBe('2>>');
  });

  it('should tokenize >& (stdout+stderr)', () => {
    expect(types('cmd >& file')).toContain(TokenType.GREATAND);
  });

  it('should tokenize <<< (here-string)', () => {
    expect(types('cat <<< "hello"')).toContain(TokenType.HERESTRING);
  });

  it('should tokenize << (heredoc)', () => {
    expect(types('cat << EOF')).toContain(TokenType.HEREDOC);
  });

  it('should tokenize 2>&1', () => {
    const toks = lexer.tokenize('cmd 2>&1');
    const fdTok = toks.find(t => t.type === TokenType.GREATAND);
    expect(fdTok).toBeDefined();
    expect(fdTok!.value).toBe('2>&1');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 6: Substitutions
// ═══════════════════════════════════════════════════════════════════

describe('Group 6: Substitutions', () => {
  it('should tokenize command substitution $(cmd)', () => {
    const toks = lexer.tokenize('echo $(whoami)');
    expect(toks[1].type).toBe(TokenType.CMD_SUB);
    expect(toks[1].value).toBe('whoami');
  });

  it('should tokenize backtick command substitution', () => {
    const toks = lexer.tokenize('echo `date`');
    expect(toks[1].type).toBe(TokenType.CMD_SUB_BACKTICK);
    expect(toks[1].value).toBe('date');
  });

  it('should tokenize arithmetic substitution $((expr))', () => {
    const toks = lexer.tokenize('echo $((1 + 2))');
    expect(toks[1].type).toBe(TokenType.ARITH_SUB);
    expect(toks[1].value).toBe('1 + 2');
  });

  it('should tokenize nested command substitution', () => {
    const toks = lexer.tokenize('echo $(echo $(date))');
    expect(toks[1].type).toBe(TokenType.CMD_SUB);
    expect(toks[1].value).toBe('echo $(date)');
  });

  it('should throw on unterminated command substitution', () => {
    expect(() => lexer.tokenize('echo $(whoami')).toThrow(LexerError);
  });

  it('should throw on unterminated backtick substitution', () => {
    expect(() => lexer.tokenize('echo `date')).toThrow(LexerError);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 7: Assignments
// ═══════════════════════════════════════════════════════════════════

describe('Group 7: Assignments', () => {
  it('should tokenize simple assignment', () => {
    const toks = lexer.tokenize('NAME=World');
    expect(toks[0].type).toBe(TokenType.ASSIGNMENT_WORD);
    expect(toks[0].value).toBe('NAME=World');
  });

  it('should tokenize assignment with empty value', () => {
    const toks = lexer.tokenize('VAR=');
    expect(toks[0].type).toBe(TokenType.ASSIGNMENT_WORD);
    expect(toks[0].value).toBe('VAR=');
  });

  it('should tokenize assignment before command', () => {
    const toks = lexer.tokenize('PATH=/usr/bin ls');
    expect(toks[0].type).toBe(TokenType.ASSIGNMENT_WORD);
    expect(toks[1].type).toBe(TokenType.WORD);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 8: Comments
// ═══════════════════════════════════════════════════════════════════

describe('Group 8: Comments', () => {
  it('should strip comments by default', () => {
    const toks = lexer.tokenize('echo hello # this is a comment');
    const nonEof = toks.filter(t => t.type !== TokenType.EOF);
    expect(nonEof.length).toBe(2);
    expect(values('echo hello # comment')).toEqual(['echo', 'hello']);
  });

  it('should strip full-line comments', () => {
    expect(values('# full line comment')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 9: Position Tracking
// ═══════════════════════════════════════════════════════════════════

describe('Group 9: Position Tracking', () => {
  it('should track line and column positions', () => {
    const toks = lexer.tokenize('echo\nhello');
    expect(toks[0].position).toEqual({ offset: 0, line: 1, column: 1 });
    // newline token
    expect(toks[1].position).toEqual({ offset: 4, line: 1, column: 5 });
    // 'hello' starts at line 2
    expect(toks[2].position).toEqual({ offset: 5, line: 2, column: 1 });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 10: Complex Scripts
// ═══════════════════════════════════════════════════════════════════

describe('Group 10: Complex Scripts', () => {
  it('should tokenize if-then-fi', () => {
    const input = 'if [ -f file ]; then echo found; fi';
    const t = types(input);
    expect(t).toContain(TokenType.LBRACKET);
    expect(t).toContain(TokenType.RBRACKET);
    expect(t).toContain(TokenType.SEMI);
  });

  it('should tokenize for loop', () => {
    const input = 'for i in 1 2 3; do echo $i; done';
    const v = values(input);
    expect(v).toContain('for');
    expect(v).toContain('in');
    expect(v).toContain('do');
    expect(v).toContain('done');
  });

  it('should tokenize pipeline with redirections', () => {
    const input = 'cat file.txt | grep error | wc -l > /tmp/count 2>&1';
    const t = types(input);
    expect(t.filter(x => x === TokenType.PIPE).length).toBe(2);
    expect(t).toContain(TokenType.GREAT);
    expect(t).toContain(TokenType.GREATAND);
  });

  it('should tokenize while loop', () => {
    const input = 'while [ $x -lt 10 ]; do x=$((x+1)); done';
    const v = values(input);
    expect(v).toContain('while');
    expect(v).toContain('done');
  });

  it('should tokenize case statement', () => {
    const input = 'case $opt in\na) echo A;;\nb) echo B;;\nesac';
    const v = values(input);
    expect(v).toContain('case');
    expect(v).toContain('esac');
    const t = types(input);
    expect(t.filter(x => x === TokenType.DSEMI).length).toBe(2);
  });

  it('should tokenize function definition', () => {
    const input = 'greet() { echo "Hello $1"; }';
    const t = types(input);
    expect(t).toContain(TokenType.LPAREN);
    expect(t).toContain(TokenType.RPAREN);
    expect(t).toContain(TokenType.LBRACE);
    expect(t).toContain(TokenType.RBRACE);
  });

  it('should tokenize multiline script', () => {
    const input = `#!/bin/bash
NAME="World"
echo "Hello $NAME"
if [ -d /tmp ]; then
  echo "tmp exists"
fi`;
    const toks = lexer.tokenize(input);
    const nonEof = toks.filter(t => t.type !== TokenType.EOF);
    expect(nonEof.length).toBeGreaterThan(10);
  });
});
