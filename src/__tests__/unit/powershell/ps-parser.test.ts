/**
 * PSParser — Unit Tests (TDD)
 *
 * Groups:
 *   1. Literals (string, number, bool, null)
 *   2. Variable expressions
 *   3. Pipeline statements (single and multi-stage)
 *   4. Assignment statements
 *   5. if / elseif / else
 *   6. Loops (while, do/while, do/until, for, foreach)
 *   7. Switch statement
 *   8. try / catch / finally
 *   9. Function definitions & script blocks
 *  10. Expressions (binary, unary, member access, index, cast, range, format)
 *  11. Hashtable & Array expressions
 *  12. return / break / continue / throw
 *  13. Complex real-world sequences
 */

import { describe, it, expect } from 'vitest';
import { PSLexer } from '@/powershell/lexer/PSLexer';
import { PSParser } from '@/powershell/parser/PSParser';
import type {
  PSProgram, PSStatementList, PSPipelineStatement, PSAssignmentStatement,
  PSIfStatement, PSWhileStatement, PSDoWhileStatement, PSDoUntilStatement,
  PSForStatement, PSForeachStatement, PSSwitchStatement, PSTryStatement,
  PSFunctionDefinition, PSReturnStatement, PSBreakStatement, PSContinueStatement,
  PSThrowStatement, PSCommand, PSPipeline,
  PSLiteralExpression, PSVariableExpression, PSBinaryExpression, PSUnaryExpression,
  PSMemberExpression, PSIndexExpression, PSCastExpression, PSRangeExpression,
  PSHashtableExpression, PSArrayExpression, PSScriptBlock,
} from '@/powershell/parser/PSASTNode';

const lexer = new PSLexer();
const parser = new PSParser();

function parse(input: string): PSProgram {
  return parser.parse(lexer.tokenize(input));
}

/** Unwrap: Program → StatementList → first statement */
function firstStmt(input: string) {
  return parse(input).body.statements[0];
}

/** Unwrap: first pipeline statement → pipeline */
function firstPipeline(input: string): PSPipeline {
  return (firstStmt(input) as PSPipelineStatement).pipeline;
}

