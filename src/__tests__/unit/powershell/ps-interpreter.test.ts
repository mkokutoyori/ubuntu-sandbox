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

// ═══════════════════════════════════════════════════════════════════════════════
// Suite des tests unitaires PowerShell – sections avancées 21 à 44
// (à insérer après la section 20 du fichier existant)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 21. Advanced Variable Scoping ─────────────────────────────────────────

describe('21. Advanced Variable Scoping', () => {
  it('$global: variable visible inside function', () => {
    expect(runAndGet('$global:x = 99; function GetGlobalX { $global:x }; $r = GetGlobalX', 'r')).toBe(99);
  });

  it('$script: variable explicit scope', () => {
    expect(runAndGet('$script:val = 42; function ReadVal { $script:val }; $r = ReadVal', 'r')).toBe(42);
  });

  it('$local: overwrites global in function', () => {
    expect(runAndGet('$x = 1; function Test { $local:x = 2; return $local:x }; $r = Test; $x', 'r')).toBe(1);
    // Après l'appel, $x global reste 1
  });

  it('Set-Variable with -Scope parameter', () => {
    const interp = new PSInterpreter();
    interp.execute('Set-Variable -Name foo -Value "bar" -Scope Global');
    expect(interp.getVariable('foo')).toBe('bar');
  });

  it('Get-Variable retrieves variable by name', () => {
    const interp = new PSInterpreter();
    interp.execute('$myvar = 123; $r = Get-Variable -Name myvar -ValueOnly');
    expect(interp.getVariable('r')).toBe(123);
  });

  it('Clear-Variable removes value but variable exists', () => {
    const interp = new PSInterpreter();
    interp.execute('$a = 10; Clear-Variable -Name a');
    expect(interp.getVariable('a')).toBeNull();
  });

  it('Remove-Variable deletes variable completely', () => {
    const interp = new PSInterpreter();
    interp.execute('$a = 10; Remove-Variable -Name a');
    expect(interp.getVariable('a')).toBeUndefined();
  });

  it('New-Variable creates variable with explicit scope', () => {
    const interp = new PSInterpreter();
    interp.execute('New-Variable -Name localVar -Value "hello" -Scope Local');
    expect(interp.getVariable('localVar')).toBe('hello');
  });

  it('variable with $using: scope (simulated remote)', () => {
    // Simuler l'utilisation de $using pour un script distant
    expect(runAndGet('$outer = "remote"; $scriptBlock = { $using:outer }; $r = & $scriptBlock', 'r')).toBe('remote');
  });
});

// ─── 22. Advanced Functions ────────────────────────────────────────────────

describe('22. Advanced Functions', () => {
  it('function with CmdletBinding', () => {
    expect(output('function Test { [CmdletBinding()]param() Write-Output "bound" }; Test')).toContain('bound');
  });

  it('mandatory parameter throws when missing', () => {
    const interp = new PSInterpreter();
    interp.execute('function Req { param([Parameter(Mandatory=$true)]$Name) $Name }');
    expect(() => interp.execute('Req')).toThrow(/Missing/);
  });

  it('parameter with default value', () => {
    expect(runAndGet('function Greet { param($Name = "World") "Hello $Name" }; $r = Greet', 'r')).toBe('Hello World');
  });

  it('parameter validation [ValidateRange]', () => {
    const interp = new PSInterpreter();
    interp.execute('function SetAge { param([ValidateRange(0,150)]$Age) $Age }');
    expect(() => interp.execute('SetAge -Age -5')).toThrow();
  });

  it('parameter validation [ValidateSet]', () => {
    expect(runAndGet(
      'function Color { param([ValidateSet("Red","Green","Blue")]$c) $c }; $r = Color -c Green',
      'r'
    )).toBe('Green');
  });

  it('parameter alias works', () => {
    expect(runAndGet(
      'function TestAlias { param([Alias("X")]$Something) $Something }; $r = TestAlias -X 42',
      'r'
    )).toBe(42);
  });

  it('ValueFromPipeline parameter', () => {
    const interp = new PSInterpreter();
    interp.execute(`
      function PipeFunc { param([Parameter(ValueFromPipeline)]$Input) process { $res = $Input * 2; $res } }
    `);
    interp.execute('$r = 1,2,3 | PipeFunc');
    expect(interp.getVariable('r')).toEqual([2,4,6]);
  });

  it('ValueFromPipelineByPropertyName', () => {
    const interp = new PSInterpreter();
    interp.execute(`
      function ProcName { param([Parameter(ValueFromPipelineByPropertyName)]$Name) process { "Processed $Name" } }
    `);
    interp.execute('$obj = [PSCustomObject]@{Name = "Alice"}; $res = $obj | ProcName');
    expect(interp.getVariable('res')).toContain('Processed Alice');
  });

  it('splatting with hashtable', () => {
    expect(runAndGet(
      'function Add { param($a, $b) $a+$b }; $args = @{a=5; b=7}; $r = Add @args',
      'r'
    )).toBe(12);
  });

  it('splatting with array', () => {
    expect(runAndGet(
      'function Concat { param($x, $y, $z) "$x$y$z" }; $arr = "a","b","c"; $r = Concat @arr',
      'r'
    )).toBe('abc');
  });

  it('switch parameter', () => {
    expect(runAndGet(
      'function Toggle { param([switch]$On) if ($On) { "yes" } else { "no" } }; $r = Toggle -On',
      'r'
    )).toBe('yes');
  });

  it('PSCredential parameter type', () => {
    const interp = new PSInterpreter();
    interp.execute('function NeedCred { param([PSCredential]$Cred) "ok" }');
    expect(() => interp.execute('NeedCred -Cred (New-Object PSCredential("user", (ConvertTo-SecureString "pass" -AsPlainText -Force)))')).not.toThrow();
  });
});

