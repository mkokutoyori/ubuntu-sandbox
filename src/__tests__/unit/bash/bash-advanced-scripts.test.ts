/**
 * bash — advanced script behaviour spec.
 *
 * Each test drives a non-trivial script through the real
 * `LinuxCommandExecutor`, so the lexer/parser/interpreter, the VFS,
 * the user manager and every dispatched coreutil are exercised exactly
 * as a logged-in user would. Most scripts mutate state (create files,
 * rewrite configs, edit /etc, append to logs); we assert both the
 * script output AND the resulting filesystem/environment state.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

let exec: LinuxCommandExecutor;
beforeEach(() => {
  exec = new LinuxCommandExecutor(false);
  // Run as root so stateful admin commands (useradd, /etc writes, etc.)
  // succeed end-to-end as they would in a sysadmin script context.
  exec.userMgr.currentUser = 'root';
  exec.userMgr.currentUid = 0;
  exec.userMgr.currentGid = 0;
});

async function run(cmd: string): Promise<string> { return await exec.execute(cmd); }
/** Run a multi-line script the way real bash sees it (newline-separated). */
async function runScript(body: string): Promise<string> {
  // Use heredoc-free piping: write the script and execute it
  const path = '/tmp/__test_script.sh';
  exec.vfs.writeFile(path, body, 0, 0, 0o022);
  const inode = exec.vfs.resolveInode(path);
  if (inode) inode.permissions = 0o755;
  return await run(`bash ${path}`);
}
function read(path: string): string | null { return exec.vfs.readFile(path); }
function exists(path: string): boolean { return exec.vfs.exists(path); }

// ─── §A — Stateful FS-mutating scripts ─────────────────────────────────
describe('A. stateful FS scripts', () => {
  it('A1 deploys an app directory tree with mkdir / touch / chmod', async () => {
    const out = await runScript(`
      set -e
      mkdir -p /opt/myapp/bin /opt/myapp/etc /opt/myapp/var/log
      touch /opt/myapp/bin/run
      chmod 755 /opt/myapp/bin/run
      echo 'app=myapp' > /opt/myapp/etc/app.conf
      echo 'started' >> /opt/myapp/var/log/app.log
      echo DEPLOYED
    `);
    expect(out).toContain('DEPLOYED');
    expect(exists('/opt/myapp/bin/run')).toBe(true);
    expect(read('/opt/myapp/etc/app.conf')).toContain('app=myapp');
    expect(read('/opt/myapp/var/log/app.log')).toContain('started');
    const inode = exec.vfs.resolveInode('/opt/myapp/bin/run');
    expect(inode?.permissions).toBe(0o755);
  });

  it('A2 generates a multi-section config file via a heredoc', async () => {
    await runScript(`
      cat > /etc/nginx.conf <<'EOF'
      server {
        listen 80;
        root /var/www;
      }
      EOF
      echo OK
    `);
    const cfg = read('/etc/nginx.conf') ?? '';
    expect(cfg).toContain('listen 80');
    expect(cfg).toContain('root /var/www');
  });

  it('A2b a quoted-delimiter heredoc preserves literal backslashes verbatim (no doubling)', async () => {
    await runScript(`
      cat > /tmp/colors.sh <<'EOF'
GREEN='\\033[0;32m'
EOF
    `);
    const body = read('/tmp/colors.sh') ?? '';
    expect(body).toContain("GREEN='\\033[0;32m'");
    expect(body).not.toContain('\\\\033');
  });

  it('A2c an unquoted-delimiter heredoc still escapes \\$VAR to a literal dollar (not an empty expansion)', async () => {
    const out = await runScript(`
      cat > /tmp/ttl.txt << EOF
\\$TTL    604800
EOF
      cat /tmp/ttl.txt
    `);
    expect(out).toContain('$TTL    604800');
    const body = read('/tmp/ttl.txt') ?? '';
    expect(body).toContain('$TTL    604800');
  });

  it('A3 rotates a log file (mv current → .1, recreate empty)', async () => {
    await run('echo "old entry" > /var/log/app.log');
    await runScript(`
      LOG=/var/log/app.log
      if [ -f "$LOG" ]; then
        mv "$LOG" "$LOG.1"
        touch "$LOG"
      fi
    `);
    expect(exists('/var/log/app.log.1')).toBe(true);
    expect(read('/var/log/app.log.1')).toContain('old entry');
    expect(exists('/var/log/app.log')).toBe(true);
  });

  it('A4 batch-creates users with a for loop over a list', async () => {
    await runScript(`
      for u in alice bob carol; do
        useradd -m "$u"
      done
    `);
    for (const u of ['alice', 'bob', 'carol']) {
      expect(exec.userMgr.getUser(u)).toBeTruthy();
    }
  });

  it('A5 word counts every *.txt file using globbed iteration', async () => {
    exec.vfs.mkdirp('/data', 0o755, 0, 0);
    await run('echo "alpha beta" > /data/a.txt');
    await run('echo "gamma delta epsilon" > /data/b.txt');
    const out = await runScript(`
      total=0
      for f in /data/*.txt; do
        n=$(wc -w < "$f")
        total=$((total + n))
      done
      echo "total=$total"
    `);
    expect(out).toContain('total=5');
  });

  it('A6 conditional pipeline: only rewrites the file when grep matches', async () => {
    await run('echo "DEBUG=true" > /etc/app.env');
    await runScript(`
      if grep -q DEBUG /etc/app.env; then
        sed -i 's/DEBUG=true/DEBUG=false/' /etc/app.env
      fi
    `);
    expect(read('/etc/app.env')).toContain('DEBUG=false');
  });
});

