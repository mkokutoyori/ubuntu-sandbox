/**
 * bash — second-wave advanced-feature spec.
 *
 * Covers the bash constructs that real-world scripts use heavily but
 * the interpreter did not yet implement: `[[ … ]]` extended test
 * (with `=~`, glob match, &&/||), C-style `for ((i; c; i++))` loops,
 * brace expansion (`{a,b,c}`, `pre{x,y}post`), the standalone
 * `((expr))` arithmetic command, ANSI-C `$'…'` quoting, and the
 * `getopts` builtin.
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
async function run(cmd: string): Promise<string> { return await exec.execute(cmd); }
async function runScript(body: string): Promise<string> {
  exec.vfs.writeFile('/tmp/__test.sh', body, 0, 0, 0o022);
  const i = exec.vfs.resolveInode('/tmp/__test.sh');
  if (i) i.permissions = 0o755;
  return await run('bash /tmp/__test.sh');
}

// ─── [[ … ]] extended test ─────────────────────────────────────────────
describe('[[ … ]] extended test', () => {
  it('J1 string equality with `=` and `!=`', async () => {
    expect(await run('[[ "abc" = "abc" ]] && echo Y')).toBe('Y');
    expect(await run('[[ "abc" != "xyz" ]] && echo Y')).toBe('Y');
  });
  it('J2 lexical ordering with `<` / `>`', async () => {
    expect(await run('[[ "alpha" < "beta" ]] && echo LT')).toBe('LT');
    expect(await run('[[ "z" > "a" ]] && echo GT')).toBe('GT');
  });
  it('J3 integer comparison via -eq/-lt/-gt', async () => {
    expect(await run('[[ 5 -gt 3 ]] && echo OK')).toBe('OK');
    expect(await run('[[ 5 -lt 3 ]] || echo NO')).toBe('NO');
  });
  it('J4 glob match via `==`', async () => {
    expect(await run('[[ "foo.txt" == *.txt ]] && echo MATCH')).toBe('MATCH');
    expect(await run('[[ "foo.txt" == *.log ]] || echo NOMATCH')).toBe('NOMATCH');
  });
  it('J5 regex match via `=~`', async () => {
    expect(await run('[[ "abc123" =~ ^[a-z]+[0-9]+$ ]] && echo R')).toBe('R');
    expect(await run('[[ "abc" =~ [0-9] ]] || echo NR')).toBe('NR');
  });
  it('J6 file tests work inside [[ ]]', async () => {
    exec.vfs.writeFile('/tmp/x', '', 0, 0, 0o022);
    expect(await run('[[ -e /tmp/x ]] && echo E')).toBe('E');
    expect(await run('[[ -d /tmp ]] && echo D')).toBe('D');
  });
  it('J7 logical && and || inside [[ ]]', async () => {
    expect(await run('[[ 1 -lt 2 && 3 -gt 1 ]] && echo BOTH')).toBe('BOTH');
    expect(await run('[[ 1 -lt 0 || 5 -gt 1 ]] && echo EITHER')).toBe('EITHER');
  });
  it('J8 negation `!`', async () => {
    expect(await run('[[ ! 1 -eq 2 ]] && echo NEG')).toBe('NEG');
  });
  it('J9 no word-splitting on unquoted vars (the [[ ]] guarantee)', async () => {
    const out = await runScript(`
      v="a b"
      if [[ $v = "a b" ]]; then echo OK; fi
    `);
    expect(out).toContain('OK');
  });
});

// ─── C-style for loops ─────────────────────────────────────────────────
describe('for ((init; cond; incr))', () => {
  it('K1 basic counter', async () => {
    expect(await run('for ((i=0; i<3; i++)); do echo $i; done')).toBe('0\n1\n2');
  });
  it('K2 decrement', async () => {
    expect(await run('for ((i=3; i>0; i--)); do echo $i; done')).toBe('3\n2\n1');
  });
  it('K3 custom step', async () => {
    expect(await run('for ((i=0; i<=10; i+=2)); do echo $i; done')).toBe('0\n2\n4\n6\n8\n10');
  });
  it('K4 break inside the loop', async () => {
    expect(await run('for ((i=0; i<10; i++)); do [[ $i -ge 3 ]] && break; echo $i; done')).toBe('0\n1\n2');
  });
  it('K5 empty init / cond / incr ⇒ default behaviour (treated as truthy)', async () => {
    const out = await runScript(`
      i=0
      for ((; i<3; )); do
        echo $i
        i=$((i+1))
      done
    `);
    expect(out).toContain('0');
    expect(out).toContain('2');
  });
});

// ─── Brace expansion ───────────────────────────────────────────────────
describe('brace expansion', () => {
  it('L1 comma list', async () => {
    expect(await run('echo {a,b,c}')).toBe('a b c');
  });
  it('L2 prefix and suffix surround a list', async () => {
    expect(await run('echo pre{x,y,z}post')).toBe('prexpost preypost prezpost');
  });
  it('L3 numeric range still works', async () => {
    expect(await run('echo {1..5}')).toBe('1 2 3 4 5');
  });
  it('L4 step in a range', async () => {
    expect(await run('echo {0..10..2}')).toBe('0 2 4 6 8 10');
  });
  it('L5 brace expansion in arg list — mkdir creates each directory', async () => {
    await run('mkdir -p /opt/{bin,lib,etc}');
    expect(exec.vfs.exists('/opt/bin')).toBe(true);
    expect(exec.vfs.exists('/opt/lib')).toBe(true);
    expect(exec.vfs.exists('/opt/etc')).toBe(true);
  });
  it('L6 single-element brace stays literal', async () => {
    expect(await run('echo {only}')).toBe('{only}');
  });
});

// ─── ((expr)) arithmetic command ───────────────────────────────────────
describe('((expr)) arithmetic command', () => {
  it('M1 sets a variable, exit 0 when result ≠ 0', async () => {
    expect(await run('((x = 2 + 3)); echo $x')).toBe('5');
  });
  it('M2 exit 1 when result is 0', async () => {
    expect(await run('((0)); echo $?')).toBe('1');
  });
  it('M3 exit 0 when result is non-zero', async () => {
    expect(await run('((1+1)); echo $?')).toBe('0');
  });
  it('M4 acts as a guard in if / while', async () => {
    expect(await run('if ((5 > 3)); then echo YES; fi')).toBe('YES');
  });
  it('M5 increment in a loop body', async () => {
    const out = await runScript(`
      n=0
      for x in a b c d; do ((n++)); done
      echo "$n"
    `);
    expect(out).toContain('4');
  });
});

// ─── ANSI-C $'…' quoting ───────────────────────────────────────────────
describe("ANSI-C $'…' quoting", () => {
  it("N1 \\n becomes a real newline", async () => {
    expect(await run("echo $'a\\nb'")).toBe('a\nb');
  });
  it("N2 \\t becomes a tab", async () => {
    expect(await run("echo $'x\\ty'")).toBe('x\ty');
  });
  it("N3 \\xNN hex escape", async () => {
    expect(await run("echo $'\\x41\\x42'")).toBe('AB');
  });
  it("N4 \\\\ literal backslash", async () => {
    expect(await run("echo $'a\\\\b'")).toBe('a\\b');
  });
  it("N5 ANSI-C body is NOT subject to parameter expansion", async () => {
    expect(await run("FOO=bar; echo $'$FOO'")).toBe('$FOO');
  });
});

// ─── getopts builtin ───────────────────────────────────────────────────
describe('getopts', () => {
  it('O1 collects flags into $opt across iterations', async () => {
    const out = await runScript(`
      while getopts ":hv" opt; do
        case "$opt" in
          h) echo HELP ;;
          v) echo VERSION ;;
        esac
      done
    `);
    // No args ⇒ loop body never await runs.
    expect(out).toBe('');
  });
  it('O2 handles `-h -v` flag sequence', async () => {
    exec.vfs.writeFile('/tmp/o.sh', `
while getopts ":hvf:" opt; do
  case "$opt" in
    h) echo HELP ;;
    v) echo VERSION ;;
    f) echo "FILE=$OPTARG" ;;
  esac
done
`, 0, 0, 0o022);
    const i = exec.vfs.resolveInode('/tmp/o.sh'); if (i) i.permissions = 0o755;
    const out = await run('bash /tmp/o.sh -h -v -f conf.yaml');
    expect(out).toContain('HELP');
    expect(out).toContain('VERSION');
    expect(out).toContain('FILE=conf.yaml');
  });
  it('O3 stops at the first non-option argument', async () => {
    exec.vfs.writeFile('/tmp/o2.sh', `
while getopts ":v" opt; do
  case "$opt" in v) echo V ;; esac
done
shift $((OPTIND - 1))
echo "rest=$*"
`, 0, 0, 0o022);
    const i = exec.vfs.resolveInode('/tmp/o2.sh'); if (i) i.permissions = 0o755;
    expect(await run('bash /tmp/o2.sh -v target1 target2')).toContain('rest=target1 target2');
  });
});