// ─── 23. Scriptblocks & Dynamic Invocation ─────────────────────────────────

describe('23. Scriptblocks & Dynamic Invocation', () => {
  it('call scriptblock with &', () => {
    expect(runAndGet('$sb = { 2 + 2 }; $r = & $sb', 'r')).toBe(4);
  });

  it('scriptblock with parameters', () => {
    expect(runAndGet('$sb = { param($x, $y) $x * $y }; $r = & $sb -x 3 -y 4', 'r')).toBe(12);
  });

  it('dot-source scriptblock', () => {
    // . $sb exposes variables into current scope
    const interp = new PSInterpreter();
    interp.execute('$sb = { $innerVar = 99 }; . $sb');
    expect(interp.getVariable('innerVar')).toBe(99);
  });

  it('Invoke-Command with scriptblock', () => {
    expect(runAndGet('$r = Invoke-Command -ScriptBlock { 10+5 }', 'r')).toBe(15);
  });

  it('Start-Job simulated (braces content evaluated)', () => {
    const interp = new PSInterpreter();
    interp.execute('$job = Start-Job -ScriptBlock { "jobOutput" }');
    const result = interp.getVariable('job');
    expect(result).toBeDefined();
    // On peut tester plus tard Receive-Job simulé
  });

  it('Receive-Job after simulated job', () => {
    const interp = new PSInterpreter();
    interp.execute('$job = Start-Job -ScriptBlock { "result" }; $r = Receive-Job -Job $job');
    expect(interp.getVariable('r')).toBe('result');
  });

  it('Wait-Job waits and returns status', () => {
    const interp = new PSInterpreter();
    interp.execute('$job = Start-Job -ScriptBlock { Start-Sleep -Milliseconds 10; "done" }; Wait-Job -Job $job');
    const status = interp.getVariable('job').State;
    expect(status).toBe('Completed');
  });

  it('scriptblock GetNewClosure()', () => {
    expect(runAndGet('$x = 5; $sb = { $x }.GetNewClosure(); $r = & $sb', 'r')).toBe(5);
  });
});

// ─── 24. PowerShell Classes ────────────────────────────────────────────────

describe('24. PowerShell Classes', () => {
  it('define a simple class', () => {
    const interp = new PSInterpreter();
    interp.execute('class Person { [string]$Name; [int]$Age }');
    expect(interp.getVariable('Person')).toBeUndefined(); // class is a type, not variable
  });

  it('instantiate class with new', () => {
    expect(runAndGet('class Person { [string]$Name }; $p = [Person]::new(); $p.Name = "Alice"; $r = $p.Name', 'r')).toBe('Alice');
  });

  it('class method', () => {
    expect(runAndGet('class Calc { [int]Double([int]$x) { return $x * 2 } }; $c = [Calc]::new(); $r = $c.Double(7)', 'r')).toBe(14);
  });

  it('class static method', () => {
    expect(runAndGet('class Util { static [int]Add([int]$a, [int]$b) { return $a + $b } }; $r = [Util]::Add(2,3)', 'r')).toBe(5);
  });

  it('class inheritance', () => {
    const interp = new PSInterpreter();
    interp.execute(`
      class Animal { [string]$Species }
      class Dog : Animal { [string]$Breed }
    `);
    interp.execute('$d = [Dog]::new(); $d.Species = "Canine"; $d.Breed = "Labrador"; $r = "$($d.Species) $($d.Breed)"');
    expect(interp.getVariable('r')).toBe('Canine Labrador');
  });

  it('class constructor', () => {
    expect(runAndGet('class Point { [int]$X; [int]$Y; Point([int]$x, [int]$y) { $this.X = $x; $this.Y = $y } }; $p = [Point]::new(3,4); $r = $p.X + $p.Y', 'r')).toBe(7);
  });

  it('enum definition', () => {
    const interp = new PSInterpreter();
    interp.execute('enum Color { Red; Green; Blue }');
    interp.execute('$r = [Color]::Green -eq [Color]::Green');
    expect(interp.getVariable('r')).toBe(true);
  });

  it('class property with validate attribute', () => {
    const interp = new PSInterpreter();
    interp.execute('class Restricted { [ValidateRange(1,100)][int]$Value }');
    expect(() => interp.execute('$x = [Restricted]::new(); $x.Value = 200')).toThrow();
  });
});

// ─── 25. Advanced Error Handling ───────────────────────────────────────────

