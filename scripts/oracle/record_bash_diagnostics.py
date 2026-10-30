#!/usr/bin/env python3
"""Record what a real bash 5 writes (standard output and standard error, interleaved) for scripts that fail in the usual ways.

usage: record_bash_diagnostics.py out.json

Each script is saved as s.sh in a freshly emptied /tmp/w and run with `bash s.sh 2>&1`, so the diagnostics carry the script name and the
line number. The simulator replays the same scripts in bash-diagnostics-oracle.test.ts.
"""
import json, os, subprocess, sys

SCRIPTS = [
'foo',
'echo a\nfoo bar\necho b',
'/nonexistent/prog',
'./noexec',
'cd /nonexistent_dir\necho still',
'cat /nonexistent_file',
'ls /nonexistent_dir',
'echo hi > /nonexistent_dir/f',
'echo hi < /nonexistent_file',
'set -u\necho $undefined_var\necho after',
'set -u\necho ${arr[5]}',
'x=${y:?must be set}\necho after',
'x=; : ${x:?empty}\necho after',
'echo $((1/0))\necho after',
'echo $((2 +))',
'echo $((abc def))',
'echo ${#!}',
'echo ${bad subst}',
'echo ${x@Z}',
'readonly R=1\nR=2\necho after',
'f() { local x; }\nlocal y=1',
'declare -r C=1\nunset C\necho $?',
'export 1bad=x\necho $?',
'unset 1bad\necho $?',
'read -z 2>&1\necho $?',
'shift 5\necho $?',
'break\necho after',
'continue\necho after',
'return 2>&1\necho $?',
'exit 3 4\necho after',
'exit abc\necho after',
'let "x = 1 +"',
'(( 1 / 0 ))\necho $?',
'for i in 1 2; do\n  echo $i\n',
'if true; then\n  echo yes\n',
'case x in\n  x) echo m\n',
'fi',
'done',
'echo a ;; echo b',
'echo (',
'echo )',
'echo "unterminated',
"echo 'unterminated",
'echo a |',
'echo a &&',
'| echo a',
'echo a ; ; echo b',
'f() {\n  echo hi\n',
'if then fi',
'while do done',
'for in a b; do :; done',
'echo $(',
'echo `',
'echo ${',
'x=(1 2',
'[[ a == ]]',
'[[ -f ]]',
'[ 1 -eq ]',
'[ a = ]; echo $?',
'[ 1 -eq abc ]\necho $?',
'test -z\necho $?',
'cat <<EOF\nnever closed',
'declare -A m\nm=(a b)\necho done',
'a=(1 2 3)\necho ${a[@]:x}',
'echo ${1:2:-9}',
'trap "echo t" BADSIG\necho $?',
'kill -9 99999999\necho $?',
'wait 99999999\necho $?',
'unalias nosuchalias\necho $?',
'type nosuchcmd\necho $?',
'command -v nosuchcmd\necho $?',
'source /nonexistent_file\necho $?',
'. ./nonexistent\necho $?',
'bash /nonexistent_script.sh\necho $?',
'sh -c "exit 7"\necho $?',
'eval "foo bar"\necho $?',
'eval "if"\necho $?',
'mkdir /proc/x\necho $?',
'cp /nonexistent /tmp/w/x\necho $?',
'rm /nonexistent_file\necho $?',
'rm -f /nonexistent_file\necho $?',
'mv /nonexistent /tmp/w/y\necho $?',
'touch /nonexistent_dir/f\necho $?',
'grep pat /nonexistent_file\necho $?',
'head /nonexistent_file',
'wc /nonexistent_file',
'sort /nonexistent_file',
'chmod 755 /nonexistent_file',
'ln -s a b; ln -s a b\necho $?',
'echo hi | nosuchcmd\necho ${PIPESTATUS[@]}',
'false\necho $?\nset -e\nfalse\necho unreachable',
'set -e\nf() { false; }\nf\necho unreachable',
'set -eu\necho $UNSET_X',
'cd /tmp/w/nodir 2>&1 | cat\necho $?',
'ls nosuch 2>&1 | head -1',
'x=1 y=2 nosuchcmd\necho $x',
'nosuchcmd arg1 arg2 2>/dev/null\necho $?',
'echo $LINENO\necho $LINENO',
'f() { echo $LINENO; }\nf\necho ${BASH_LINENO[0]:-none}',
'echo $0',
'echo "${BASH_SOURCE[0]}"',
'trap \'echo "err at $LINENO"\' ERR\nfalse\ntrue',
'trap \'echo "exit $?"\' EXIT\nexit 4',
'main() { false; }\nset -E\ntrap "echo caught" ERR\nmain',
'shopt -s expand_aliases\nalias say="echo hi"; say\nsay',
'echo !(a)',
'x=a; case $x in !(b)) echo m;; esac',
'shopt -s extglob\necho @(a|b)\ncase a in @(a|b)) echo yes;; esac',
'echo ok\necho $(echo a ;; b)\necho after',
'echo $(if)\necho after',
'cat <(echo a\necho after',
'shopt -u extglob\ncase a in @(a)) echo y;; esac',
]

PRELUDE = 'rm -rf /tmp/w; mkdir -p /tmp/w; cd /tmp/w; touch noexec; '

def main():
    cases = []
    for script in SCRIPTS:
        body = PRELUDE
        subprocess.run(['bash', '-c', PRELUDE], check=True)
        open('/tmp/w/s.sh', 'w').write(script + '\n')
        run = subprocess.run(['bash', 's.sh'], capture_output=True, text=True, cwd='/tmp/w', env={'PATH': os.environ['PATH'], 'HOME': '/home/user'}, timeout=20, stdin=subprocess.DEVNULL)
        subprocess.run(['bash', '-c', 'find /tmp/w -mindepth 1 ! -name s.sh -delete; touch /tmp/w/noexec'], check=True)
        merged = subprocess.run('bash s.sh 2>&1', shell=True, capture_output=True, text=True, cwd='/tmp/w', env={'PATH': os.environ['PATH'], 'HOME': '/home/user'}, timeout=20, stdin=subprocess.DEVNULL)
        cases.append({'script': script, 'output': merged.stdout, 'status': run.returncode})
    version = subprocess.run(['bash', '--version'], capture_output=True, text=True).stdout.split('\n')[0]
    json.dump({'bash': version, 'cases': cases}, open(sys.argv[1], 'w'), indent=1)

if __name__ == '__main__':
    main()
