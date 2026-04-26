/**
 * Category: Control flow & scripting constructs
 *
 * Probes if/elseif/else, switch, for, foreach, while, do-while,
 * functions, return values, try/catch, break, continue.
 */

import type { DiagnosticCase } from '../types';
import { assert } from '../engine';

export const controlFlowChecks: DiagnosticCase[] = [

  // ─── if / else ───────────────────────────────────────────────────
  {
    id: 'CF-001', category: 'Control Flow',
    description: 'if ($true) { "yes" } outputs "yes"',
    cmd: 'if ($true) { "yes" }',
    assert: assert.exact('yes'),
    severity: 'FAIL',
  },
  {
    id: 'CF-002', category: 'Control Flow',
    description: 'if ($false) { "yes" } else { "no" } outputs "no"',
    cmd: 'if ($false) { "yes" } else { "no" }',
    assert: assert.exact('no'),
    severity: 'FAIL',
  },
  {
    id: 'CF-003', category: 'Control Flow',
    description: 'elseif branch executes correctly',
    cmd: '$x = 2; if ($x -eq 1) { "one" } elseif ($x -eq 2) { "two" } else { "other" }',
    assert: assert.exact('two'),
    severity: 'FAIL',
  },
  {
    id: 'CF-004', category: 'Control Flow',
    description: 'Nested if works correctly',
    cmd: '$a = $true; $b = $true; if ($a) { if ($b) { "both" } }',
    assert: assert.exact('both'),
    severity: 'WARN',
  },

  // ─── switch ──────────────────────────────────────────────────────
  {
    id: 'CF-005', category: 'Control Flow',
    description: 'switch matches a string value',
    cmd: 'switch ("b") { "a" { "got a" } "b" { "got b" } default { "other" } }',
    assert: assert.exact('got b'),
    severity: 'WARN',
    psNote: 'Real PS: switch is case-insensitive by default',
  },
  {
    id: 'CF-006', category: 'Control Flow',
    description: 'switch default branch fires when nothing matches',
    cmd: 'switch ("z") { "a" { "got a" } default { "no match" } }',
    assert: assert.exact('no match'),
    severity: 'WARN',
  },

  // ─── for loop ────────────────────────────────────────────────────
  {
    id: 'CF-007', category: 'Control Flow',
    description: 'for loop iterates correct number of times',
    cmd: '$sum = 0; for ($i = 1; $i -le 3; $i++) { $sum += $i }; $sum',
    assert: assert.exact('6'),
    severity: 'FAIL',
  },
  {
    id: 'CF-008', category: 'Control Flow',
    description: 'for loop with break exits early',
    cmd: '$r = ""; for ($i = 0; $i -lt 5; $i++) { if ($i -eq 3) { break }; $r += $i }; $r',
    assert: assert.exact('012'),
    severity: 'WARN',
  },

  // ─── foreach loop ────────────────────────────────────────────────
  {
    id: 'CF-009', category: 'Control Flow',
    description: 'foreach iterates over an array',
    cmd: '$out = ""; foreach ($item in 1,2,3) { $out += $item }; $out',
    assert: assert.exact('123'),
    severity: 'FAIL',
  },
  {
    id: 'CF-010', category: 'Control Flow',
    description: 'foreach with continue skips an iteration',
    cmd: '$out = ""; foreach ($n in 1,2,3,4) { if ($n -eq 2) { continue }; $out += $n }; $out',
    assert: assert.exact('134'),
    severity: 'WARN',
  },

  // ─── while loop ──────────────────────────────────────────────────
  {
    id: 'CF-011', category: 'Control Flow',
    description: 'while loop executes until condition is false',
    cmd: '$i = 0; $s = ""; while ($i -lt 3) { $s += $i; $i++ }; $s',
    assert: assert.exact('012'),
    severity: 'FAIL',
  },
  {
    id: 'CF-012', category: 'Control Flow',
    description: 'do-while executes at least once',
    cmd: '$n = 5; do { $n-- } while ($n -gt 0); $n',
    assert: assert.exact('0'),
    severity: 'WARN',
  },

  // ─── Functions ───────────────────────────────────────────────────
  {
    id: 'CF-013', category: 'Control Flow',
    description: 'function definition and call returns value',
    cmd: 'function Add($a,$b) { $a + $b }; Add 3 4',
    assert: assert.exact('7'),
    severity: 'FAIL',
  },
  {
    id: 'CF-014', category: 'Control Flow',
    description: 'function with return keyword',
    cmd: 'function Double($n) { return $n * 2 }; Double 5',
    assert: assert.exact('10'),
    severity: 'WARN',
  },
  {
    id: 'CF-015', category: 'Control Flow',
    description: 'function with param block',
    cmd: 'function Greet { param($Name) "Hello $Name" }; Greet -Name "Alice"',
    assert: assert.contains('Hello Alice'),
    severity: 'WARN',
  },
  {
    id: 'CF-016', category: 'Control Flow',
    description: 'Recursive function computes factorial',
    cmd: 'function Fact($n) { if ($n -le 1) { return 1 }; return $n * (Fact ($n-1)) }; Fact 5',
    assert: assert.exact('120'),
    severity: 'WARN',
  },

  // ─── try / catch ─────────────────────────────────────────────────
  {
    id: 'CF-017', category: 'Control Flow',
    description: 'try/catch catches an exception',
    cmd: 'try { throw "boom" } catch { "caught: $_" }',
    assert: assert.contains('caught'),
    severity: 'WARN',
    psNote: 'Real PS: $_ in catch block contains the ErrorRecord',
  },
  {
    id: 'CF-018', category: 'Control Flow',
    description: 'try/finally always runs finally block',
    cmd: 'try { "try" } finally { "finally" }',
    assert: assert.all(assert.contains('try'), assert.contains('finally')),
    severity: 'WARN',
  },

  // ─── Arrays ──────────────────────────────────────────────────────
  {
    id: 'CF-019', category: 'Control Flow',
    description: 'Array literal @(1,2,3) has Count 3',
    cmd: '@(1,2,3).Count',
    assert: assert.exact('3'),
    severity: 'FAIL',
  },
  {
    id: 'CF-020', category: 'Control Flow',
    description: 'Array index access $arr[0]',
    cmd: '$a = @("x","y","z"); $a[1]',
    assert: assert.exact('y'),
    severity: 'FAIL',
  },
  {
    id: 'CF-021', category: 'Control Flow',
    description: 'Array negative index $arr[-1] returns last element',
    cmd: '$a = @("x","y","z"); $a[-1]',
    assert: assert.exact('z'),
    severity: 'WARN',
    psNote: 'Real PS: negative index counts from the end',
  },
  {
    id: 'CF-022', category: 'Control Flow',
    description: 'Array concatenation with +',
    cmd: '(@(1,2) + @(3,4)).Count',
    assert: assert.exact('4'),
    severity: 'WARN',
  },

  // ─── Hashtable ───────────────────────────────────────────────────
  {
    id: 'CF-023', category: 'Control Flow',
    description: 'Hashtable @{} literal with key access',
    cmd: '$h = @{ Name = "Alice"; Age = 30 }; $h.Name',
    assert: assert.exact('Alice'),
    severity: 'WARN',
  },
  {
    id: 'CF-024', category: 'Control Flow',
    description: 'Hashtable .Keys returns key collection',
    cmd: '$h = @{ A=1; B=2 }; $h.Keys.Count',
    assert: assert.exact('2'),
    severity: 'WARN',
  },
];