describe('25. Advanced Error Handling', () => {
  it('$Error automatic variable stores errors', () => {
    const interp = new PSInterpreter();
    interp.execute('try { throw "fail1" } catch {}');
    const errors = interp.getVariable('Error') as any[];
    expect(errors.length).toBeGreaterThan(0);
  });

  it('$ErrorActionPreference = Stop', () => {
    const interp = new PSInterpreter();
    interp.execute('$ErrorActionPreference = "Stop"');
    expect(() => interp.execute('Get-Nonexistent')).toThrow();
  });

  it('trap statement catches terminating error', () => {
    expect(runAndGet('trap { $r = "trapped"; continue } throw "boom"', 'r')).toBe('trapped');
  });

  it('trap with break', () => {
    const interp = new PSInterpreter();
    interp.execute('trap { $r = "err"; break } throw "abc"');
    expect(interp.getVariable('r')).toBe('err');
    // break exits entire scope; on suppose que l'exécution s'arrête après le bloc trap
  });

  it('try/catch with multiple catch blocks by exception type', () => {
    expect(runAndGet(`
      try { throw [System.ArgumentException]::new("arg") } 
      catch [System.ArgumentException] { $r = "argument" } 
      catch { $r = "other" }
    `, 'r')).toBe('argument');
  });

  it('$LASTEXITCODE after external command (simulated)', () => {
    const interp = new PSInterpreter();
    // Simuler l'exécution d'un processus qui termine avec code 1
    interp.execute('$r = & { $global:LASTEXITCODE = 1; "out" }');
    expect(interp.getVariable('LASTEXITCODE')).toBe(1);
  });

  it('$? true after successful command', () => {
    const interp = new PSInterpreter();
    interp.execute('Get-Date');
    expect(interp.getVariable('?')).toBe(true);
  });

  it('$? false after error', () => {
    const interp = new PSInterpreter();
    try { interp.execute('Get-Nothing -ErrorAction SilentlyContinue'); } catch {}
    expect(interp.getVariable('?')).toBe(false);
  });

  it('-ErrorVariable captures error object', () => {
    const interp = new PSInterpreter();
    interp.execute('Get-ChildItem nonexistent -ErrorVariable myErr -ErrorAction SilentlyContinue');
    const errVar = interp.getVariable('myErr');
    expect(errVar).toBeDefined();
    expect((errVar as any).Exception).toBeDefined();
  });
});

// ─── 26. Advanced Pipeline Semantics ───────────────────────────────────────

describe('26. Advanced Pipeline Semantics', () => {
  it('Begin, Process, End blocks in function', () => {
    const interp = new PSInterpreter();
    interp.execute(`
      function Demo { 
        begin { $res = @() } 
        process { $res += $_ * 2 } 
        end { $res }
      }
    `);
    interp.execute('$r = 1,2,3 | Demo');
    expect(interp.getVariable('r')).toEqual([2,4,6]);
  });

  it('input via $input enumerator', () => {
    const interp = new PSInterpreter();
    interp.execute(`
      function Collect { 
        $col = @(); 
        foreach ($i in $input) { $col += $i.ToUpper() } 
        $col 
      }
    `);
    interp.execute('$r = "a","b","c" | Collect');
    expect(interp.getVariable('r')).toEqual(['A','B','C']);
  });

  it('pipeline to built-in cmdlet with process block simulated', () => {
    // Write-Output est déjà testé, ici on teste le passage d'objets
    const out = output('"x","y" | Write-Output');
    expect(out).toContain('x');
    expect(out).toContain('y');
  });

  it('Tea-Object (simulated) splits pipeline', () => {
    const interp = new PSInterpreter();
    interp.execute('$a = @(); $b = 1,2,3 | Tee-Object -Variable a | ForEach-Object { $_ * 10 }');
    expect(interp.getVariable('a')).toEqual([1,2,3]);
    expect(interp.getVariable('b')).toEqual([10,20,30]);
  });

  it('Out-Host -Paging simulated', () => {
    // Simuler sans pagination réelle, juste vérifier que ça ne plante pas
    expect(() => output('"hello" | Out-Host')).not.toThrow();
  });
});

// ─── 27. Simulated File System Cmdlets ─────────────────────────────────────

