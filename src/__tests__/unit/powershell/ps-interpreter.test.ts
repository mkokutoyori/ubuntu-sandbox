/**
 * ps-interpreter.test.ts — TDD tests for the PowerShell 5.1 interpreter.
 *
 * Tests cover: variable scope, arithmetic, string expansion, pipelines,
 * conditionals, loops, functions, error handling, and built-in cmdlets.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function run(code: string): PSInterpreter {
  const interp = new PSInterpreter();
  interp.execute(code);
  return interp;
}

function output(code: string): string {
  const interp = new PSInterpreter();
  return interp.execute(code);
}

function runAndGet(code: string, varName: string): unknown {
  const interp = new PSInterpreter();
  interp.execute(code);
  return interp.getVariable(varName);
}

// ─── 1. Variable Assignment & Retrieval ────────────────────────────────────

describe('1. Variable Assignment & Retrieval', () => {
  it('assigns an integer to a variable', () => {
    expect(runAndGet('$x = 42', 'x')).toBe(42);
  });

  it('assigns a string to a variable', () => {
    expect(runAndGet('$name = "Alice"', 'name')).toBe('Alice');
  });

  it('assigns a float to a variable', () => {
    expect(runAndGet('$pi = 3.14', 'pi')).toBe(3.14);
  });

  it('assigns boolean $true', () => {
    expect(runAndGet('$b = $true', 'b')).toBe(true);
  });

  it('assigns boolean $false', () => {
    expect(runAndGet('$b = $false', 'b')).toBe(false);
  });

  it('assigns $null', () => {
    expect(runAndGet('$n = $null', 'n')).toBeNull();
  });

  it('reassigns a variable', () => {
    expect(runAndGet('$x = 1; $x = 2', 'x')).toBe(2);
  });

  it('assigns the result of an expression', () => {
    expect(runAndGet('$x = 3 + 4', 'x')).toBe(7);
  });

  it('compound += assignment', () => {
    expect(runAndGet('$x = 5; $x += 3', 'x')).toBe(8);
  });

  it('compound -= assignment', () => {
    expect(runAndGet('$x = 10; $x -= 4', 'x')).toBe(6);
  });

  it('compound *= assignment', () => {
    expect(runAndGet('$x = 3; $x *= 4', 'x')).toBe(12);
  });

  it('compound /= assignment', () => {
    expect(runAndGet('$x = 20; $x /= 4', 'x')).toBe(5);
  });

  it('compound %= assignment', () => {
    expect(runAndGet('$x = 17; $x %= 5', 'x')).toBe(2);
  });
});

// ─── 2. Arithmetic Expressions ─────────────────────────────────────────────

describe('2. Arithmetic Expressions', () => {
  it('addition', () => {
    expect(runAndGet('$r = 3 + 4', 'r')).toBe(7);
  });

  it('subtraction', () => {
    expect(runAndGet('$r = 10 - 3', 'r')).toBe(7);
  });

  it('multiplication', () => {
    expect(runAndGet('$r = 6 * 7', 'r')).toBe(42);
  });

  it('division', () => {
    expect(runAndGet('$r = 20 / 4', 'r')).toBe(5);
  });

  it('modulo', () => {
    expect(runAndGet('$r = 17 % 5', 'r')).toBe(2);
  });

  it('operator precedence: multiplication before addition', () => {
    expect(runAndGet('$r = 2 + 3 * 4', 'r')).toBe(14);
  });

  it('parentheses override precedence', () => {
    expect(runAndGet('$r = (2 + 3) * 4', 'r')).toBe(20);
  });

  it('unary minus', () => {
    expect(runAndGet('$r = -5', 'r')).toBe(-5);
  });

  it('unary negation of variable', () => {
    expect(runAndGet('$x = 7; $r = -$x', 'r')).toBe(-7);
  });

  it('increment operator ++', () => {
    expect(runAndGet('$x = 5; $x++', 'x')).toBe(6);
  });

  it('decrement operator --', () => {
    expect(runAndGet('$x = 5; $x--', 'x')).toBe(4);
  });

  it('prefix increment ++$x', () => {
    expect(runAndGet('$x = 5; ++$x', 'x')).toBe(6);
  });
});

// ─── 3. Comparison Operators ───────────────────────────────────────────────

describe('3. Comparison Operators', () => {
  it('-eq true', () => {
    expect(runAndGet('$r = 5 -eq 5', 'r')).toBe(true);
  });

  it('-eq false', () => {
    expect(runAndGet('$r = 5 -eq 6', 'r')).toBe(false);
  });

  it('-ne', () => {
    expect(runAndGet('$r = 5 -ne 6', 'r')).toBe(true);
  });

  it('-gt', () => {
    expect(runAndGet('$r = 10 -gt 5', 'r')).toBe(true);
  });

  it('-lt', () => {
    expect(runAndGet('$r = 3 -lt 5', 'r')).toBe(true);
  });

  it('-ge', () => {
    expect(runAndGet('$r = 5 -ge 5', 'r')).toBe(true);
  });

  it('-le', () => {
    expect(runAndGet('$r = 4 -le 5', 'r')).toBe(true);
  });

  it('string -eq case-insensitive', () => {
    expect(runAndGet('$r = "hello" -eq "HELLO"', 'r')).toBe(true);
  });

  it('string -ceq case-sensitive true', () => {
    expect(runAndGet('$r = "hello" -ceq "hello"', 'r')).toBe(true);
  });

  it('string -ceq case-sensitive false', () => {
    expect(runAndGet('$r = "hello" -ceq "HELLO"', 'r')).toBe(false);
  });

  it('-like wildcard', () => {
    expect(runAndGet('$r = "hello" -like "h*"', 'r')).toBe(true);
  });

  it('-like wildcard false', () => {
    expect(runAndGet('$r = "hello" -like "x*"', 'r')).toBe(false);
  });

  it('-match regex', () => {
    expect(runAndGet('$r = "hello123" -match "[0-9]+"', 'r')).toBe(true);
  });

  it('-notmatch regex', () => {
    expect(runAndGet('$r = "hello" -notmatch "[0-9]+"', 'r')).toBe(true);
  });
});

// ─── 4. Logical Operators ──────────────────────────────────────────────────

describe('4. Logical Operators', () => {
  it('-and true', () => {
    expect(runAndGet('$r = $true -and $true', 'r')).toBe(true);
  });

  it('-and false', () => {
    expect(runAndGet('$r = $true -and $false', 'r')).toBe(false);
  });

  it('-or true', () => {
    expect(runAndGet('$r = $false -or $true', 'r')).toBe(true);
  });

  it('-or false', () => {
    expect(runAndGet('$r = $false -or $false', 'r')).toBe(false);
  });

  it('-xor', () => {
    expect(runAndGet('$r = $true -xor $false', 'r')).toBe(true);
  });

  it('-not true -> false', () => {
    expect(runAndGet('$r = -not $true', 'r')).toBe(false);
  });

  it('-not false -> true', () => {
    expect(runAndGet('$r = -not $false', 'r')).toBe(true);
  });

  it('! operator', () => {
    expect(runAndGet('$r = !$true', 'r')).toBe(false);
  });
});

// ─── 5. String Expansion ───────────────────────────────────────────────────

describe('5. String Expansion', () => {
  it('double-quoted string expands $variable', () => {
    expect(runAndGet('$name = "World"; $r = "Hello $name"', 'r')).toBe('Hello World');
  });

  it('single-quoted string is literal', () => {
    expect(runAndGet('$name = "World"; $r = \'Hello $name\'', 'r')).toBe('Hello $name');
  });

  it('double-quoted string with no variables', () => {
    expect(runAndGet('$r = "plain text"', 'r')).toBe('plain text');
  });

  it('expands variable in middle of string', () => {
    expect(runAndGet('$x = 42; $r = "value is $x ok"', 'r')).toBe('value is 42 ok');
  });

  it('escape backtn in double-quoted string', () => {
    expect(runAndGet('$r = "line1`nline2"', 'r')).toBe('line1\nline2');
  });

  it('escape backtot in double-quoted string', () => {
    expect(runAndGet('$r = "tab`there"', 'r')).toBe('tab\there');
  });

  it('escape dollar with backtick', () => {
    expect(runAndGet('$r = "price: `$5"', 'r')).toBe('price: $5');
  });

  it('string concatenation with +', () => {
    expect(runAndGet('$r = "hello" + " " + "world"', 'r')).toBe('hello world');
  });

  it('string multiplication', () => {
    expect(runAndGet('$r = "ab" * 3', 'r')).toBe('ababab');
  });

  it('-replace operator', () => {
    expect(runAndGet('$r = "hello world" -replace "world","PS"', 'r')).toBe('hello PS');
  });

  it('-split operator', () => {
    const result = runAndGet('$r = "a,b,c" -split ","', 'r') as string[];
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('-join operator', () => {
    expect(runAndGet('$r = "a","b","c" -join "-"', 'r')).toBe('a-b-c');
  });
});

// ─── 6. Write-Output / Write-Host ─────────────────────────────────────────

describe('6. Write-Output / Write-Host', () => {
  it('Write-Output produces output string', () => {
    expect(output('Write-Output "hello"')).toContain('hello');
  });

  it('Write-Host produces output string', () => {
    expect(output('Write-Host "hello"')).toContain('hello');
  });

  it('Write-Output with variable', () => {
    expect(output('$x = 42; Write-Output $x')).toContain('42');
  });

  it('multiple Write-Output calls', () => {
    const out = output('Write-Output "line1"\nWrite-Output "line2"');
    expect(out).toContain('line1');
    expect(out).toContain('line2');
  });

  it('echo alias works', () => {
    expect(output('echo "hello"')).toContain('hello');
  });
});

// ─── 7. Conditional Statements ─────────────────────────────────────────────

describe('7. Conditional Statements', () => {
  it('if true branch executes', () => {
    expect(runAndGet('if ($true) { $r = "yes" }', 'r')).toBe('yes');
  });

  it('if false branch skips', () => {
    const interp = new PSInterpreter();
    interp.execute('if ($false) { $r = "yes" }');
    expect(interp.getVariable('r')).toBeUndefined();
  });

  it('if-else: true takes if branch', () => {
    expect(runAndGet('if ($true) { $r = "yes" } else { $r = "no" }', 'r')).toBe('yes');
  });

  it('if-else: false takes else branch', () => {
    expect(runAndGet('if ($false) { $r = "yes" } else { $r = "no" }', 'r')).toBe('no');
  });

  it('if-elseif-else: first true', () => {
    expect(runAndGet('$x=1; if ($x -eq 1) { $r="one" } elseif ($x -eq 2) { $r="two" } else { $r="other" }', 'r')).toBe('one');
  });

  it('if-elseif-else: second true', () => {
    expect(runAndGet('$x=2; if ($x -eq 1) { $r="one" } elseif ($x -eq 2) { $r="two" } else { $r="other" }', 'r')).toBe('two');
  });

  it('if-elseif-else: else branch', () => {
    expect(runAndGet('$x=3; if ($x -eq 1) { $r="one" } elseif ($x -eq 2) { $r="two" } else { $r="other" }', 'r')).toBe('other');
  });

  it('nested if statements', () => {
    expect(runAndGet('$x=5; if ($x -gt 0) { if ($x -gt 3) { $r="big" } else { $r="small" } }', 'r')).toBe('big');
  });

  it('comparison in condition', () => {
    expect(runAndGet('$x = 10; if ($x -gt 5) { $r = "gt5" }', 'r')).toBe('gt5');
  });
});

// ─── 8. While / Do-While / Do-Until Loops ──────────────────────────────────

describe('8. While / Do-While / Do-Until Loops', () => {
  it('while loop runs correct number of times', () => {
    expect(runAndGet('$x = 0; while ($x -lt 5) { $x++ }', 'x')).toBe(5);
  });

  it('while loop with body accumulating value', () => {
    expect(runAndGet('$sum = 0; $i = 1; while ($i -le 5) { $sum += $i; $i++ }', 'sum')).toBe(15);
  });

  it('while loop skips when condition is false', () => {
    const interp = new PSInterpreter();
    interp.execute('$x = 0; while ($false) { $x++ }');
    expect(interp.getVariable('x')).toBe(0);
  });

  it('do-while runs at least once', () => {
    expect(runAndGet('$x = 0; do { $x++ } while ($false)', 'x')).toBe(1);
  });

  it('do-while loop', () => {
    expect(runAndGet('$x = 0; do { $x++ } while ($x -lt 3)', 'x')).toBe(3);
  });

  it('do-until runs until condition is true', () => {
    expect(runAndGet('$x = 0; do { $x++ } until ($x -ge 3)', 'x')).toBe(3);
  });

  it('break exits while loop', () => {
    expect(runAndGet('$x = 0; while ($true) { $x++; if ($x -eq 3) { break } }', 'x')).toBe(3);
  });

  it('continue skips iteration', () => {
    expect(runAndGet('$sum = 0; $i = 0; while ($i -lt 5) { $i++; if ($i -eq 3) { continue }; $sum += $i }', 'sum')).toBe(12);
  });
});

// ─── 9. For Loop ───────────────────────────────────────────────────────────

describe('9. For Loop', () => {
  it('basic for loop', () => {
    expect(runAndGet('$sum = 0; for ($i = 0; $i -lt 5; $i++) { $sum += $i }', 'sum')).toBe(10);
  });

  it('for loop with decrement', () => {
    expect(runAndGet('$x = 0; for ($i = 5; $i -gt 0; $i--) { $x++ }', 'x')).toBe(5);
  });

  it('for loop variable available after loop', () => {
    expect(runAndGet('for ($i = 0; $i -lt 3; $i++) {}', 'i')).toBe(3);
  });
});

// ─── 10. Foreach Loop ──────────────────────────────────────────────────────

describe('10. Foreach Loop', () => {
  it('foreach over array literal', () => {
    expect(runAndGet('$sum = 0; foreach ($n in 1,2,3,4,5) { $sum += $n }', 'sum')).toBe(15);
  });

  it('foreach over variable array', () => {
    expect(runAndGet('$arr = 1,2,3; $sum = 0; foreach ($n in $arr) { $sum += $n }', 'sum')).toBe(6);
  });

  it('foreach builds a new array', () => {
    const result = runAndGet(
      '$src = 1,2,3; $dst = @(); foreach ($n in $src) { $dst += $n * 2 }',
      'dst'
    ) as number[];
    expect(result).toEqual([2, 4, 6]);
  });

  it('foreach loop variable holds last value', () => {
    expect(runAndGet('foreach ($n in 1,2,3) {}', 'n')).toBe(3);
  });
});

// ─── 11. Functions ─────────────────────────────────────────────────────────

describe('11. Functions', () => {
  it('defines and calls a function', () => {
    expect(output('function SayHello { Write-Output "Hello" }\nSayHello')).toContain('Hello');
  });

  it('function with param block', () => {
    expect(output('function Greet { param($Name); Write-Output "Hi $Name" }\nGreet -Name "Alice"')).toContain('Hi Alice');
  });

  it('function returns value via return', () => {
    expect(runAndGet('function Double { param($n); return $n * 2 }; $r = Double -n 5', 'r')).toBe(10);
  });

  it('function implicit return (last expression)', () => {
    expect(runAndGet('function Add { param($a, $b); $a + $b }; $r = Add -a 3 -b 4', 'r')).toBe(7);
  });

  it('function is scoped — local var not visible outside', () => {
    const interp = new PSInterpreter();
    interp.execute('function Foo { $local = 99 }; Foo');
    expect(interp.getVariable('local')).toBeUndefined();
  });

  it('function can access outer scope variable', () => {
    expect(runAndGet('$x = 10; function GetX { $x }; $r = GetX', 'r')).toBe(10);
  });
});

// ─── 12. Arrays ─────────────────────────────────────────────────────────────

describe('12. Arrays', () => {
  it('creates array with comma operator', () => {
    const result = runAndGet('$arr = 1,2,3', 'arr') as number[];
    expect(result).toEqual([1, 2, 3]);
  });

  it('creates array with @()', () => {
    const result = runAndGet('$arr = @(1,2,3)', 'arr') as number[];
    expect(result).toEqual([1, 2, 3]);
  });

  it('empty array @()', () => {
    const result = runAndGet('$arr = @()', 'arr') as unknown[];
    expect(result).toEqual([]);
  });

  it('array index access', () => {
    expect(runAndGet('$arr = 10,20,30; $r = $arr[1]', 'r')).toBe(20);
  });

  it('array negative index', () => {
    expect(runAndGet('$arr = 10,20,30; $r = $arr[-1]', 'r')).toBe(30);
  });

  it('array += appends element', () => {
    const result = runAndGet('$arr = @(1,2); $arr += 3', 'arr') as number[];
    expect(result).toEqual([1, 2, 3]);
  });

  it('array count', () => {
    expect(runAndGet('$arr = 1,2,3,4; $r = $arr.Count', 'r')).toBe(4);
  });

  it('array Length property', () => {
    expect(runAndGet('$arr = 1,2,3; $r = $arr.Length', 'r')).toBe(3);
  });
});

// ─── 13. Hashtables ─────────────────────────────────────────────────────────

describe('13. Hashtables', () => {
  it('creates a hashtable', () => {
    const result = runAndGet('$h = @{ Name = "Alice"; Age = 30 }', 'h') as Record<string, unknown>;
    expect(result['Name']).toBe('Alice');
    expect(result['Age']).toBe(30);
  });

  it('accesses hashtable with dot notation', () => {
    expect(runAndGet('$h = @{ Key = "val" }; $r = $h.Key', 'r')).toBe('val');
  });

  it('accesses hashtable with bracket notation', () => {
    expect(runAndGet('$h = @{ Key = "val" }; $r = $h["Key"]', 'r')).toBe('val');
  });

  it('hashtable property assignment', () => {
    expect(runAndGet('$h = @{}; $h["x"] = 42; $r = $h["x"]', 'r')).toBe(42);
  });

  it('hashtable Count', () => {
    expect(runAndGet('$h = @{ a = 1; b = 2; c = 3 }; $r = $h.Count', 'r')).toBe(3);
  });
});

// ─── 14. Pipeline ───────────────────────────────────────────────────────────

describe('14. Pipeline', () => {
  it('pipes value through Where-Object', () => {
    const result = runAndGet('$r = 1,2,3,4,5 | Where-Object { $_ -gt 3 }', 'r') as number[];
    expect(result).toEqual([4, 5]);
  });

  it('pipes value through ForEach-Object', () => {
    const result = runAndGet('$r = 1,2,3 | ForEach-Object { $_ * 2 }', 'r') as number[];
    expect(result).toEqual([2, 4, 6]);
  });

  it('pipes through Select-Object', () => {
    const arr = [{ Name: 'Alice', Age: 30 }, { Name: 'Bob', Age: 25 }];
    const interp = new PSInterpreter();
    interp.setVariable('people', arr);
    interp.execute('$r = $people | Select-Object Name');
    const result = interp.getVariable('r') as Array<{ Name: string }>;
    expect(result.map(p => p.Name)).toEqual(['Alice', 'Bob']);
  });

  it('chained pipeline', () => {
    const result = runAndGet('$r = 1,2,3,4,5 | Where-Object { $_ -gt 2 } | ForEach-Object { $_ * 10 }', 'r') as number[];
    expect(result).toEqual([30, 40, 50]);
  });

  it('Measure-Object -Sum', () => {
    const interp = new PSInterpreter();
    interp.execute('$r = 1,2,3,4,5 | Measure-Object -Sum');
    const r = interp.getVariable('r') as { Sum: number };
    expect(r.Sum).toBe(15);
  });
});

// ─── 15. Error Handling ─────────────────────────────────────────────────────

describe('15. Error Handling', () => {
  it('try-catch catches thrown error', () => {
    expect(runAndGet('try { throw "oops" } catch { $r = "caught" }', 'r')).toBe('caught');
  });

  it('try-catch exposes $_ in catch block', () => {
    expect(runAndGet('try { throw "my error" } catch { $r = $_.Message }', 'r')).toBe('my error');
  });

  it('try-finally runs finally block', () => {
    expect(runAndGet('try { $x = 1 } finally { $r = "done" }', 'r')).toBe('done');
  });

  it('try-catch-finally runs all blocks', () => {
    expect(runAndGet('try { throw "err" } catch { $caught = "yes" } finally { $r = "fin" }', 'r')).toBe('fin');
  });

  it('uncaught throw propagates', () => {
    const interp = new PSInterpreter();
    expect(() => interp.execute('throw "boom"')).toThrow('boom');
  });
});

// ─── 16. Type Casting ───────────────────────────────────────────────────────

describe('16. Type Casting', () => {
  it('[int] casts string to integer', () => {
    expect(runAndGet('$r = [int]"42"', 'r')).toBe(42);
  });

  it('[string] casts integer to string', () => {
    expect(runAndGet('$r = [string]42', 'r')).toBe('42');
  });

  it('[bool] casts 1 to true', () => {
    expect(runAndGet('$r = [bool]1', 'r')).toBe(true);
  });

  it('[bool] casts 0 to false', () => {
    expect(runAndGet('$r = [bool]0', 'r')).toBe(false);
  });

  it('[double] casts string to float', () => {
    expect(runAndGet('$r = [double]"3.14"', 'r')).toBeCloseTo(3.14);
  });
});

// ─── 17. Built-in Variables ─────────────────────────────────────────────────

describe('17. Built-in Variables', () => {
  it('$true is boolean true', () => {
    expect(runAndGet('$r = $true', 'r')).toBe(true);
  });

  it('$false is boolean false', () => {
    expect(runAndGet('$r = $false', 'r')).toBe(false);
  });

  it('$null is null', () => {
    expect(runAndGet('$r = $null', 'r')).toBeNull();
  });

  it('$PSVersionTable has PSVersion', () => {
    const interp = new PSInterpreter();
    interp.execute('');
    const table = interp.getVariable('PSVersionTable') as Record<string, unknown>;
    expect(table).toBeDefined();
    expect(table['PSVersion']).toBeDefined();
  });
});

// ─── 18. Range Operator ─────────────────────────────────────────────────────

describe('18. Range Operator', () => {
  it('1..5 creates range array', () => {
    const result = runAndGet('$r = 1..5', 'r') as number[];
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it('range in foreach', () => {
    expect(runAndGet('$sum = 0; foreach ($n in 1..10) { $sum += $n }', 'sum')).toBe(55);
  });

  it('descending range', () => {
    const result = runAndGet('$r = 5..1', 'r') as number[];
    expect(result).toEqual([5, 4, 3, 2, 1]);
  });
});

// ─── 19. String Methods ─────────────────────────────────────────────────────

describe('19. String Methods', () => {
  it('.ToUpper()', () => {
    expect(runAndGet('$r = "hello".ToUpper()', 'r')).toBe('HELLO');
  });

  it('.ToLower()', () => {
    expect(runAndGet('$r = "HELLO".ToLower()', 'r')).toBe('hello');
  });

  it('.Trim()', () => {
    expect(runAndGet('$r = "  hello  ".Trim()', 'r')).toBe('hello');
  });

  it('.Length property', () => {
    expect(runAndGet('$r = "hello".Length', 'r')).toBe(5);
  });

  it('.Contains()', () => {
    expect(runAndGet('$r = "hello world".Contains("world")', 'r')).toBe(true);
  });

  it('.StartsWith()', () => {
    expect(runAndGet('$r = "hello".StartsWith("hel")', 'r')).toBe(true);
  });

  it('.Replace()', () => {
    expect(runAndGet('$r = "hello world".Replace("world", "PS")', 'r')).toBe('hello PS');
  });

  it('.Split()', () => {
    const result = runAndGet('$r = "a,b,c".Split(",")', 'r') as string[];
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('.Substring()', () => {
    expect(runAndGet('$r = "hello".Substring(1, 3)', 'r')).toBe('ell');
  });
});

// ─── 20. Switch Statement ───────────────────────────────────────────────────

describe('20. Switch Statement', () => {
  it('switch matches exact value', () => {
    expect(runAndGet('switch (2) { 1 { $r = "one" } 2 { $r = "two" } 3 { $r = "three" } }', 'r')).toBe('two');
  });

  it('switch default', () => {
    expect(runAndGet('switch (99) { 1 { $r = "one" } default { $r = "other" } }', 'r')).toBe('other');
  });

  it('switch with string', () => {
    expect(runAndGet('switch ("hello") { "hello" { $r = "matched" } default { $r = "no" } }', 'r')).toBe('matched');
  });

  it('switch case-insensitive by default', () => {
    expect(runAndGet('switch ("Hello") { "hello" { $r = "matched" } }', 'r')).toBe('matched');
  });
});