// ─── §B — Parameter expansion (the major gap) ─────────────────────────
describe('B. parameter expansion', () => {
  it('B1 ${var#pat}  strips the shortest prefix', async () => {
    expect(await run('FILE=/etc/nginx/nginx.conf; echo "${FILE#*/}"')).toBe('etc/nginx/nginx.conf');
  });
  it('B2 ${var##pat} strips the longest prefix', async () => {
    expect(await run('FILE=/etc/nginx/nginx.conf; echo "${FILE##*/}"')).toBe('nginx.conf');
  });
  it('B3 ${var%pat}  strips the shortest suffix', async () => {
    expect(await run('F=archive.tar.gz; echo "${F%.gz}"')).toBe('archive.tar');
  });
  it('B4 ${var%%pat} strips the longest suffix', async () => {
    expect(await run('F=archive.tar.gz; echo "${F%%.*}"')).toBe('archive');
  });
  it('B5 ${var/foo/bar} replaces the first match', async () => {
    expect(await run('S=foofoo; echo "${S/foo/bar}"')).toBe('barfoo');
  });
  it('B6 ${var//foo/bar} replaces every match', async () => {
    expect(await run('S=foofoo; echo "${S//foo/bar}"')).toBe('barbar');
  });
  it('B7 ${var:offset} returns the substring from offset', async () => {
    expect(await run('S=helloworld; echo "${S:5}"')).toBe('world');
  });
  it('B8 ${var:offset:length} returns a bounded substring', async () => {
    expect(await run('S=helloworld; echo "${S:0:5}"')).toBe('hello');
  });
  it('B9 ${var^^} upper-cases and ${var,,} lower-cases', async () => {
    expect(await run('S=hello; echo "${S^^}"')).toBe('HELLO');
    expect(await run('S=HELLO; echo "${S,,}"')).toBe('hello');
  });
});

// ─── §C — Indexed arrays ──────────────────────────────────────────────
describe('C. arrays', () => {
  it('C1 declares an indexed array and accesses each element', async () => {
    expect(await run('arr=(a b c); echo "${arr[0]} ${arr[1]} ${arr[2]}"')).toBe('a b c');
  });
  it('C2 ${arr[@]} expands to every element (space-joined)', async () => {
    expect(await run('arr=(one two three); echo "${arr[@]}"')).toBe('one two three');
  });
  it('C3 ${#arr[@]} counts elements', async () => {
    expect(await run('arr=(a b c d); echo "${#arr[@]}"')).toBe('4');
  });
  it('C4 arr+=(x) appends', async () => {
    expect(await run('arr=(a b); arr+=(c d); echo "${arr[@]}"')).toBe('a b c d');
  });
  it('C5 for x in "${arr[@]}" iterates element-wise', async () => {
    const out = await runScript(`
      arr=(alpha bravo charlie)
      for x in "\${arr[@]}"; do
        echo "[$x]"
      done
    `);
    expect(out).toContain('[alpha]');
    expect(out).toContain('[bravo]');
    expect(out).toContain('[charlie]');
  });
  it('C6 ${arr[-1]} reaches the last element', async () => {
    expect(await run('arr=(a b c); echo "${arr[-1]}"')).toBe('c');
  });
  it('C7 empty array literal', async () => {
    expect(await run('arr=(); echo "${#arr[@]}"')).toBe('0');
  });
  it('C8 array element preserves spaces inside quoted item', async () => {
    const out = await runScript(`
      arr=("hello world" foo)
      echo "[\${arr[0]}]"
      echo "count=\${#arr[@]}"
    `);
    expect(out).toContain('[hello world]');
    expect(out).toContain('count=2');
  });
  it('C9 array elements survive whitespace splitting when iterated quoted', async () => {
    const out = await runScript(`
      arr=("a b" "c d")
      for x in "\${arr[@]}"; do echo "[$x]"; done
    `);
    expect(out).toContain('[a b]');
    expect(out).toContain('[c d]');
  });
  it('C10 ${arr[*]} joins on first IFS char (space by default)', async () => {
    expect(await run('arr=(x y z); echo "${arr[*]}"')).toBe('x y z');
  });
  it('C11 ${#arr[N]} returns the length of a single element', async () => {
    expect(await run('arr=(hi hello); echo "${#arr[1]}"')).toBe('5');
  });
  it('C12 round-trip: build an array from a command, iterate, sum sizes', async () => {
    exec.vfs.mkdirp('/data', 0o755, 0, 0);
    await run('echo 12345 > /data/a');
    await run('echo 67 > /data/b');
    const out = await runScript(`
      files=(/data/a /data/b)
      total=0
      for f in "\${files[@]}"; do
        n=$(wc -c < "$f")
        total=$((total + n))
      done
      echo "total=$total"
    `);
    expect(out).toContain('total=9');   // 5+1 + 2+1 newlines
  });
  it('C13 array param expansion: slice modifier on element', async () => {
    expect(await run('arr=(hello world); echo "${arr[0]:1:3}"')).toBe('ell');
  });
  it('C14 append accumulates across multiple assignments', async () => {
    const out = await runScript(`
      arr=(a)
      arr+=(b c)
      arr+=(d)
      echo "\${arr[@]}"
      echo "\${#arr[@]}"
    `);
    expect(out).toContain('a b c d');
    expect(out).toContain('4');
  });
});