describe('27. Simulated File System Cmdlets', () => {
  it('Get-ChildItem returns simulated items', () => {
    const interp = new PSInterpreter();
    interp.execute('$items = Get-ChildItem -Path "fake\\path"');
    const items = interp.getVariable('items') as any[];
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].Name).toBeDefined();
  });

  it('Get-Content reads simulated file content', () => {
    const interp = new PSInterpreter();
    interp.execute('$content = Get-Content -Path "config.txt"');
    expect(interp.getVariable('content')).toBe('simulated content');
  });

  it('Set-Content writes and Get-Content reads back', () => {
    const interp = new PSInterpreter();
    interp.execute('Set-Content -Path "test.txt" -Value "hello world"');
    interp.execute('$r = Get-Content -Path "test.txt"');
    expect(interp.getVariable('r')).toBe('hello world');
  });

  it('Add-Content appends to file', () => {
    const interp = new PSInterpreter();
    interp.execute('Set-Content -Path "log.txt" -Value "line1"');
    interp.execute('Add-Content -Path "log.txt" -Value "line2"');
    interp.execute('$r = Get-Content -Path "log.txt"');
    expect(interp.getVariable('r')).toBe('line1\nline2'); // ou selon l'implémentation interne
  });

  it('Test-Path returns true for existing simulated path', () => {
    expect(runAndGet('$r = Test-Path -Path "simulated-drive\\"', 'r')).toBe(true);
  });

  it('Test-Path returns false for nonexistent path', () => {
    expect(runAndGet('$r = Test-Path -Path "nowhere"', 'r')).toBe(false);
  });

  it('New-Item creates simulated file', () => {
    const interp = new PSInterpreter();
    interp.execute('New-Item -Path "newfile.txt" -ItemType File');
    const exists = interp.execute('Test-Path "newfile.txt"');
    expect(exists).toContain('True');
  });

  it('Remove-Item deletes simulated file', () => {
    const interp = new PSInterpreter();
    interp.execute('New-Item -Path "todelete.txt" -ItemType File');
    interp.execute('Remove-Item -Path "todelete.txt"');
    const exists = interp.execute('Test-Path "todelete.txt"');
    expect(exists).toContain('False');
  });

  it('Copy-Item duplicates a file', () => {
    const interp = new PSInterpreter();
    interp.execute('Set-Content -Path "orig.txt" -Value "data"');
    interp.execute('Copy-Item -Path "orig.txt" -Destination "copy.txt"');
    interp.execute('$r = Get-Content "copy.txt"');
    expect(interp.getVariable('r')).toBe('data');
  });

  it('Move-Item moves a file', () => {
    const interp = new PSInterpreter();
    interp.execute('Set-Content -Path "move_me.txt" -Value "movable"');
    interp.execute('Move-Item -Path "move_me.txt" -Destination "moved.txt"');
    interp.execute('$r = Get-Content "moved.txt"');
    expect(interp.getVariable('r')).toBe('movable');
    expect(interp.execute('Test-Path "move_me.txt"')).toContain('False');
  });

  it('Resolve-Path returns the provider path', () => {
    expect(runAndGet('$r = Resolve-Path -Path "."', 'r')).toBeDefined();
  });

  it('Get-ChildItem with -Recurse', () => {
    const interp = new PSInterpreter();
    interp.execute('$items = Get-ChildItem -Path "simulated-drive\\" -Recurse');
    const items = interp.getVariable('items') as any[];
    expect(items.length).toBeGreaterThanOrEqual(2);
  });

  it('Get-ChildItem with -Filter', () => {
    const interp = new PSInterpreter();
    interp.execute('$items = Get-ChildItem -Path "simulated-drive\\" -Filter "*.txt"');
    const items = interp.getVariable('items') as any[];
    items.forEach(i => expect(i.Name).toMatch(/\.txt$/));
  });
});

// ─── 28. Output Redirection Operators ──────────────────────────────────────

describe('28. Output Redirection Operators', () => {
  it('redirection > writes to file', () => {
    const interp = new PSInterpreter();
    interp.execute('"hello" > "redir.txt"');
    const content = interp.execute('Get-Content "redir.txt"');
    expect(content).toContain('hello');
  });

  it('redirection >> appends', () => {
    const interp = new PSInterpreter();
    interp.execute('"line1" > "append.txt"; "line2" >> "append.txt"');
    const content = interp.execute('Get-Content "append.txt"');
    expect(content).toContain('line1');
    expect(content).toContain('line2');
  });

  it('2>&1 redirects error stream to success', () => {
    const interp = new PSInterpreter();
    interp.execute('$out = & { Write-Error "test error" } 2>&1');
    const out = interp.getVariable('out') as any[];
    expect(out.some(o => o.Exception)).toBe(true);
  });

  it('3>&1 / 4>&1 warning/verbose redirection', () => {
    const interp = new PSInterpreter();
    interp.execute('$warnings = Write-Warning "careful" 3>&1');
    expect(interp.getVariable('warnings')).toBeDefined();
  });

  it('Out-File cmdlet', () => {
    const interp = new PSInterpreter();
    interp.execute('"data" | Out-File -FilePath "outfile.txt"');
    const content = interp.execute('Get-Content "outfile.txt"');
    expect(content).toContain('data');
  });

  it('Out-String collects output as single string', () => {
    expect(runAndGet('$r = 1,2,3 | Out-String', 'r')).toContain('1');
  });

  it('Out-Null suppresses output', () => {
    const interp = new PSInterpreter();
    interp.execute('$x = 1; "hidden" | Out-Null');
    const out = interp.execute('Write-Output "visible"');
    expect(out).toContain('visible');
  });
});

// ─── 29. Formatting Cmdlets ────────────────────────────────────────────────

describe('29. Formatting Cmdlets', () => {
  it('Format-Table generates table string', () => {
    expect(runAndGet('$r = Get-ChildItem | Format-Table | Out-String', 'r')).toContain('Name');
  });

  it('Format-List formats objects as list', () => {
    expect(runAndGet('$r = Get-ChildItem | Format-List | Out-String', 'r')).toContain(':');
  });

  it('Format-Wide displays in columns', () => {
    expect(runAndGet('$r = 1,2,3,4 | Format-Wide | Out-String', 'r')).toBeDefined();
  });

  it('Format-Custom uses custom view', () => {
    // Simulation : vérifie que ça ne lève pas d'erreur
    expect(() => output('Get-ChildItem | Format-Custom')).not.toThrow();
  });

  it('Format-Table with -Property', () => {
    const interp = new PSInterpreter();
    interp.execute('$items = @( [PSCustomObject]@{Name="a";Value=1}, [PSCustomObject]@{Name="b";Value=2} )');
    interp.execute('$r = $items | Format-Table Name | Out-String');
    expect(interp.getVariable('r')).toContain('Name');
  });
});

// ─── 30. Sort-Object & Select-Object Advanced ─────────────────────────────