/** Unwrap: first command in first pipeline */
function firstCmd(input: string): PSCommand {
  return firstPipeline(input).commands[0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Group 1 — Literals
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 1: Literals', () => {
  it('parses integer literal 42', () => {
    const expr = firstCmd('42').name as PSLiteralExpression;
    expect(expr.type).toBe('LiteralExpression');
    expect(expr.value).toBe(42);
    expect(expr.kind).toBe('number');
  });

  it('parses float literal 3.14', () => {
    const expr = firstCmd('3.14').name as PSLiteralExpression;
    expect(expr.value).toBe(3.14);
  });

  it('parses hex literal 0xFF → 255', () => {
    const expr = firstCmd('0xFF').name as PSLiteralExpression;
    expect(expr.value).toBe(255);
  });

  it('parses single-quoted string', () => {
    const expr = firstCmd("'hello world'").name as PSLiteralExpression;
    expect(expr.type).toBe('LiteralExpression');
    expect(expr.kind).toBe('string');
    expect(expr.value).toBe('hello world');
  });

  it('parses double-quoted string', () => {
    const expr = firstCmd('"hello"').name as PSLiteralExpression;
    expect(expr.kind).toBe('expandable');
    expect(expr.value).toBe('hello');
  });

  it('$true → literal true', () => {
    const expr = firstCmd('$true').name as PSLiteralExpression;
    expect(expr.type).toBe('LiteralExpression');
    expect(expr.value).toBe(true);
    expect(expr.kind).toBe('boolean');
  });

  it('$false → literal false', () => {
    const expr = firstCmd('$false').name as PSLiteralExpression;
    expect(expr.value).toBe(false);
  });

  it('$null → literal null', () => {
    const expr = firstCmd('$null').name as PSLiteralExpression;
    expect(expr.type).toBe('LiteralExpression');
    expect(expr.value).toBe(null);
    expect(expr.kind).toBe('null');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 2 — Variable Expressions
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 2: Variable Expressions', () => {
  it('parses $name as VariableExpression', () => {
    const expr = firstCmd('$name').name as PSVariableExpression;
    expect(expr.type).toBe('VariableExpression');
    expect(expr.name).toBe('name');
    expect(expr.scope).toBeNull();
    expect(expr.varName).toBe('name');
  });

  it('parses $env:PATH with scope qualifier', () => {
    const expr = firstCmd('$env:PATH').name as PSVariableExpression;
    expect(expr.type).toBe('VariableExpression');
    expect(expr.scope).toBe('env');
    expect(expr.varName).toBe('PATH');
    expect(expr.name).toBe('env:PATH');
  });

  it('parses $script:counter', () => {
    const v = firstCmd('$script:counter').name as PSVariableExpression;
    expect(v.scope).toBe('script');
    expect(v.varName).toBe('counter');
  });

  it('parses $_ (pipeline variable)', () => {
    const v = firstCmd('$_').name as PSVariableExpression;
    expect(v.varName).toBe('_');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 3 — Pipeline Statements
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 3: Pipeline Statements', () => {
  it('single command with no args', () => {
    const p = firstPipeline('Get-Process');
    expect(p.type).toBe('Pipeline');
    expect(p.commands).toHaveLength(1);
    const cmd = p.commands[0];
    expect((cmd.name as any).type).toBe('CommandExpression');
    expect((cmd.name as any).name).toBe('Get-Process');
  });

  it('command with positional argument', () => {
    const cmd = firstCmd('Write-Host "hello"');
    expect(cmd.arguments).toHaveLength(1);
    const arg = cmd.arguments[0] as PSLiteralExpression;
    expect(arg.value).toBe('hello');
  });

  it('command with named parameter and value: -Name "Dhcp"', () => {
    const cmd = firstCmd('Get-Service -Name "Dhcp"');
    expect(cmd.parameters).toHaveLength(1);
    expect(cmd.parameters[0].name).toBe('name');
    expect((cmd.parameters[0].value as PSLiteralExpression).value).toBe('Dhcp');
  });

  it('command with switch parameter (no value): -Force', () => {
    const cmd = firstCmd('Remove-Item -Force');
    const force = cmd.parameters.find(p => p.name === 'force');
    expect(force).toBeDefined();
    expect(force!.value).toBeNull();
  });

  it('pipeline with two stages: cmd1 | cmd2', () => {
    const p = firstPipeline('Get-Service | Where-Object { $_.Status -eq "Running" }');
    expect(p.commands).toHaveLength(2);
    expect((p.commands[0].name as any).name).toBe('Get-Service');
    expect((p.commands[1].name as any).name).toBe('Where-Object');
  });

  it('pipeline with three stages', () => {
    const p = firstPipeline('Get-Process | Sort-Object CPU -Descending | Select-Object -First 5');
    expect(p.commands).toHaveLength(3);
  });

  it('semicolon separates two statements', () => {
    const prog = parse('Get-Service; Get-Process');
    expect(prog.body.statements).toHaveLength(2);
  });

  it('newline separates two statements', () => {
    const prog = parse('Get-Service\nGet-Process');
    expect(prog.body.statements).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 4 — Assignment Statements
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 4: Assignment Statements', () => {
  it('$x = 42', () => {
    const stmt = firstStmt('$x = 42') as PSAssignmentStatement;
    expect(stmt.type).toBe('AssignmentStatement');
    expect(stmt.operator).toBe('=');
    const target = stmt.target as PSVariableExpression;
    expect(target.varName).toBe('x');
    const val = stmt.value as PSLiteralExpression;
    expect(val.value).toBe(42);
  });

  it('$name = "Alice"', () => {
    const stmt = firstStmt('$name = "Alice"') as PSAssignmentStatement;
    expect(stmt.operator).toBe('=');
    expect((stmt.value as PSLiteralExpression).value).toBe('Alice');
  });

  it('$count += 1', () => {
    const stmt = firstStmt('$count += 1') as PSAssignmentStatement;
    expect(stmt.operator).toBe('+=');
  });

  it('$x -= 5', () => {
    expect((firstStmt('$x -= 5') as PSAssignmentStatement).operator).toBe('-=');
  });

  it('$x *= 2', () => {
    expect((firstStmt('$x *= 2') as PSAssignmentStatement).operator).toBe('*=');
  });

  it('$x /= 3', () => {
    expect((firstStmt('$x /= 3') as PSAssignmentStatement).operator).toBe('/=');
  });

  it('$x %= 4', () => {
    expect((firstStmt('$x %= 4') as PSAssignmentStatement).operator).toBe('%=');
  });

  it('$arr = @(1, 2, 3)', () => {
    const stmt = firstStmt('$arr = @(1, 2, 3)') as PSAssignmentStatement;
    expect(stmt.value.type).toBe('ArrayExpression');
  });

  it('$h = @{a = 1}', () => {
    const stmt = firstStmt('$h = @{a = 1}') as PSAssignmentStatement;
    expect(stmt.value.type).toBe('HashtableExpression');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 5 — if / elseif / else
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 5: if / elseif / else', () => {
  it('simple if', () => {
    const stmt = firstStmt('if ($x -eq 1) { Write-Host "one" }') as PSIfStatement;
    expect(stmt.type).toBe('IfStatement');
    expect(stmt.condition.type).toBe('BinaryExpression');
    expect(stmt.thenBody.type).toBe('ScriptBlock');
    expect(stmt.elseifClauses).toHaveLength(0);
    expect(stmt.elseBody).toBeNull();
  });

  it('if with else', () => {
    const stmt = firstStmt('if ($x) { 1 } else { 2 }') as PSIfStatement;
    expect(stmt.elseBody).not.toBeNull();
    expect(stmt.elseBody!.type).toBe('ScriptBlock');
  });

  it('if with elseif and else', () => {
    const src = 'if ($x -eq 1) { "one" } elseif ($x -eq 2) { "two" } else { "other" }';
    const stmt = firstStmt(src) as PSIfStatement;
    expect(stmt.elseifClauses).toHaveLength(1);
    expect(stmt.elseBody).not.toBeNull();
  });

  it('nested if', () => {
    const src = 'if ($a) { if ($b) { "both" } }';
    const outer = firstStmt(src) as PSIfStatement;
    expect(outer.type).toBe('IfStatement');
    const inner = outer.thenBody.body!.statements[0] as PSIfStatement;
    expect(inner.type).toBe('IfStatement');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 6 — Loops
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 6: Loops', () => {
  it('while loop', () => {
    const stmt = firstStmt('while ($x -lt 10) { $x++ }') as PSWhileStatement;
    expect(stmt.type).toBe('WhileStatement');
    expect(stmt.condition.type).toBe('BinaryExpression');
    expect(stmt.body.type).toBe('ScriptBlock');
  });

  it('do/while loop', () => {
    const stmt = firstStmt('do { $x++ } while ($x -lt 10)') as PSDoWhileStatement;
    expect(stmt.type).toBe('DoWhileStatement');
    expect(stmt.condition.type).toBe('BinaryExpression');
  });

  it('do/until loop', () => {
    const stmt = firstStmt('do { $x++ } until ($x -ge 10)') as PSDoUntilStatement;
    expect(stmt.type).toBe('DoUntilStatement');
  });

  it('for loop', () => {
    const stmt = firstStmt('for ($i = 0; $i -lt 10; $i++) { Write-Host $i }') as PSForStatement;
    expect(stmt.type).toBe('ForStatement');
    expect(stmt.init).not.toBeNull();
    expect(stmt.condition).not.toBeNull();
    expect(stmt.iterator).not.toBeNull();
  });

  it('foreach loop', () => {
    const stmt = firstStmt('foreach ($item in $collection) { Write-Host $item }') as PSForeachStatement;
    expect(stmt.type).toBe('ForeachStatement');
    expect(stmt.variable.varName).toBe('item');
    expect(stmt.collection.type).toBe('VariableExpression');
  });

  it('foreach with range', () => {
    const stmt = firstStmt('foreach ($i in 1..10) { $i }') as PSForeachStatement;
    expect(stmt.collection.type).toBe('RangeExpression');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 7 — Switch
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 7: Switch', () => {
  it('basic switch', () => {
    const src = 'switch ($x) { 1 { "one" } 2 { "two" } }';
    const stmt = firstStmt(src) as PSSwitchStatement;
    expect(stmt.type).toBe('SwitchStatement');
    expect(stmt.clauses).toHaveLength(2);
    expect(stmt.defaultBody).toBeNull();
  });

  it('switch with default', () => {
    const src = 'switch ($x) { 1 { "one" } default { "other" } }';
    const stmt = firstStmt(src) as PSSwitchStatement;
    expect(stmt.defaultBody).not.toBeNull();
  });

  it('switch -regex flag', () => {
    const src = 'switch -regex ($s) { "^a" { "starts a" } }';
    const stmt = firstStmt(src) as PSSwitchStatement;
    expect(stmt.flags).toContain('regex');
  });

  it('switch -wildcard flag', () => {
    const src = 'switch -wildcard ($s) { "a*" { "a-prefix" } }';
    const stmt = firstStmt(src) as PSSwitchStatement;
    expect(stmt.flags).toContain('wildcard');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 8 — try / catch / finally
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 8: try / catch / finally', () => {
  it('simple try/catch', () => {
    const src = 'try { Get-Item -Path "x" } catch { "error" }';
    const stmt = firstStmt(src) as PSTryStatement;
    expect(stmt.type).toBe('TryStatement');
    expect(stmt.catchClauses).toHaveLength(1);
    expect(stmt.catchClauses[0].types).toHaveLength(0); // catch-all
    expect(stmt.finallyBody).toBeNull();
  });

  it('try/catch/finally', () => {
    const src = 'try { 1 } catch { 2 } finally { 3 }';
    const stmt = firstStmt(src) as PSTryStatement;
    expect(stmt.finallyBody).not.toBeNull();
  });

  it('typed catch [System.IO.IOException]', () => {
    const src = 'try { 1 } catch [System.IO.IOException] { "io error" }';
    const stmt = firstStmt(src) as PSTryStatement;
    expect(stmt.catchClauses[0].types).toContain('System.IO.IOException');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 9 — Function Definitions & Script Blocks
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 9: Function Definitions & Script Blocks', () => {
  it('simple function definition', () => {
    const stmt = firstStmt('function Say-Hello { Write-Host "Hello" }') as PSFunctionDefinition;
    expect(stmt.type).toBe('FunctionDefinition');
    expect(stmt.kind).toBe('function');
    expect(stmt.name).toBe('Say-Hello');
    expect(stmt.body.type).toBe('ScriptBlock');
  });

  it('function with param block', () => {
    const src = 'function Greet { param($Name) Write-Host "Hello $Name" }';
    const stmt = firstStmt(src) as PSFunctionDefinition;
    expect(stmt.body.paramBlock).not.toBeNull();
    expect(stmt.body.paramBlock!.parameters).toHaveLength(1);
    expect(stmt.body.paramBlock!.parameters[0].name.varName).toBe('Name');
  });

  it('filter definition', () => {
    const stmt = firstStmt('filter Select-Even { if ($_ % 2 -eq 0) { $_ } }') as PSFunctionDefinition;
    expect(stmt.kind).toBe('filter');
    expect(stmt.name).toBe('Select-Even');
  });

  it('script block as value $sb = { "hello" }', () => {
    const stmt = firstStmt('$sb = { "hello" }') as PSAssignmentStatement;
    expect(stmt.value.type).toBe('ScriptBlock');
  });

  it('script block with begin/process/end', () => {
    const src = 'function Proc { begin { "start" } process { $_ } end { "done" } }';
    const fn = firstStmt(src) as PSFunctionDefinition;
    expect(fn.body.beginBlock).not.toBeNull();
    expect(fn.body.processBlock).not.toBeNull();
    expect(fn.body.endBlock).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 10 — Expressions
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 10: Expressions', () => {
  it('binary: $x -eq 1', () => {
    const stmt = firstStmt('$x = ($a -eq 1)') as PSAssignmentStatement;
    const bin = stmt.value as PSBinaryExpression;
    expect(bin.type).toBe('BinaryExpression');
    expect(bin.operator).toBe('-eq');
  });

  it('binary: $a + $b', () => {
    const stmt = firstStmt('$r = $a + $b') as PSAssignmentStatement;
    const bin = stmt.value as PSBinaryExpression;
    expect(bin.operator).toBe('+');
  });

  it('binary: $a -and $b', () => {
    const stmt = firstStmt('$r = ($a -and $b)') as PSAssignmentStatement;
    const bin = stmt.value as PSBinaryExpression;
    expect(bin.operator).toBe('-and');
  });

  it('unary: -not $x', () => {
    const stmt = firstStmt('$r = (-not $x)') as PSAssignmentStatement;
    const unary = stmt.value as PSUnaryExpression;
    expect(unary.type).toBe('UnaryExpression');
    expect(unary.operator).toBe('-not');
  });

  it('unary: !$x', () => {
    const stmt = firstStmt('$r = (!$x)') as PSAssignmentStatement;
    const unary = stmt.value as PSUnaryExpression;
    expect(unary.operator).toBe('!');
  });

  it('range: 1..10', () => {
    const stmt = firstStmt('$r = 1..10') as PSAssignmentStatement;
    const range = stmt.value as PSRangeExpression;
    expect(range.type).toBe('RangeExpression');
    expect((range.start as PSLiteralExpression).value).toBe(1);
    expect((range.end as PSLiteralExpression).value).toBe(10);
  });

  it('member access: $obj.Name', () => {
    const stmt = firstStmt('$r = $obj.Name') as PSAssignmentStatement;
    const mem = stmt.value as PSMemberExpression;
    expect(mem.type).toBe('MemberExpression');
    expect(mem.member).toBe('Name');
  });

  it('index: $arr[0]', () => {
    const stmt = firstStmt('$r = $arr[0]') as PSAssignmentStatement;
    const idx = stmt.value as PSIndexExpression;
    expect(idx.type).toBe('IndexExpression');
    expect((idx.index as PSLiteralExpression).value).toBe(0);
  });

  it('cast: [int]$x', () => {
    const stmt = firstStmt('$r = [int]$x') as PSAssignmentStatement;
    const cast = stmt.value as PSCastExpression;
    expect(cast.type).toBe('CastExpression');
    expect(cast.targetType).toBe('int');
  });

  it('parenthesized expression: ($x + 1)', () => {
    const stmt = firstStmt('$r = ($x + 1)') as PSAssignmentStatement;
    expect(stmt.value.type).toBe('BinaryExpression');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 11 — Hashtable & Array Expressions
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 11: Hashtable & Array', () => {
  it('@{} empty hashtable', () => {
    const stmt = firstStmt('$h = @{}') as PSAssignmentStatement;
    const ht = stmt.value as PSHashtableExpression;
    expect(ht.type).toBe('HashtableExpression');
    expect(ht.pairs).toHaveLength(0);
  });

  it('@{key = "val"} single pair', () => {
    const stmt = firstStmt('$h = @{Name = "Alice"}') as PSAssignmentStatement;
    const ht = stmt.value as PSHashtableExpression;
    expect(ht.pairs).toHaveLength(1);
    expect((ht.pairs[0].key as PSLiteralExpression).value).toBe('Name');
    expect((ht.pairs[0].value as PSLiteralExpression).value).toBe('Alice');
  });

  it('@{a=1; b=2} multiple pairs separated by semicolon', () => {
    const stmt = firstStmt('$h = @{a=1; b=2}') as PSAssignmentStatement;
    const ht = stmt.value as PSHashtableExpression;
    expect(ht.pairs).toHaveLength(2);
  });

  it('@{} pairs separated by newlines', () => {
    const stmt = firstStmt('@{\n  a = 1\n  b = 2\n}') as PSPipelineStatement;
    // when used standalone, it's a pipeline producing a hashtable
    expect(stmt.type).toBe('PipelineStatement');
  });

  it('@() empty array expression', () => {
    const stmt = firstStmt('$a = @()') as PSAssignmentStatement;
    const arr = stmt.value as PSArrayExpression;
    expect(arr.type).toBe('ArrayExpression');
    expect(arr.elements).toHaveLength(0);
  });

  it('@(1, 2, 3) array expression', () => {
    const stmt = firstStmt('$a = @(1, 2, 3)') as PSAssignmentStatement;
    const arr = stmt.value as PSArrayExpression;
    expect(arr.elements).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 12 — return / break / continue / throw
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 12: return / break / continue / throw', () => {
  it('return with value', () => {
    const stmt = firstStmt('return 42') as PSReturnStatement;
    expect(stmt.type).toBe('ReturnStatement');
    expect((stmt.value as PSLiteralExpression).value).toBe(42);
  });

  it('return without value', () => {
    const stmt = firstStmt('return') as PSReturnStatement;
    expect(stmt.type).toBe('ReturnStatement');
    expect(stmt.value).toBeNull();
  });

  it('break', () => {
    const stmt = firstStmt('break') as PSBreakStatement;
    expect(stmt.type).toBe('BreakStatement');
    expect(stmt.label).toBeNull();
  });

  it('continue', () => {
    const stmt = firstStmt('continue') as PSContinueStatement;
    expect(stmt.type).toBe('ContinueStatement');
  });

  it('throw with expression', () => {
    const stmt = firstStmt('throw "error message"') as PSThrowStatement;
    expect(stmt.type).toBe('ThrowStatement');
    expect((stmt.value as PSLiteralExpression).value).toBe('error message');
  });

  it('throw without expression (rethrow)', () => {
    const stmt = firstStmt('throw') as PSThrowStatement;
    expect(stmt.type).toBe('ThrowStatement');
    expect(stmt.value).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 13 — Real-world Sequences
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group 13: Real-world Sequences', () => {
  it('Get-Service pipeline with filter and sort', () => {
    const src = 'Get-Service | Where-Object { $_.Status -eq "Running" } | Sort-Object Name';
    const p = firstPipeline(src);
    expect(p.commands).toHaveLength(3);
  });

  it('function with multiple param types and default', () => {
    const src = `function Get-Greeting {
      param(
        [string]$Name = "World",
        [int]$Times = 1
      )
      for ($i = 0; $i -lt $Times; $i++) {
        Write-Host "Hello, $Name"
      }
    }`;
    const fn = firstStmt(src) as PSFunctionDefinition;
    expect(fn.type).toBe('FunctionDefinition');
    expect(fn.body.paramBlock!.parameters).toHaveLength(2);
  });

  it('try/catch with specific exception type', () => {
    const src = `try {
      Get-Item -Path "C:\\missing.txt" -ErrorAction Stop
    } catch [System.IO.FileNotFoundException] {
      Write-Host "File not found"
    } finally {
      Write-Host "Done"
    }`;
    const stmt = firstStmt(src) as PSTryStatement;
    expect(stmt.catchClauses[0].types).toContain('System.IO.FileNotFoundException');
    expect(stmt.finallyBody).not.toBeNull();
  });

  it('switch with multiple conditions', () => {
    const src = `switch ($day) {
      "Monday"  { Write-Host "Start of week" }
      "Friday"  { Write-Host "End of week" }
      default   { Write-Host "Midweek" }
    }`;
    const stmt = firstStmt(src) as PSSwitchStatement;
    expect(stmt.clauses).toHaveLength(2);
    expect(stmt.defaultBody).not.toBeNull();
  });

  it('multiline script parses all statements', () => {
    const src = `
      $name = "Alice"
      $age = 30
      if ($age -ge 18) {
        Write-Host "$name is an adult"
      }
    `;
    const prog = parse(src);
    expect(prog.body.statements).toHaveLength(3);
  });
});