// ─── §D — `set -e` enforcement ────────────────────────────────────────
describe('D. set -e', () => {
  it('D1 aborts the script on first failing command', async () => {
    const out = await runScript(`
      set -e
      echo first
      false
      echo unreachable
    `);
    expect(out).toContain('first');
    expect(out).not.toContain('unreachable');
  });

  it('D2 does NOT abort on a failing command in an `if` test', async () => {
    const out = await runScript(`
      set -e
      if false; then echo Y; else echo N; fi
      echo after
    `);
    expect(out).toContain('N');
    expect(out).toContain('after');
  });

  it('D3 does NOT abort on the LHS of `||` / RHS of `&&`', async () => {
    const out = await runScript(`
      set -e
      false || echo recovered
      true && echo ok
    `);
    expect(out).toContain('recovered');
    expect(out).toContain('ok');
  });
});

// ─── §E — `set -u` enforcement ────────────────────────────────────────
describe('E. set -u', () => {
  it('E1 expanding an unset var aborts with exit ≠ 0', async () => {
    const out = await runScript(`
      set -u
      echo "$UNSET_VAR"
      echo unreachable
    `);
    expect(out).not.toContain('unreachable');
  });
  it('E2 ${UNSET:-default} bypasses -u and yields the default', async () => {
    const out = await runScript(`
      set -u
      echo "\${MAYBE:-fallback}"
      echo END
    `);
    expect(out).toContain('fallback');
    expect(out).toContain('END');
  });
});

// ─── §F — Functions with side-effects ─────────────────────────────────
describe('F. functions', () => {
  it('F1 a function can mutate the parent environment', async () => {
    const out = await runScript(`
      mkroot() {
        ROOT=/srv/$1
        mkdir -p "$ROOT"
      }
      mkroot myapp
      [ -d /srv/myapp ] && echo OK
      echo "ROOT=$ROOT"
    `);
    expect(out).toContain('OK');
    expect(out).toContain('ROOT=/srv/myapp');
  });

  it('F2 `local` confines a variable to the function scope', async () => {
    const out = await runScript(`
      X=outer
      f() {
        local X=inner
        echo "in:$X"
      }
      f
      echo "out:$X"
    `);
    expect(out).toContain('in:inner');
    expect(out).toContain('out:outer');
  });

  it('F3 recursion: factorial via positional args', async () => {
    const out = await runScript(`
      fact() {
        if [ "$1" -le 1 ]; then echo 1; return; fi
        local p=$(fact $(( $1 - 1 )))
        echo $(( $1 * p ))
      }
      fact 5
    `);
    expect(out.trim()).toBe('120');
  });
});