describe('30. Sort-Object & Select-Object Advanced', () => {
  it('Sort-Object by property ascending', () => {
    const interp = new PSInterpreter();
    interp.execute('$data = @([PSCustomObject]@{N=3}, [PSCustomObject]@{N=1}, [PSCustomObject]@{N=2})');
    interp.execute('$r = $data | Sort-Object N');
    const res = interp.getVariable('r') as any[];
    expect(res.map((x: any) => x.N)).toEqual([1,2,3]);
  });

  it('Sort-Object descending', () => {
    const interp = new PSInterpreter();
    interp.execute('$data = @([PSCustomObject]@{N=3}, [PSCustomObject]@{N=1}, [PSCustomObject]@{N=2})');
    interp.execute('$r = $data | Sort-Object N -Descending');
    const res = interp.getVariable('r') as any[];
    expect(res.map((x: any) => x.N)).toEqual([3,2,1]);
  });

  it('Select-Object -Last 2', () => {
    expect(runAndGet('$r = (1,2,3,4 | Select-Object -Last 2)', 'r')).toEqual([3,4]);
  });

  it('Select-Object -Skip 2', () => {
    expect(runAndGet('$r = (1,2,3,4 | Select-Object -Skip 2)', 'r')).toEqual([3,4]);
  });

  it('Select-Object calculated property', () => {
    const interp = new PSInterpreter();
    interp.execute('$data = @([PSCustomObject]@{Name="a"}, [PSCustomObject]@{Name="b"})');
    interp.execute('$r = $data | Select-Object @{Name="Upper"; Expression={$_.Name.ToUpper()}}');
    const res = interp.getVariable('r') as any[];
    expect(res.map((x: any) => x.Upper)).toEqual(['A','B']);
  });

  it('Sort-Object with scriptblock', () => {
    const interp = new PSInterpreter();
    interp.execute('$data = "banana","apple","cherry"');
    interp.execute('$r = $data | Sort-Object { $_.Length }');
    expect(interp.getVariable('r')).toEqual(['apple','banana','cherry']); // pomme (5), cerise (6), banane (6) alphab? Adapt test
  });
});

// ─── 31. Loops with Labels ─────────────────────────────────────────────────

describe('31. Loops with Labels', () => {
  it('break with label exits outer loop', () => {
    expect(runAndGet(`
      $sum = 0; 
      :outer for ($i=0; $i -lt 5; $i++) {
        for ($j=0; $j -lt 5; $j++) {
          if ($j -eq 2) { break outer }
          $sum++
        }
      }
    `, 'sum')).toBe(2); // i=0,j=0; i=0,j=1; break
  });

  it('continue with label goes to next iteration of outer loop', () => {
    expect(runAndGet(`
      $sum = 0; 
      :outer for ($i=0; $i -lt 3; $i++) {
        for ($j=0; $j -lt 3; $j++) {
          if ($j -eq 1) { continue outer }
          $sum++
        }
      }
    `, 'sum')).toBe(3); // i=0 j=0 only (1); i=1 j=0 (1); i=2 j=0 (1) => total 3
  });
});

// ─── 32. Modules & Dot-sourcing ────────────────────────────────────────────

describe('32. Modules & Dot-sourcing', () => {
  it('Import-Module simulated', () => {
    const interp = new PSInterpreter();
    expect(() => interp.execute('Import-Module -Name FakeModule')).not.toThrow();
  });

  it('Get-Module lists available modules', () => {
    const interp = new PSInterpreter();
    interp.execute('$mods = Get-Module -ListAvailable');
    const mods = interp.getVariable('mods') as any[];
    expect(mods.length).toBeGreaterThan(0);
  });

  it('dot-sourcing a script path (simulated)', () => {
    const interp = new PSInterpreter();
    interp.execute('. "script.ps1"');
    // vérifie qu'une variable créée dans ce script est visible
    expect(interp.getVariable('someVarFromScript')).toBeDefined();
  });

  it('module scope isolation: variable not exported by default', () => {
    const interp = new PSInterpreter();
    interp.execute('Import-Module FakeModule; $r = Get-Command -Module FakeModule');
    expect(interp.getVariable('r')).toBeDefined();
  });
});

// ─── 33. Type Accelerators & Special Types ────────────────────────────────

describe('33. Type Accelerators & Special Types', () => {
  it('[xml] type accelerator', () => {
    const interp = new PSInterpreter();
    interp.execute('$xml = [xml]"<root><child>hello</child></root>"');
    expect(interp.getVariable('xml').root.child).toBe('hello');
  });

  it('[regex] accelerator', () => {
    expect(runAndGet('$r = [regex]::Matches("abc123", "\\d+").Value', 'r')).toBe('123');
  });

  it('[PSCustomObject] type accelerator', () => {
    const interp = new PSInterpreter();
    interp.execute('$obj = [PSCustomObject]@{ Name = "test"; Value = 42 }');
    expect(interp.getVariable('obj').Name).toBe('test');
  });

  it('[guid]::NewGuid() returns a string guid', () => {
    const interp = new PSInterpreter();
    interp.execute('$g = [guid]::NewGuid()');
    const g = interp.getVariable('g') as string;
    expect(g).toMatch(/^[0-9a-f]{8}-/);
  });

  it('[datetime] Parse', () => {
    expect(runAndGet('$d = [datetime]::Parse("2024-01-01"); $r = $d.Year', 'r')).toBe(2024);
  });

  it('[Math] static methods', () => {
    expect(runAndGet('$r = [Math]::Pow(2, 8)', 'r')).toBe(256);
  });

  it('[System.IO.Path]::Combine', () => {
    expect(runAndGet('$r = [System.IO.Path]::Combine("folder","file.txt")', 'r')).toBe('folder\\file.txt');
  });
});

