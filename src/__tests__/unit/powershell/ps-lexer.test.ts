/**
 * PSLexer — Unit Tests (TDD)
 *
 * Groups:
 *   1. Basic Words & Numbers
 *   2. String Literals (single, double, here-strings)
 *   3. Variable References ($var, $env:, $true, $false, $null)
 *   4. Subexpressions $(...) and @ expressions
 *   5. Parameters & Operators (-Name, -eq, -and, !)
 *   6. Arithmetic & Assignment Operators
 *   7. Member Access (., ::, ..)
 *   8. Grouping & Punctuation
 *   9. Redirections
 *  10. Comments (line & block) + Position Tracking
 *  11. Type Literals [type]
 *  12. Complex / Multi-token Sequences
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PSLexer } from '@/powershell/lexer/PSLexer';
import { PSTokenType } from '@/powershell/lexer/PSToken';
import { PSLexerError } from '@/powershell/lexer/PSLexerError';

let lexer: PSLexer;

beforeEach(() => {
  lexer = new PSLexer();
});

/** Helper: tokenize and return token types (excluding EOF). */
function types(input: string): PSTokenType[] {
  return lexer.tokenize(input)
    .filter(t => t.type !== PSTokenType.EOF)
    .map(t => t.type);
}

/** Helper: tokenize and return token values (excluding EOF). */
function values(input: string): string[] {
  return lexer.tokenize(input)
    .filter(t => t.type !== PSTokenType.EOF)
    .map(t => t.value);
}

