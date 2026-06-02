/**
 * bash — third-wave enhancements.
 *
 * Covers associative arrays (`declare -A`), the `mapfile`/`readarray`
 * builtin, `read -a` array-binding, `trap EXIT` cleanup handlers,
 * and tilde expansion (`~`, `~/`, `~user`).
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
  exec.vfs.writeFile('/tmp/__t.sh', body, 0, 0, 0o022);
  const i = exec.vfs.resolveInode('/tmp/__t.sh');
  if (i) i.permissions = 0o755;
  return run('bash /tmp/__t.sh');
}

// ─── §P — Associative arrays (declare -A) ──────────────────────────────
describe('P. associative arrays', () => {
  it('P1 declare -A then assign and read by string key', () => {
    const out = runScript(`
      declare -A colours
      colours[apple]=red
      colours[grass]=green
      colours[sky]=blue
      echo "\${colours[apple]}"
      echo "\${colours[grass]}"
      echo "\${colours[sky]}"
    `);
    expect(out).toContain('red');
    expect(out).toContain('green');
    expect(out).toContain('blue');
  });
  it('P2 list literal: declare -A m=([k1]=v1 [k2]=v2)', () => {
    const out = runScript(`
      declare -A m=([alpha]=1 [bravo]=2 [charlie]=3)
      echo "\${m[bravo]}"
    `);
    expect(out.trim()).toBe('2');
  });
  it('P3 ${#map[@]} counts keys; ${!map[@]} lists them', () => {
    const out = runScript(`
      declare -A m
      m[a]=1; m[b]=2; m[c]=3
      echo "size=\${#m[@]}"
      keys=$(echo "\${!m[@]}" | tr ' ' '\\n' | sort | tr '\\n' ' ')
      echo "keys=$keys"
    `);
    expect(out).toContain('size=3');
    expect(out).toMatch(/keys=a b c\s*/);
  });
  it('P4 iterate values with for x in "${m[@]}"', () => {
    const out = runScript(`
      declare -A m=([x]=10 [y]=20)
      total=0
      for v in "\${m[@]}"; do
        total=$((total + v))
      done
      echo "total=$total"
    `);
    expect(out).toContain('total=30');
  });
  it('P5 unset removes a single key', () => {
    const out = runScript(`
      declare -A m=([a]=1 [b]=2)
      unset m[a]
      echo "size=\${#m[@]}"
      echo "a=\${m[a]:-absent}"
      echo "b=\${m[b]}"
    `);
    expect(out).toContain('size=1');
    expect(out).toContain('a=absent');
    expect(out).toContain('b=2');
  });
  it('P6 missing key expands to empty (and bypasses set -u via :-)', () => {
    expect(run('declare -A m; m[a]=1; echo "[${m[nope]}]"')).toBe('[]');
    expect(run('declare -A m; echo "${m[x]:-default}"')).toBe('default');
  });
});

// ─── §Q — mapfile / readarray ──────────────────────────────────────────
describe('Q. mapfile / readarray', () => {
  beforeEach(() => {
    exec.vfs.writeFile('/data/lines.txt', 'alpha\nbravo\ncharlie\n', 0, 0, 0o022);
  });

  it('Q1 reads every line into an array', () => {
    const out = runScript(`
      mapfile -t arr < /data/lines.txt
      echo "count=\${#arr[@]}"
      echo "first=\${arr[0]}"
      echo "last=\${arr[-1]}"
    `);
    expect(out).toContain('count=3');
    expect(out).toContain('first=alpha');
    expect(out).toContain('last=charlie');
  });
  it('Q2 `readarray` is an alias of mapfile', () => {
    const out = runScript(`
      readarray -t lines < /data/lines.txt
      for l in "\${lines[@]}"; do echo "[$l]"; done
    `);
    expect(out).toContain('[alpha]');
    expect(out).toContain('[bravo]');
    expect(out).toContain('[charlie]');
  });
  it('Q3 default (no -t) keeps the trailing newlines on each element', () => {
    const out = runScript(`
      mapfile arr < /data/lines.txt
      echo "len=\${#arr[0]}"
    `);
    // "alpha\n" → 6 chars
    expect(out).toContain('len=6');
  });
  it('Q4 -n LIMIT caps the number of lines read', () => {
    const out = runScript(`
      mapfile -t -n 2 arr < /data/lines.txt
      echo "count=\${#arr[@]}"
      echo "\${arr[1]}"
    `);
    expect(out).toContain('count=2');
    expect(out).toContain('bravo');
  });
});

// ─── §R — read -a / -d ─────────────────────────────────────────────────
describe('R. read array & delimiter', () => {
  it('R1 read -a splits a line into an array on IFS', () => {
    const out = runScript(`
      read -ra arr <<< "alpha bravo charlie"
      echo "count=\${#arr[@]}"
      echo "\${arr[1]}"
    `);
    expect(out).toContain('count=3');
    expect(out).toContain('bravo');
  });
  it('R2 read -d "" reads until NUL or EOF', () => {
    const out = runScript(`
      read -d "" multi <<< "first
second
third"
      echo "[$multi]"
    `);
    expect(out).toContain('first');
    expect(out).toContain('third');
  });
});

// ─── §S — trap EXIT cleanup ────────────────────────────────────────────
describe('S. trap EXIT', () => {
  it('S1 EXIT handler runs once at end-of-script', () => {
    const out = runScript(`
      trap 'echo "cleaning up"' EXIT
      echo "working"
    `);
    expect(out).toContain('working');
    expect(out).toContain('cleaning up');
  });
  it('S2 trap handler still runs after an explicit `exit`', () => {
    const out = runScript(`
      trap 'echo BYE' EXIT
      echo HI
      exit 0
      echo unreachable
    `);
    expect(out).toContain('HI');
    expect(out).toContain('BYE');
    expect(out).not.toContain('unreachable');
  });
  it('S3 trap can read variables defined before it', () => {
    const out = runScript(`
      TMP=/tmp/work-$$
      trap 'echo "would remove $TMP"' EXIT
      echo "tmp=$TMP"
    `);
    expect(out).toMatch(/tmp=\/tmp\/work-\d+/);
    expect(out).toMatch(/would remove \/tmp\/work-\d+/);
  });
  it('S4 trap - EXIT clears the handler', () => {
    const out = runScript(`
      trap 'echo OLD' EXIT
      trap - EXIT
      echo END
    `);
    expect(out).toContain('END');
    expect(out).not.toContain('OLD');
  });
});

// ─── §T — Tilde expansion ──────────────────────────────────────────────
describe('T. tilde expansion', () => {
  it('T1 bare `~` expands to $HOME', () => {
    expect(run('echo ~').trim()).toBe('/root');
  });
  it('T2 `~/path` joins with $HOME', () => {
    expect(run('echo ~/docs').trim()).toBe('/root/docs');
  });
  it('T3 `~user` expands to that user\'s home', () => {
    exec.execute('useradd -m alice');
    expect(run('echo ~alice').trim()).toBe('/home/alice');
  });
  it('T4 tilde is NOT expanded when quoted', () => {
    expect(run('echo "~"')).toBe('~');
    expect(run("echo '~'")).toBe('~');
  });
  it('T5 tilde is expanded in variable assignment values', () => {
    expect(run('p=~/bin; echo "$p"')).toBe('/root/bin');
  });
  it('T6 tilde works in script paths — `cd ~` and `pwd`', () => {
    const out = runScript(`
      cd ~
      pwd
    `);
    expect(out).toContain('/root');
  });
});