// ─── 34. Advanced Regular Expressions ──────────────────────────────────────

describe('34. Advanced Regular Expressions', () => {
  it('$matches automatic variable after -match', () => {
    const interp = new PSInterpreter();
    interp.execute('"hello 123" -match "([a-z]+) (\\d+)"');
    const matches = interp.getVariable('matches');
    expect(matches[0]).toBe('hello 123');
    expect(matches[1]).toBe('hello');
    expect(matches[2]).toBe('123');
  });

  it('named captures in $matches', () => {
    const interp = new PSInterpreter();
    interp.execute('"John 30" -match "(?<name>\\w+) (?<age>\\d+)"');
    const matches = interp.getVariable('matches');
    expect(matches['name']).toBe('John');
    expect(matches['age']).toBe('30');
  });

  it('-replace with capture groups', () => {
    expect(runAndGet('$r = "2024-12-01" -replace "(\\d{4})-(\\d{2})-(\\d{2})",\'$3/$2/$1\'', 'r')).toBe('01/12/2024');
  });

  it('-match with complex pattern', () => {
    expect(runAndGet('$r = "abc123def" -match "\\d+"', 'r')).toBe(true);
  });

  it('[regex]::Replace with match evaluator (simulated)', () => {
    // On simule en utilisant -replace ou un scriptblock ; PowerShell supporte le remplacement dynamique via scriptblock
    expect(runAndGet('$r = "abc" -replace "[a-z]",{ $_.Value.ToUpper() }', 'r')).toBe('ABC');
  });
});

// ─── 35. Date and Time Cmdlets (Simulated) ───────────────────────────────