/** Helper: first non-EOF token. */
function first(input: string) {
  return lexer.tokenize(input).find(t => t.type !== PSTokenType.EOF)!;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Group 1 — Basic Words & Numbers
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 1: Basic Words & Numbers', () => {
  it('empty input yields only EOF', () => {
    const toks = lexer.tokenize('');
    expect(toks).toHaveLength(1);
    expect(toks[0].type).toBe(PSTokenType.EOF);
  });

  it('single word', () => {
    expect(types('Get-Process')).toEqual([PSTokenType.WORD]);
    expect(values('Get-Process')).toEqual(['Get-Process']);
  });

  it('multiple words separated by spaces', () => {
    expect(values('Write-Host hello')).toEqual(['Write-Host', 'hello']);
    expect(types('Write-Host hello')).toEqual([PSTokenType.WORD, PSTokenType.WORD]);
  });

  it('word with dots (cmdlet-like and paths)', () => {
    expect(values('Test.ps1')).toEqual(['Test.ps1']);
    expect(values('C:\\Windows\\System32')).toEqual(['C:\\Windows\\System32']);
  });

  it('integer literals', () => {
    expect(first('42').type).toBe(PSTokenType.NUMBER);
    expect(first('42').value).toBe('42');
    expect(first('0').value).toBe('0');
  });

  it('hex integer literals 0x...', () => {
    expect(first('0xFF').type).toBe(PSTokenType.NUMBER);
    expect(first('0xFF').value).toBe('0xFF');
    expect(first('0x1A2B').value).toBe('0x1A2B');
  });

  it('decimal / floating-point literals', () => {
    expect(first('3.14').type).toBe(PSTokenType.NUMBER);
    expect(first('3.14').value).toBe('3.14');
    expect(first('1.5e3').value).toBe('1.5e3');
    expect(first('2.0E-4').value).toBe('2.0E-4');
  });

  it('size-suffix literals (1KB, 1MB, 1GB, 1TB, 1PB)', () => {
    for (const s of ['1KB', '2MB', '4GB', '8TB', '16PB']) {
      expect(first(s).type).toBe(PSTokenType.NUMBER);
      expect(first(s).value).toBe(s);
    }
  });

  it('long-suffix literal (1L)', () => {
    expect(first('100L').type).toBe(PSTokenType.NUMBER);
    expect(first('100L').value).toBe('100L');
  });

  it('tabs and spaces are skipped between tokens', () => {
    // -Name is a PARAMETER token (value lowercased), so 3 values total
    expect(values('  Get-Service\t-Name\t Dhcp  ')).toEqual(['Get-Service', 'name', 'Dhcp']);
    const allTypes = types('  Get-Service\t-Name\t Dhcp  ');
    expect(allTypes).toEqual([PSTokenType.WORD, PSTokenType.PARAMETER, PSTokenType.WORD]);
  });

  it('keywords are tokenized as WORD with their lowercase value', () => {
    expect(first('if').type).toBe(PSTokenType.WORD);
    expect(first('If').type).toBe(PSTokenType.WORD);
    expect(first('IF').type).toBe(PSTokenType.WORD);
    // Value is lowercased for keywords
    expect(first('IF').value).toBe('if');
    expect(first('ForEach').value).toBe('foreach');
  });

  it('non-keyword identifiers preserve their case', () => {
    expect(first('MyFunction').value).toBe('MyFunction');
    expect(first('Get-Process').value).toBe('Get-Process');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 2 — String Literals
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 2: String Literals', () => {
  it("single-quoted 'literal' — no expansion", () => {
    const t = first("'hello world'");
    expect(t.type).toBe(PSTokenType.STRING_SINGLE);
    expect(t.value).toBe('hello world');
  });

  it('single-quoted empty string', () => {
    expect(first("''").value).toBe('');
  });

  it("single-quoted string with escaped '' (doubled quote)", () => {
    // In PS single-quoted strings, '' is the escape for a literal '
    const t = first("'it''s'");
    expect(t.type).toBe(PSTokenType.STRING_SINGLE);
    expect(t.value).toBe("it''s");   // raw value preserved; evaluator resolves ''→'
  });

  it('double-quoted "expandable" string', () => {
    const t = first('"hello world"');
    expect(t.type).toBe(PSTokenType.STRING_DOUBLE);
    expect(t.value).toBe('hello world');
  });

  it('double-quoted empty string', () => {
    expect(first('""').value).toBe('');
  });

  it('double-quoted with backtick escape `"', () => {
    const t = first('"say `"hello`""');
    expect(t.type).toBe(PSTokenType.STRING_DOUBLE);
    expect(t.value).toBe('say `"hello`"');  // raw value; evaluator resolves `"→"
  });

  it('double-quoted with $var inside (raw value preserved)', () => {
    const t = first('"Hello $name"');
    expect(t.type).toBe(PSTokenType.STRING_DOUBLE);
    expect(t.value).toBe('Hello $name');
  });

  it('throws PSLexerError on unterminated single-quoted string', () => {
    expect(() => lexer.tokenize("'unterminated")).toThrow(PSLexerError);
  });

  it('throws PSLexerError on unterminated double-quoted string', () => {
    expect(() => lexer.tokenize('"unterminated')).toThrow(PSLexerError);
  });

  it("here-string single-quoted @'...\\n...'@", () => {
    const input = "@'\nhello\nworld\n'@";
    const t = first(input);
    expect(t.type).toBe(PSTokenType.HEREDOC_SINGLE);
    expect(t.value).toBe('hello\nworld');
  });

  it("here-string double-quoted @\"...\\n...\"@", () => {
    const input = '@"\nhello $name\nworld\n"@';
    const t = first(input);
    expect(t.type).toBe(PSTokenType.HEREDOC_DOUBLE);
    expect(t.value).toBe('hello $name\nworld');
  });

  it('throws on unterminated here-string', () => {
    expect(() => lexer.tokenize("@'\nhello\nworld")).toThrow(PSLexerError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 3 — Variable References
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 3: Variable References', () => {
  it('simple $var', () => {
    const t = first('$name');
    expect(t.type).toBe(PSTokenType.VARIABLE);
    expect(t.value).toBe('name');
  });

  it('$_ (pipeline variable)', () => {
    const t = first('$_');
    expect(t.type).toBe(PSTokenType.VARIABLE);
    expect(t.value).toBe('_');
  });

  it('$? (success status)', () => {
    const t = first('$?');
    expect(t.type).toBe(PSTokenType.VARIABLE);
    expect(t.value).toBe('?');
  });

  it('$$ (last token of previous command)', () => {
    const t = first('$$');
    expect(t.type).toBe(PSTokenType.VARIABLE);
    expect(t.value).toBe('$');
  });

  it('$^ (first token of previous command)', () => {
    const t = first('$^');
    expect(t.type).toBe(PSTokenType.VARIABLE);
    expect(t.value).toBe('^');
  });

  it('$env:PATH — scoped variable', () => {
    const t = first('$env:PATH');
    expect(t.type).toBe(PSTokenType.VARIABLE);
    expect(t.value).toBe('env:PATH');
  });

  it('$script:counter — script scope', () => {
    const t = first('$script:counter');
    expect(t.type).toBe(PSTokenType.VARIABLE);
    expect(t.value).toBe('script:counter');
  });

  it('$global:x — global scope', () => {
    const t = first('$global:x');
    expect(t.type).toBe(PSTokenType.VARIABLE);
    expect(t.value).toBe('global:x');
  });

  it('$local:x — local scope', () => {
    const t = first('$local:x');
    expect(t.type).toBe(PSTokenType.VARIABLE);
    expect(t.value).toBe('local:x');
  });

  it('${var with spaces} — braced variable', () => {
    const t = first('${my var}');
    expect(t.type).toBe(PSTokenType.VARIABLE);
    expect(t.value).toBe('my var');
  });

  it('$true, $false, $null — automatic variables', () => {
    expect(first('$true').type).toBe(PSTokenType.VARIABLE);
    expect(first('$true').value).toBe('true');
    expect(first('$false').value).toBe('false');
    expect(first('$null').value).toBe('null');
  });

  it('$PSVersionTable — PS automatic variable', () => {
    const t = first('$PSVersionTable');
    expect(t.type).toBe(PSTokenType.VARIABLE);
    expect(t.value).toBe('PSVersionTable');
  });

  it('bare $ with no name is emitted as WORD "$"', () => {
    // Edge case: trailing bare dollar
    const t = first('$');
    expect(t.value).toBe('$');
  });

  it('throws on unterminated braced variable ${...', () => {
    expect(() => lexer.tokenize('${unclosed')).toThrow(PSLexerError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 4 — Subexpressions & @ Expressions
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 4: Subexpressions & @ Expressions', () => {
  it('$(...) emits SUBEXPR with raw inner text', () => {
    const t = first('$(Get-Date)');
    expect(t.type).toBe(PSTokenType.SUBEXPR);
    expect(t.value).toBe('Get-Date');
  });

  it('$(...) with nested parens', () => {
    const t = first('$(Get-Process | Select-Object -First 5)');
    expect(t.type).toBe(PSTokenType.SUBEXPR);
    expect(t.value).toBe('Get-Process | Select-Object -First 5');
  });

  it('nested $(...) inside $(...)', () => {
    const t = first('$(echo $(Get-Date))');
    expect(t.type).toBe(PSTokenType.SUBEXPR);
    expect(t.value).toBe('echo $(Get-Date)');
  });

  it('throws on unterminated $(', () => {
    expect(() => lexer.tokenize('$(Get-Date')).toThrow(PSLexerError);
  });

  it('@(...)  emits AT + LPAREN (array expression opener)', () => {
    const toks = types('@(1, 2, 3)');
    expect(toks[0]).toBe(PSTokenType.AT);
    expect(toks[1]).toBe(PSTokenType.LPAREN);
  });

  it('@{...} emits AT + LBRACE (hashtable literal opener)', () => {
    const toks = types('@{key = "value"}');
    expect(toks[0]).toBe(PSTokenType.AT);
    expect(toks[1]).toBe(PSTokenType.LBRACE);
  });

  it('@varname emits SPLATTED with the var name', () => {
    const t = first('@params');
    expect(t.type).toBe(PSTokenType.SPLATTED);
    expect(t.value).toBe('params');
  });

  it('bare @ alone emits AT token', () => {
    const t = first('@');
    expect(t.type).toBe(PSTokenType.AT);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 5 — Parameters & -Word Operators
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 5: Parameters & -Word Operators', () => {
  it('-Name emits PARAMETER with lowercase value "name"', () => {
    const t = first('-Name');
    expect(t.type).toBe(PSTokenType.PARAMETER);
    expect(t.value).toBe('name');
  });

  it('-Force emits PARAMETER with lowercase value "force"', () => {
    expect(first('-Force').type).toBe(PSTokenType.PARAMETER);
    expect(first('-Force').value).toBe('force');
  });

  it('-eq emits PARAMETER with value "eq"', () => {
    const t = first('-eq');
    expect(t.type).toBe(PSTokenType.PARAMETER);
    expect(t.value).toBe('eq');
  });

  it('-ne, -gt, -ge, -lt, -le are all PARAMETER', () => {
    for (const op of ['ne', 'gt', 'ge', 'lt', 'le']) {
      expect(first(`-${op}`).type).toBe(PSTokenType.PARAMETER);
      expect(first(`-${op}`).value).toBe(op);
    }
  });

  it('-like, -notlike, -match, -notmatch are PARAMETER', () => {
    for (const op of ['like', 'notlike', 'match', 'notmatch']) {
      expect(first(`-${op}`).value).toBe(op);
    }
  });

  it('-and, -or, -xor, -not are PARAMETER', () => {
    for (const op of ['and', 'or', 'xor', 'not']) {
      const t = first(`-${op}`);
      expect(t.type).toBe(PSTokenType.PARAMETER);
      expect(t.value).toBe(op);
    }
  });

  it('-replace, -split, -join, -f are PARAMETER', () => {
    for (const op of ['replace', 'split', 'join', 'f']) {
      expect(first(`-${op}`).value).toBe(op);
    }
  });

  it('-band, -bor, -bxor, -bnot are PARAMETER', () => {
    for (const op of ['band', 'bor', 'bxor', 'bnot']) {
      expect(first(`-${op}`).value).toBe(op);
    }
  });

  it('! emits NOT token', () => {
    const t = first('!$cond');
    expect(t.type).toBe(PSTokenType.NOT);
    expect(t.value).toBe('!');
  });

  it('PARAMETER values are lowercased', () => {
    // -Name → PARAMETER "name" (all parameters lowercased for case-insensitive matching)
    expect(first('-EQ').value).toBe('eq');
    expect(first('-Force').value).toBe('force');
    expect(first('-ComputerName').value).toBe('computername');
  });

  it('-- (double dash) emits DECREMENT token', () => {
    // -- is the decrement operator in PowerShell ($x-- / --$x)
    const t = first('--');
    expect(t.type).toBe(PSTokenType.DECREMENT);
    expect(t.value).toBe('--');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 6 — Arithmetic & Assignment Operators
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 6: Arithmetic & Assignment Operators', () => {
  it('+ emits PLUS', () => {
    expect(first('+').type).toBe(PSTokenType.PLUS);
    expect(first('+').value).toBe('+');
  });

  it('* emits MULTIPLY', () => {
    expect(first('*').type).toBe(PSTokenType.MULTIPLY);
  });

  it('/ emits DIVIDE', () => {
    expect(first('/').type).toBe(PSTokenType.DIVIDE);
  });

  it('% emits MODULO', () => {
    expect(first('%').type).toBe(PSTokenType.MODULO);
  });

  it('= emits ASSIGN', () => {
    expect(first('=').type).toBe(PSTokenType.ASSIGN);
  });

  it('+= emits PLUS_ASSIGN', () => {
    expect(first('+=').type).toBe(PSTokenType.PLUS_ASSIGN);
  });

  it('-= emits MINUS_ASSIGN', () => {
    expect(first('-=').type).toBe(PSTokenType.MINUS_ASSIGN);
  });

  it('*= emits MULTIPLY_ASSIGN', () => {
    expect(first('*=').type).toBe(PSTokenType.MULTIPLY_ASSIGN);
  });

  it('/= emits DIVIDE_ASSIGN', () => {
    expect(first('/=').type).toBe(PSTokenType.DIVIDE_ASSIGN);
  });

  it('%= emits MODULO_ASSIGN', () => {
    expect(first('%=').type).toBe(PSTokenType.MODULO_ASSIGN);
  });

  it('- followed by a digit is MINUS + NUMBER (not a parameter)', () => {
    const toks = lexer.tokenize('- 5').filter(t => t.type !== PSTokenType.EOF);
    expect(toks[0].type).toBe(PSTokenType.MINUS);
    expect(toks[1].type).toBe(PSTokenType.NUMBER);
  });

  it('expression: $x + $y * 2', () => {
    const t = types('$x + $y * 2');
    expect(t).toEqual([
      PSTokenType.VARIABLE,
      PSTokenType.PLUS,
      PSTokenType.VARIABLE,
      PSTokenType.MULTIPLY,
      PSTokenType.NUMBER,
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 7 — Member Access, Range, Pipeline, Punctuation
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 7: Member Access, Range, Pipeline, Punctuation', () => {
  it('. (dot) emits DOT', () => {
    // $obj.Property → VARIABLE DOT WORD
    const t = types('$obj.Property');
    expect(t).toEqual([PSTokenType.VARIABLE, PSTokenType.DOT, PSTokenType.WORD]);
  });

  it(':: emits STATIC_MEMBER', () => {
    // [Math]::Round(3.14) → TYPE STATIC_MEMBER WORD ...
    const t = types('[Math]::Round');
    expect(t).toContain(PSTokenType.STATIC_MEMBER);
  });

  it('.. emits RANGE', () => {
    const t = types('1..10');
    expect(t).toEqual([PSTokenType.NUMBER, PSTokenType.RANGE, PSTokenType.NUMBER]);
  });

  it('| emits PIPE', () => {
    expect(first('|').type).toBe(PSTokenType.PIPE);
  });

  it('; emits SEMICOLON', () => {
    expect(first(';').type).toBe(PSTokenType.SEMICOLON);
  });

  it('newline emits NEWLINE', () => {
    const toks = types('a\nb');
    expect(toks).toContain(PSTokenType.NEWLINE);
  });

  it(', emits COMMA', () => {
    expect(first(',').type).toBe(PSTokenType.COMMA);
  });

  it('& emits AMPERSAND', () => {
    expect(first('&').type).toBe(PSTokenType.AMPERSAND);
  });

  it('pipeline sequence: cmd1 | cmd2', () => {
    const t = types('Get-Service | Where-Object { $_.Status -eq "Running" }');
    expect(t[0]).toBe(PSTokenType.WORD);
    expect(t[1]).toBe(PSTokenType.PIPE);
    expect(t[2]).toBe(PSTokenType.WORD);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 8 — Grouping & Redirections
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 8: Grouping & Redirections', () => {
  it('( ) emits LPAREN / RPAREN', () => {
    expect(first('(').type).toBe(PSTokenType.LPAREN);
    expect(first(')').type).toBe(PSTokenType.RPAREN);
  });

  it('{ } emits LBRACE / RBRACE', () => {
    expect(first('{').type).toBe(PSTokenType.LBRACE);
    expect(first('}').type).toBe(PSTokenType.RBRACE);
  });

  it('[ ] emits LBRACKET / RBRACKET (index context)', () => {
    // $arr[0] → VARIABLE LBRACKET NUMBER RBRACKET
    const t = types('$arr[0]');
    expect(t).toEqual([
      PSTokenType.VARIABLE,
      PSTokenType.LBRACKET,
      PSTokenType.NUMBER,
      PSTokenType.RBRACKET,
    ]);
  });

  it('> emits REDIRECT_OUT', () => {
    expect(first('>').type).toBe(PSTokenType.REDIRECT_OUT);
  });

  it('>> emits REDIRECT_APPEND', () => {
    expect(first('>>').type).toBe(PSTokenType.REDIRECT_APPEND);
  });

  it('2> emits REDIRECT_ERR_OUT', () => {
    expect(first('2>').type).toBe(PSTokenType.REDIRECT_ERR_OUT);
    expect(first('2>').value).toBe('2>');
  });

  it('2>> emits REDIRECT_ERR_APPEND', () => {
    expect(first('2>>').type).toBe(PSTokenType.REDIRECT_ERR_APPEND);
  });

  it('*> emits REDIRECT_ALL_OUT', () => {
    expect(first('*>').type).toBe(PSTokenType.REDIRECT_ALL_OUT);
  });

  it('*>> emits REDIRECT_ALL_APPEND', () => {
    expect(first('*>>').type).toBe(PSTokenType.REDIRECT_ALL_APPEND);
  });

  it('redirection in context: Get-Process > out.txt', () => {
    const t = types('Get-Process > out.txt');
    expect(t).toEqual([PSTokenType.WORD, PSTokenType.REDIRECT_OUT, PSTokenType.WORD]);
  });

  it('redirection: cmd 2>&1 (stderr to stdout)', () => {
    // PowerShell uses 2>&1 as well
    const t = types('cmd 2>&1');
    expect(t[1]).toBe(PSTokenType.REDIRECT_ERR_OUT);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 9 — Type Literals [TypeName]
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 9: Type Literals [TypeName]', () => {
  it('[string] emits TYPE with value "string"', () => {
    const t = first('[string]');
    expect(t.type).toBe(PSTokenType.TYPE);
    expect(t.value).toBe('string');
  });

  it('[int] emits TYPE', () => {
    expect(first('[int]').type).toBe(PSTokenType.TYPE);
    expect(first('[int]').value).toBe('int');
  });

  it('[bool], [double], [decimal] emit TYPE', () => {
    for (const s of ['bool', 'double', 'decimal', 'char', 'byte', 'long', 'float']) {
      expect(first(`[${s}]`).type).toBe(PSTokenType.TYPE);
      expect(first(`[${s}]`).value).toBe(s);
    }
  });

  it('[System.String] — dotted namespace type', () => {
    const t = first('[System.String]');
    expect(t.type).toBe(PSTokenType.TYPE);
    expect(t.value).toBe('System.String');
  });

  it('[System.Collections.Generic.List[int]] — generic type', () => {
    const t = first('[System.Collections.Generic.List[int]]');
    expect(t.type).toBe(PSTokenType.TYPE);
    expect(t.value).toBe('System.Collections.Generic.List[int]');
  });

  it('[string[]] — array type', () => {
    const t = first('[string[]]');
    expect(t.type).toBe(PSTokenType.TYPE);
    expect(t.value).toBe('string[]');
  });

  it('[int] cast before variable: [int]$x', () => {
    const t = types('[int]$x');
    expect(t[0]).toBe(PSTokenType.TYPE);
    expect(t[1]).toBe(PSTokenType.VARIABLE);
  });

  it('[Math]::Round uses TYPE + STATIC_MEMBER', () => {
    const t = types('[Math]::Round');
    expect(t[0]).toBe(PSTokenType.TYPE);
    expect(t[1]).toBe(PSTokenType.STATIC_MEMBER);
    expect(t[2]).toBe(PSTokenType.WORD);
  });

  it('index [0] after $arr is LBRACKET, not TYPE', () => {
    // After a variable, [ starts an index expression
    const t = types('$arr[0]');
    expect(t[1]).toBe(PSTokenType.LBRACKET);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 10 — Comments, Position Tracking, Complex Sequences
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 10: Comments, Positions & Complex Sequences', () => {
  it('# line comment is stripped', () => {
    expect(types('Get-Process # list all processes')).toEqual([PSTokenType.WORD]);
    expect(values('Get-Process # list all processes')).toEqual(['Get-Process']);
  });

  it('full-line # comment yields no tokens', () => {
    expect(types('# this is a comment')).toEqual([]);
  });

  it('<# block comment #> is stripped', () => {
    const t = types('Get-Process <# comment #> -Name svchost');
    expect(t).toEqual([PSTokenType.WORD, PSTokenType.PARAMETER, PSTokenType.WORD]);
  });

  it('<# multiline block comment #> is stripped', () => {
    const input = `Get-Process <#
      This is a
      multiline comment
    #> -Name svchost`;
    const t = types(input);
    expect(t).toEqual([PSTokenType.WORD, PSTokenType.PARAMETER, PSTokenType.WORD]);
  });

  it('position: line and column are tracked', () => {
    const toks = lexer.tokenize('Get-Process\n$name');
    const word = toks[0];
    expect(word.position.line).toBe(1);
    expect(word.position.column).toBe(1);
    expect(word.position.offset).toBe(0);
  });

  it('position: second line starts at column 1', () => {
    const toks = lexer.tokenize('cmd\n$var').filter(t => t.type !== PSTokenType.EOF && t.type !== PSTokenType.NEWLINE);
    const varTok = toks[1];
    expect(varTok.position.line).toBe(2);
    expect(varTok.position.column).toBe(1);
  });

  // Complex multi-token sequences
  it('if statement tokens', () => {
    const t = types('if ($x -eq 1) { Write-Host "yes" }');
    expect(t[0]).toBe(PSTokenType.WORD);   // if
    expect(t[1]).toBe(PSTokenType.LPAREN);
    expect(t[2]).toBe(PSTokenType.VARIABLE); // $x
    expect(t[3]).toBe(PSTokenType.PARAMETER); // -eq
    expect(t[4]).toBe(PSTokenType.NUMBER);   // 1
    expect(t[5]).toBe(PSTokenType.RPAREN);
    expect(t[6]).toBe(PSTokenType.LBRACE);
  });

  it('foreach loop tokens', () => {
    const t = types('foreach ($item in $collection) { $item }');
    expect(t[0]).toBe(PSTokenType.WORD);     // foreach
    expect(t[1]).toBe(PSTokenType.LPAREN);
    expect(t[2]).toBe(PSTokenType.VARIABLE); // $item
    expect(t[3]).toBe(PSTokenType.WORD);     // in
    expect(t[4]).toBe(PSTokenType.VARIABLE); // $collection
    expect(t[5]).toBe(PSTokenType.RPAREN);
  });

  it('function definition tokens', () => {
    const t = types('function Get-Greeting { param($Name) "Hello $Name" }');
    expect(t[0]).toBe(PSTokenType.WORD);   // function
    expect(t[1]).toBe(PSTokenType.WORD);   // Get-Greeting
    expect(t[2]).toBe(PSTokenType.LBRACE);
    expect(t[3]).toBe(PSTokenType.WORD);   // param
  });

  it('assignment: $x = 42', () => {
    const t = types('$x = 42');
    expect(t).toEqual([PSTokenType.VARIABLE, PSTokenType.ASSIGN, PSTokenType.NUMBER]);
  });

  it('range expression: 1..10', () => {
    const t = types('1..10');
    expect(t).toEqual([PSTokenType.NUMBER, PSTokenType.RANGE, PSTokenType.NUMBER]);
  });

  it('hashtable literal: @{a = 1; b = 2}', () => {
    const t = types('@{a = 1}');
    expect(t[0]).toBe(PSTokenType.AT);
    expect(t[1]).toBe(PSTokenType.LBRACE);
    expect(t[2]).toBe(PSTokenType.WORD);  // a
    expect(t[3]).toBe(PSTokenType.ASSIGN);
  });

  it('array expression: @(1, 2, 3)', () => {
    const t = types('@(1, 2, 3)');
    expect(t[0]).toBe(PSTokenType.AT);
    expect(t[1]).toBe(PSTokenType.LPAREN);
    expect(t[2]).toBe(PSTokenType.NUMBER);
    expect(t[3]).toBe(PSTokenType.COMMA);
  });

  it('static method call: [Environment]::Exit(0)', () => {
    const t = types('[Environment]::Exit(0)');
    expect(t[0]).toBe(PSTokenType.TYPE);
    expect(t[1]).toBe(PSTokenType.STATIC_MEMBER);
    expect(t[2]).toBe(PSTokenType.WORD);    // Exit
    expect(t[3]).toBe(PSTokenType.LPAREN);
    expect(t[4]).toBe(PSTokenType.NUMBER);  // 0
    expect(t[5]).toBe(PSTokenType.RPAREN);
  });
});
