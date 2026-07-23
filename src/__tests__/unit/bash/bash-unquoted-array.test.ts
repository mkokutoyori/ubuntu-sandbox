/**
 * bash — unquoted array expansions (audit 05, constat A1).
 *
 * Real bash expands `${arr[n]}`, `${arr[@]}` and `${arr[*]}` identically
 * whether or not the reference sits inside double quotes (modulo word
 * splitting). The quoted path has always worked here; every test below
 * mirrors a quoted fixture with its unquoted twin so the two parser
 * paths (BashParser.parseBracedVar vs expandInlineVars) can never
 * silently diverge again.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

let exec: LinuxCommandExecutor;
beforeEach(() => {
  exec = new LinuxCommandExecutor(false);
  exec.userMgr.currentUser = 'root';
  exec.userMgr.currentUid = 0;
  exec.userMgr.currentGid = 0;
});

function run(cmd: string): string { return exec.execute(cmd); }
function runScript(body: string): string {
  const path = '/tmp/__test_unquoted_array.sh';
  exec.vfs.writeFile(path, body, 0, 0, 0o022);
  const inode = exec.vfs.resolveInode(path);
  if (inode) inode.permissions = 0o755;
  return run(`bash ${path}`);
}

describe('unquoted indexed access ${arr[n]}', () => {
  it('reads a single element by index — quoted and unquoted agree', () => {
    expect(runScript('arr=(a b c); echo "${arr[1]}"').trim()).toBe('b');
    expect(runScript('arr=(a b c); echo ${arr[1]}').trim()).toBe('b');
  });

  it('reads element 0 unquoted', () => {
    expect(runScript('arr=(alpha beta); echo ${arr[0]}').trim()).toBe('alpha');
  });

  it('reads a negative index unquoted', () => {
    expect(runScript('arr=(a b c); echo ${arr[-1]}').trim()).toBe('c');
  });

  it('resolves a variable subscript unquoted', () => {
    expect(runScript('arr=(x y z); i=2; echo ${arr[$i]}').trim()).toBe('z');
  });

  it('resolves an arithmetic subscript unquoted', () => {
    expect(runScript('arr=(x y z); i=1; echo ${arr[i+1]}').trim()).toBe('z');
  });
});

describe('unquoted whole-array access ${arr[@]} / ${arr[*]}', () => {
  it('expands all elements after += — quoted and unquoted agree', () => {
    expect(runScript('arr=(a b); arr+=(c d); echo "${arr[@]}"').trim()).toBe('a b c d');
    expect(runScript('arr=(a b); arr+=(c d); echo ${arr[@]}').trim()).toBe('a b c d');
  });

  it('expands ${arr[*]} unquoted', () => {
    expect(runScript('arr=(a b c); echo ${arr[*]}').trim()).toBe('a b c');
  });

  it('word-splits ${arr[@]} into one argument per element', () => {
    const out = runScript('arr=(one two three); printf "%s\\n" ${arr[@]}');
    expect(out.trim().split('\n').map(s => s.trim())).toEqual(['one', 'two', 'three']);
  });

  it('iterates a for-loop over ${arr[@]} unquoted', () => {
    const out = runScript('arr=(r1 r2 r3); for x in ${arr[@]}; do echo "got:$x"; done');
    expect(out.trim().split('\n').map(s => s.trim())).toEqual(['got:r1', 'got:r2', 'got:r3']);
  });
});

describe('unquoted access with trailing modifiers', () => {
  it('slices ${arr[@]:offset:len} unquoted', () => {
    expect(runScript('arr=(a b c d e); echo ${arr[@]:1:2}').trim()).toBe('b c');
  });

  it('applies a default when the element is unset: ${arr[9]:-fallback}', () => {
    expect(runScript('arr=(a); echo ${arr[9]:-fallback}').trim()).toBe('fallback');
  });
});

describe('unquoted associative array access ${map[k]}', () => {
  it('reads a value by key — quoted and unquoted agree', () => {
    expect(runScript('declare -A map; map[fr]=bonjour; echo "${map[fr]}"').trim()).toBe('bonjour');
    expect(runScript('declare -A map; map[fr]=bonjour; echo ${map[fr]}').trim()).toBe('bonjour');
  });
});

describe('regression guards for already-working forms', () => {
  it('${#arr[@]} keeps working unquoted', () => {
    expect(runScript('arr=(a b c); echo ${#arr[@]}').trim()).toBe('3');
  });

  it('plain ${var} expansion is unaffected', () => {
    expect(runScript('v=hello; echo ${v}').trim()).toBe('hello');
  });

  it('${var:-default} is unaffected', () => {
    expect(runScript('echo ${unset_var:-dflt}').trim()).toBe('dflt');
  });

  it('pattern ops ${v#prefix} are unaffected', () => {
    expect(runScript('v=foobar; echo ${v#foo}').trim()).toBe('bar');
  });
});