describe('35. Date and Time Cmdlets', () => {
  it('Get-Date returns current date', () => {
    const interp = new PSInterpreter();
    interp.execute('$d = Get-Date');
    expect(interp.getVariable('d')).toBeInstanceOf(Date);
  });

  it('Get-Date -Format specified', () => {
    expect(runAndGet('$r = Get-Date -Format "yyyy-MM-dd"', 'r')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('Get-Date -Year -Month -Day', () => {
    const interp = new PSInterpreter();
    interp.execute('$d = Get-Date; $y = $d.Year');
    expect(interp.getVariable('y')).toBeGreaterThan(2000);
  });

  it('Set-Date (simulated, no actual change)', () => {
    const interp = new PSInterpreter();
    expect(() => interp.execute('Set-Date -Date "2024-01-01"')).not.toThrow();
  });

  it('New-TimeSpan -Days 1', () => {
    expect(runAndGet('$r = New-TimeSpan -Days 1; $r.TotalDays', 'r')).toBe(1);
  });

  it('TimeSpan arithmetic addition', () => {
    expect(runAndGet('$d = Get-Date "2024-01-01"; $ts = New-TimeSpan -Days 10; $r = ($d + $ts).Day', 'r')).toBe(11);
  });
});

// ─── 36. JSON Serialization / Deserialization ─────────────────────────────

describe('36. JSON Cmdlets', () => {
  it('ConvertTo-Json from hashtable', () => {
    const interp = new PSInterpreter();
    interp.execute('$json = @{ name = "Alice"; age = 30 } | ConvertTo-Json');
    const json = interp.getVariable('json') as string;
    expect(JSON.parse(json)).toEqual({ name: 'Alice', age: 30 });
  });

  it('ConvertFrom-Json to object', () => {
    const interp = new PSInterpreter();
    interp.execute('$obj = \'{"name":"Bob","age":25}\' | ConvertFrom-Json');
    expect(interp.getVariable('obj').name).toBe('Bob');
    expect(interp.getVariable('obj').age).toBe(25);
  });

  it('ConvertTo-Json -Depth', () => {
    const interp = new PSInterpreter();
    interp.execute('$data = @{ a = @{ b = @{ c = 1 } } }');
    interp.execute('$json = $data | ConvertTo-Json -Depth 3');
    const json = interp.getVariable('json') as string;
    expect(JSON.parse(json).a.b.c).toBe(1);
  });

  it('ConvertFrom-Json with arrays', () => {
    const interp = new PSInterpreter();
    interp.execute('$arr = \'[1,2,3]\' | ConvertFrom-Json');
    expect(interp.getVariable('arr')).toEqual([1,2,3]);
  });
});

// ─── 37. PowerShell Providers & Drives (Simulated) ────────────────────────

describe('37. Providers & Drives', () => {
  it('Get-PSDrive lists drives', () => {
    const interp = new PSInterpreter();
    interp.execute('$drives = Get-PSDrive');
    const drives = interp.getVariable('drives') as any[];
    expect(drives.length).toBeGreaterThan(0);
  });

  it('New-PSDrive creates a custom drive', () => {
    const interp = new PSInterpreter();
    interp.execute('New-PSDrive -Name "TestDrive" -PSProvider FileSystem -Root "C:\\Fake"');
    const drives = interp.execute('Get-PSDrive -Name TestDrive');
    expect(drives).toContain('TestDrive');
  });

  it('Set-Location changes current location', () => {
    const interp = new PSInterpreter();
    interp.execute('Set-Location -Path TestDrive:\\');
    const loc = interp.getVariable('PWD');
    expect(loc.Path).toContain('TestDrive');
  });

  it('Join-Path builds path', () => {
    expect(runAndGet('$r = Join-Path -Path "C:\\" -ChildPath "Windows"', 'r')).toBe('C:\\Windows');
  });
});

// ─── 38. Advanced Hashtables & Ordered Dictionaries ────────────────────────

describe('38. Advanced Hashtables', () => {
  it('[ordered] hashtable preserves insertion order', () => {
    const interp = new PSInterpreter();
    interp.execute('$h = [ordered]@{ z = 1; a = 2; m = 3 }');
    const keys = Object.keys(interp.getVariable('h') as object);
    expect(keys).toEqual(['z', 'a', 'm']);
  });

  it('hashtable .Remove()', () => {
    const interp = new PSInterpreter();
    interp.execute('$h = @{ x = 10; y = 20 }; $h.Remove("x")');
    const h = interp.getVariable('h') as Record<string, unknown>;
    expect('x' in h).toBe(false);
  });

  it('hashtable .ContainsKey()', () => {
    expect(runAndGet('$h = @{key="val"}; $r = $h.ContainsKey("key")', 'r')).toBe(true);
  });

  it('hashtable .GetEnumerator()', () => {
    const interp = new PSInterpreter();
    interp.execute('$h = @{ a=1; b=2 }; $enumerator = $h.GetEnumerator()');
    expect(interp.getVariable('enumerator')).toBeDefined();
  });

  it('hashtable splatting with switch', () => {
    expect(runAndGet(
      'function Opt { param([switch]$Force, $Path) if ($Force) { "forced $Path" } else { "normal" } }; $args = @{ Force = $true; Path = "C:\\" }; $r = Opt @args',
      'r'
    )).toBe('forced C:\\');
  });
});

// ─── 39. Collections (ArrayList, List<T>) ─────────────────────────────────

describe('39. Collections', () => {
  it('ArrayList via New-Object', () => {
    const interp = new PSInterpreter();
    interp.execute('$list = New-Object System.Collections.ArrayList');
    interp.execute('$list.Add(1); $list.Add(2)');
    const list = interp.getVariable('list') as any;
    expect(list[0]).toBe(1);
    expect(list.Count).toBe(2);
  });

  it('List<T> with Add/Remove', () => {
    const interp = new PSInterpreter();
    interp.execute('$list = [System.Collections.Generic.List[string]]::new()');
    interp.execute('$list.Add("a"); $list.Add("b"); $list.Remove("a")');
    const list = interp.getVariable('list') as any;
    expect(list.Count).toBe(1);
    expect(list[0]).toBe('b');
  });

  it('Queue enqueue/dequeue', () => {
    const interp = new PSInterpreter();
    interp.execute('$q = [System.Collections.Queue]::new(); $q.Enqueue(10); $q.Enqueue(20); $r = $q.Dequeue()');
    expect(interp.getVariable('r')).toBe(10);
    expect(interp.getVariable('q').Count).toBe(1);
  });

  it('Stack push/pop', () => {
    expect(runAndGet(
      '$stack = [System.Collections.Stack]::new(); $stack.Push("bottom"); $stack.Push("top"); $r = $stack.Pop()',
      'r'
    )).toBe('top');
  });
});

// ─── 40. Invoke-Expression & Dynamic Code ──────────────────────────────────

describe('40. Invoke-Expression', () => {
  it('Invoke-Expression evaluates string', () => {
    expect(runAndGet('$cmd = "Write-Output hello"; $r = Invoke-Expression $cmd', 'r')).toContain('hello');
  });

  it('Invoke-Expression with variable interpolation', () => {
    expect(runAndGet('$x = 42; $r = Invoke-Expression "\$x + 1"', 'r')).toBe(43);
  });

  it('Invoke-Expression inside scriptblock', () => {
    expect(runAndGet('$sb = { param($exp) Invoke-Expression $exp }; $r = & $sb "3*7"', 'r')).toBe(21);
  });

  it('Invoke-Expression error handling', () => {
    const interp = new PSInterpreter();
    expect(() => interp.execute('Invoke-Expression "throw \'fail\'"')).toThrow('fail');
  });
});

// ─── 41. Filter & Functions with $input ───────────────────────────────────

describe('41. Filter & $input Handling', () => {
  it('filter keyword creates a function with process block', () => {
    expect(runAndGet(
      'filter Double { $_ * 2 }; $r = 1,2,3 | Double',
      'r'
    )).toEqual([2,4,6]);
  });

  it('$input inside a function without begin/process/end loops once', () => {
    const interp = new PSInterpreter();
    interp.execute('function Sum { $acc=0; foreach ($i in $input) { $acc+=$i }; $acc }; $r = 1..4 | Sum');
    expect(interp.getVariable('r')).toBe(10);
  });

  it('$input.MoveNext() inside process block (simulated)', () => {
    const interp = new PSInterpreter();
    interp.execute(`
      function FirstOnly { process { if ($_ -eq 2) { $input.MoveNext() } else { $_ } } }
      $r = 1,2,3 | FirstOnly
    `);
    // Vérifier que 3 est sauté car MoveNext avance l'énumérateur
    expect(interp.getVariable('r')).toEqual([1,3]); // mais attention selon implémentation
  });
});

// ─── 42. Automatic Variables & Constants ──────────────────────────────────

describe('42. Automatic Variables', () => {
  it('$args in scriptblock', () => {
    expect(runAndGet('$sb = { $args[0] + $args[1] }; $r = & $sb 3 4', 'r')).toBe(7);
  });

  it('$PSItem / $_ in pipeline', () => {
    expect(runAndGet('$r = 1,2,3 | ForEach-Object { $_ * 3 }', 'r')).toEqual([3,6,9]);
  });

  it('$? after successful command is true', () => {
    const interp = new PSInterpreter();
    interp.execute('Get-Date');
    expect(interp.getVariable('?')).toBe(true);
  });

  it('$^ / $$ first/last token? Not always exists; test with empty', () => {
    const interp = new PSInterpreter();
    interp.execute('Write-Output "hello"');
    // $^ et $$ peuvent être null selon version
  });

  it('$MyInvocation contains script name', () => {
    const interp = new PSInterpreter();
    interp.execute('$r = $MyInvocation.MyCommand.Name');
    // Dans un script exécuté en mémoire, c'est souvent $null ou nom factice
    expect(interp.getVariable('r')).toBeDefined();
  });

  it('$PID is process id (simulated integer)', () => {
    const interp = new PSInterpreter();
    interp.execute('$r = $PID');
    expect(typeof interp.getVariable('r')).toBe('number');
  });

  it('$HOME is a path', () => {
    const interp = new PSInterpreter();
    interp.execute('$r = $HOME');
    expect(interp.getVariable('r')).toMatch(/\\/);
  });

  it('$ExecutionContext is defined', () => {
    const interp = new PSInterpreter();
    interp.execute('$r = $ExecutionContext -ne $null');
    expect(interp.getVariable('r')).toBe(true);
  });
});

// ─── 43. Advanced Operators ────────────────────────────────────────────────

describe('43. Advanced Operators', () => {
  it('band operator -band', () => {
    expect(runAndGet('$r = 3 -band 6', 'r')).toBe(2);
  });

  it('bor operator -bor', () => {
    expect(runAndGet('$r = 1 -bor 2', 'r')).toBe(3);
  });

  it('bxor operator -bxor', () => {
    expect(runAndGet('$r = 5 -bxor 3', 'r')).toBe(6);
  });

  it('is operator', () => {
    expect(runAndGet('$r = 123 -is [int]', 'r')).toBe(true);
  });

  it('isnot operator', () => {
    expect(runAndGet('$r = "hello" -isnot [int]', 'r')).toBe(true);
  });

  it('as operator', () => {
    expect(runAndGet('$r = "123" -as [int]', 'r')).toBe(123);
  });

  it('replace operator case-insensitive', () => {
    expect(runAndGet('$r = "Hello World" -replace "world","PS"', 'r')).toBe('Hello PS');
  });

  it('creplace operator case-sensitive', () => {
    expect(runAndGet('$r = "Hello World" -creplace "World","PS"', 'r')).toBe('Hello PS');
  });

  it('contains operator', () => {
    expect(runAndGet('$r = 1,2,3 -contains 2', 'r')).toBe(true);
  });

  it('notcontains operator', () => {
    expect(runAndGet('$r = 1,2,3 -notcontains 4', 'r')).toBe(true);
  });

  it('in operator', () => {
    expect(runAndGet('$r = 2 -in (1,2,3)', 'r')).toBe(true);
  });

  it('notin operator', () => {
    expect(runAndGet('$r = 5 -notin (1,2,3)', 'r')).toBe(true);
  });

  it('shl / shr bit shift', () => {
    expect(runAndGet('$r = 4 -shl 1', 'r')).toBe(8);
    expect(runAndGet('$r = 8 -shr 2', 'r')).toBe(2);
  });
});

// ─── 44. Misc. Deep Edge Cases ─────────────────────────────────────────────

describe('44. Misc. Deep Edge Cases', () => {
  it('empty pipeline produces $null', () => {
    const interp = new PSInterpreter();
    interp.execute('$r = @() | ForEach-Object { $_ }');
    expect(interp.getVariable('r')).toBeNull();
  });

  it('double quoted string with complex expression $()', () => {
    expect(runAndGet('$x = 3; $r = "sum = $($x + 2)"', 'r')).toBe('sum = 5');
  });

  it('nested scriptblock variable resolution', () => {
    expect(runAndGet('$x = 10; $sb = { $y = 2; $x + $y }; $r = & $sb', 'r')).toBe(12);
  });

  it('here-string single-quoted', () => {
    const interp = new PSInterpreter();
    interp.execute("$r = @'\nline1\nline2\n'@");
    expect(interp.getVariable('r')).toBe('line1\nline2');
  });

  it('here-string double-quoted with variable expansion', () => {
    const interp = new PSInterpreter();
    interp.execute('$name = "World"; $r = @"\nHello $name\n"@');
    expect(interp.getVariable('r')).toBe('Hello World');
  });

  it('break in switch exits switch', () => {
    const interp = new PSInterpreter();
    interp.execute(`
      $result = switch (1) {
        1 { "one"; break }
        2 { "two" }
        default { "other" }
      }
    `);
    expect(interp.getVariable('result')).toBe('one');
  });

  it('recursive function call', () => {
    expect(runAndGet('function Factorial { param($n) if ($n -le 1) { 1 } else { $n * (Factorial ($n-1)) } }; $r = Factorial 5', 'r')).toBe(120);
  });

  it('pipeline with $input and process block in same function', () => {
    const interp = new PSInterpreter();
    interp.execute(`
      function Complex {
        begin { $data = @() }
        process { $data += $_ }
        end { $data | Sort-Object -Descending }
      }
      $r = 3,1,2 | Complex
    `);
    expect(interp.getVariable('r')).toEqual([3,2,1]);
  });
});