// ─── §G — Real-world script: idempotent installer ─────────────────────
describe('G. real-world stateful scripts', () => {
  it('G1 idempotent "installer": creates user, dirs, config; second run is a no-op', async () => {
    const script = `
      USER=svc
      ROOT=/srv/svc
      CONF=$ROOT/etc/svc.conf

      id "$USER" >/dev/null 2>&1 || useradd -m "$USER"
      mkdir -p "$ROOT/etc" "$ROOT/var/log"

      if [ ! -f "$CONF" ]; then
        cat > "$CONF" <<EOF
      mode=production
      log=$ROOT/var/log/svc.log
      EOF
      fi
      echo OK
    `;
    expect(await runScript(script)).toContain('OK');
    expect(exec.userMgr.getUser('svc')).toBeTruthy();
    expect(read('/srv/svc/etc/svc.conf')).toContain('mode=production');

    // Re-run: must not error, must not overwrite the (manually edited) conf
    await run('sed -i s/production/staging/ /srv/svc/etc/svc.conf');
    expect(await runScript(script)).toContain('OK');
    expect(read('/srv/svc/etc/svc.conf')).toContain('mode=staging');
  });

  it('G2 backup script: tar-like copy of every *.conf under /etc into /backup', async () => {
    exec.vfs.mkdirp('/etc/svc', 0o755, 0, 0);
    await run('echo a > /etc/a.conf');
    await run('echo b > /etc/svc/b.conf');
    await runScript(`
      mkdir -p /backup
      for f in /etc/*.conf /etc/svc/*.conf; do
        [ -f "$f" ] && cp "$f" /backup/
      done
    `);
    expect(exists('/backup/a.conf')).toBe(true);
    expect(exists('/backup/b.conf')).toBe(true);
  });

  it('G3 multi-stage build: prepare → compile (touch) → install with dep checks', async () => {
    const out = await runScript(`
      set -e
      prepare() { mkdir -p /build/src; echo "int main(){return 0;}" > /build/src/main.c; }
      compile() { [ -f /build/src/main.c ] || { echo MISSING_SRC; exit 2; }; touch /build/main.o; }
      install() { [ -f /build/main.o ] || { echo MISSING_OBJ; exit 3; }; cp /build/main.o /usr/local/bin/myprog; }
      prepare && compile && install && echo INSTALLED
    `);
    expect(out).toContain('INSTALLED');
    expect(exists('/usr/local/bin/myprog')).toBe(true);
  });

  it('G4 pipeline + grep + wc: count failed auth attempts in a log', async () => {
    await run('printf "%s\\n" "ok admin" "fail bob" "ok alice" "fail carol" "fail dan" > /var/log/auth.log');
    const out = await runScript(`
      n=$(grep -c '^fail' /var/log/auth.log)
      echo "failures=$n"
    `);
    expect(out).toContain('failures=3');
  });

  it('G5 case dispatcher: switch on a sub-command', async () => {
    const make = (subcmd: string) => runScript(`
      action=${subcmd}
      case "$action" in
        start)   echo STARTING ;;
        stop)    echo STOPPING ;;
        status)  echo RUNNING ;;
        *)       echo "unknown: $action" ;;
      esac
    `);
    expect(await make('start')).toContain('STARTING');
    expect(await make('stop')).toContain('STOPPING');
    expect(await make('zzz')).toContain('unknown: zzz');
  });
});

// ─── §I — Reserved-word context-sensitivity ──────────────────────────
describe('I. reserved words outside compound context', () => {
  it('I1 `echo done` works at the top level', async () => {
    expect(await run('echo done')).toBe('done');
  });
  it('I2 `echo fi`, `echo esac`, `echo then` all parse as plain words', async () => {
    expect(await run('echo fi')).toBe('fi');
    expect(await run('echo esac')).toBe('esac');
    expect(await run('echo then')).toBe('then');
  });
  it('I3 reserved words still terminate their own compound', async () => {
    expect(await run('for x in 1 2; do echo $x; done')).toBe('1\n2');
  });
  it('I4 reserved words inside a nested loop are still treated as keywords', async () => {
    const out = await runScript(`
      for i in 1 2; do
        for j in a b; do
          echo "$i-$j"
        done
      done
    `);
    expect(out).toContain('1-a');
    expect(out).toContain('2-b');
  });
  it('I5 a script can echo a literal `done` between commands', async () => {
    const out = await runScript(`
      echo before
      echo done
      echo after
    `);
    expect(out).toContain('before');
    expect(out).toContain('done');
    expect(out).toContain('after');
  });
});

// ─── §H — Pipefail / exit-code propagation ────────────────────────────
describe('H. exit codes', () => {
  it('H1 $? captures the last command\'s exit code', async () => {
    expect(await run('false; echo $?')).toBe('1');
    expect(await run('true;  echo $?')).toBe('0');
  });
  it('H2 set -o pipefail surfaces a failing producer in a pipe', async () => {
    const out = await runScript(`
      set -o pipefail
      false | cat
      echo "ec=$?"
    `);
    expect(out).toContain('ec=1');
  });
  it('H3 without pipefail the pipe\'s exit is the last stage\'s', async () => {
    const out = await runScript(`
      false | true
      echo "ec=$?"
    `);
    expect(out).toContain('ec=0');
  });
});
