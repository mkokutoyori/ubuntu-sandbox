/**
 * `return` inside an inner block (if/while/try) must propagate up to the
 * enclosing function or scriptblock, NOT just exit the inner block.
 *
 * Bug from debug-output/ps-pipelines_results_debug.txt:
 *
 *     PS> 1..3 | ForEach-Object { if ($_ -eq 2) { return }; $_ }
 *       1
 *       2     ← wrong, the `return` should have skipped this
 *       3
 *
 * Root cause: execScriptBlock caught ReturnSignal at every nested block,
 * so `return` inside `if { ... }` only exited the if-body. Moved the catch
 * to invokeScriptBlock (the actual call boundary).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

let interp: PSInterpreter;
beforeEach(() => { interp = new PSInterpreter(); });

describe('return propagation', () => {
  it('return inside if-body skips the rest of the enclosing scriptblock', () => {
    const out = interp.executeInteractive(
      '1..3 | ForEach-Object { if ($_ -eq 2) { return }; $_ }',
    );
    const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
    expect(lines).toEqual(['1', '3']);
  });

  it('return inside if-body exits the enclosing function', () => {
    const out = interp.executeInteractive(
      'function Test-Return { if ($true) { return 42 }; 99 }; Test-Return',
    );
    expect(out.trim()).toBe('42');
  });

  it('return inside while-body exits the enclosing function', () => {
    const out = interp.executeInteractive(
      'function First-Match { $i = 0; while ($i -lt 10) { if ($i -eq 3) { return $i }; $i++ } }; First-Match',
    );
    expect(out.trim()).toBe('3');
  });
});
