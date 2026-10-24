#!/usr/bin/env python3
"""Record what a real bash 5 prints for language-level snippets (expansion, arrays, arithmetic, tests, control flow, functions, printf, read).

usage: record_bash_language.py out.json

Each snippet runs under `bash -c` in a freshly emptied /tmp/w; stdout is kept byte for byte, followed by the exit status. Standard error is
dropped by `exec 2>/dev/null` in the prelude: its wording carries the invoking shell's name and line number, which the simulator does not share. The simulator replays the same
snippets in bash-language-oracle.test.ts.
"""
import json, os, subprocess, sys

PARAMETER = [
    'v=hello; echo ${v}', 'v=hello; echo ${#v}', 'echo ${u-default}', 'echo ${u:-default}', 'u=; echo ${u-default}', 'u=; echo ${u:-default}',
    'echo ${u=set}; echo $u', 'u=; echo ${u:=set}; echo $u', 'u=1; echo ${u:+alt}', 'u=; echo ${u:+alt}', 'u=1; echo ${u+alt}', 'u=; echo ${u+alt}',
    'v=hello; echo ${v:1}', 'v=hello; echo ${v:1:3}', 'v=hello; echo ${v: -2}', 'v=hello; echo ${v: -3:2}', 'v=hello; echo ${v:0:-1}', 'v=hello; echo ${v:9}',
    'v=hello; echo ${v#h}', 'v=hello; echo ${v#*l}', 'v=hello; echo ${v##*l}', 'v=hello; echo ${v%o}', 'v=hello; echo ${v%l*}', 'v=hello; echo ${v%%l*}',
    'v=hello; echo ${v/l/L}', 'v=hello; echo ${v//l/L}', 'v=hello; echo ${v/#h/H}', 'v=hello; echo ${v/%o/O}', 'v=hello; echo ${v/l}', 'v=hello; echo ${v//[el]/_}',
    'v=hello; echo ${v^}', 'v=hello; echo ${v^^}', 'v=HELLO; echo ${v,}', 'v=HELLO; echo ${v,,}', 'v=hello; echo ${v^^[el]}', 'v="hello world"; echo ${v^}',
    'v=a.b.c; echo ${v//./-}', 'v=/usr/local/bin; echo ${v##*/}', 'v=/usr/local/bin; echo ${v%/*}', 'v=file.tar.gz; echo ${v%%.*}', 'v=file.tar.gz; echo ${v%.*}',
    'v=file.tar.gz; echo ${v#*.}', 'v=file.tar.gz; echo ${v##*.}', 'v=abc; echo ${v@Q}', 'v=abc; echo ${v@U}', 'v=ABC; echo ${v@L}', 'v=abc; echo ${v@u}',
    'v="a b"; echo ${v@Q}', 'x=1; y=x; echo ${!y}', 'a=1; b=2; echo ${!a*}', 'set -- a b c; echo ${#}', 'set -- a b c; echo ${@:2}', 'set -- a b c; echo ${*:2:1}',
    'set -- a b c; echo ${@: -1}', 'set -- a b c; echo "${@:1:2}"', 'echo ${#u}', 'echo "${u:-a b}"', 'v=abc; echo ${v:1:1}${v:0:1}', 'v=; echo ${v:-}x',
    'echo ${u:?}x; echo after', 'v=3; echo $((v*2))', 'v=hello; echo "${v}world"', 'v=hello; echo "$v"world', 'v=a:b:c; IFS=:; set -- $v; echo $#', 'echo $((1+2))',
    'v="  x  "; echo "[$v]"', 'v="  x  "; echo [$v]', 'v=*; echo $v', 'v=*; echo "$v"', 'echo $HOME_UNSET$', 'echo \\$v', 'v=1; echo "\\$v"', "v=1; echo '$v'",
    'echo ${#1}', 'f() { echo ${#1}; }; f hello', 'f() { echo ${1:-none}; }; f; f x', 'f() { echo $#; }; f; f a b c', 'f() { echo "$@"; }; f "a b" c', 'f() { for x in "$@"; do echo "[$x]"; done; }; f "a b" c',
    'f() { for x in $@; do echo "[$x]"; done; }; f "a b" c', 'f() { for x in "$*"; do echo "[$x]"; done; }; f "a b" c', 'IFS=,; set -- a b c; echo "$*"', 'IFS=,; set -- a b c; echo $*',
    'set -- a b c; shift; echo $@', 'set -- a b c; shift 2; echo $@', 'set -- a b c; shift 5; echo $? $#', 'set -- a b; echo $1$2$3x',
]

ARRAYS = [
    'a=(1 2 3); echo ${a[@]}', 'a=(1 2 3); echo ${#a[@]}', 'a=(1 2 3); echo ${a[1]}', 'a=(1 2 3); echo ${a[-1]}', 'a=(1 2 3); echo ${a[@]:1}', 'a=(1 2 3); echo ${a[@]:1:1}',
    'a=(1 2 3); a+=(4); echo ${a[@]}', 'a=(1 2 3); a[5]=6; echo ${!a[@]}', 'a=(1 2 3); unset a[1]; echo ${a[@]} ${#a[@]}', 'a=(1 2 3); unset a; echo ${#a[@]}',
    'a=("x y" z); echo ${#a[@]}', 'a=("x y" z); for i in "${a[@]}"; do echo "[$i]"; done', 'a=("x y" z); for i in ${a[@]}; do echo "[$i]"; done', 'a=("x y" z); echo "${a[*]}"',
    'a=(1 2 3); echo "${a[@]/2/X}"', 'a=(ab cd); echo "${a[@]^^}"', 'a=(ab cd); echo "${a[@]#a}"', 'a=(1 2 3); b=("${a[@]}"); echo ${#b[@]}', 'a=(); echo ${#a[@]}', 'a=([2]=x [5]=y); echo ${!a[@]}',
    'a=(1 2 3); echo ${a}', 'a=(1 2 3); a=9; echo ${a[@]}', 'declare -A m; m[k]=v; echo ${m[k]}', 'declare -A m=([a]=1 [b]=2); echo ${#m[@]}', 'declare -A m=([a]=1); m[b]=2; for k in a b; do echo $k=${m[$k]}; done',
    'declare -A m=([a]=1 [b]=2); unset m[a]; echo ${!m[@]}', 'declare -A m=([a]=1 [b]=2); echo ${m[zz]:-none}', 'declare -A m; m["x y"]=1; echo ${m["x y"]}', 'declare -A m=([a]=1 [b]=2); [[ -v m[a] ]] && echo yes',
    'a=(3 1 2); IFS=$\'\\n\'; echo "$(printf "%s\\n" "${a[@]}" | sort)"', 'a=(one two); echo "${a[@]:0:1}-${a[@]:1:1}"', 'a=(1 2 3); for i in "${!a[@]}"; do echo $i:${a[$i]}; done',
    'a=(1 2 3); echo $((a[0]+a[2]))', 'a=(1 2 3); ((a[1]++)); echo ${a[@]}', 'a=(a b c); echo ${a[@]:(-2)}', 'mapfile -t a < <(printf "x\\ny\\n"); echo ${#a[@]} ${a[1]}',
    'read -ra a <<< "p q r"; echo ${#a[@]} ${a[2]}', 'a=(x y z); set -- "${a[@]}"; echo $#', 'a=(x y z); echo "${a[@]@Q}"', 'declare -a a=(1 2); declare -p a', 'declare -A m=([k]=v); declare -p m',
    'x=5; declare -i y=x+1; echo $y', 'declare -i n=3; n+=2; echo $n', 'declare -r c=1; c=2; echo $c', 'declare -x e=1; env | grep -c "^e=1"', 'declare -l l=ABC; echo $l', 'declare -u u=abc; echo $u',
    'readonly r=1; r=2 2>/dev/null; echo $r', 'local_test() { local x=1; echo $x; }; local_test; echo ${x:-unset}', 'f() { local -a arr=(1 2); echo ${#arr[@]}; }; f',
    'declare -p undefined_var', 'v=1; declare -p v', 'v="a b"; declare -p v', 'declare -f nofunc; echo $?', 'typeset -i z=7; echo $((z*2))', 'declare -n ref=target; target=5; echo $ref', 'target=5; declare -n ref=target; ref=6; echo $target',
]

ARITHMETIC = [
    'echo $((1+2*3))', 'echo $(((1+2)*3))', 'echo $((10/3))', 'echo $((10%3))', 'echo $((-10/3))', 'echo $((-10%3))', 'echo $((2**10))', 'echo $((1<<4))', 'echo $((256>>2))', 'echo $((5&3))', 'echo $((5|3))', 'echo $((5^3))',
    'echo $((~5))', 'echo $((!0))', 'echo $((!5))', 'echo $((3>2))', 'echo $((3<2))', 'echo $((3==3))', 'echo $((3!=3))', 'echo $((1&&0))', 'echo $((1||0))', 'echo $((1?2:3))', 'echo $((0?2:3))',
    'x=5; echo $((x++)); echo $x', 'x=5; echo $((++x)); echo $x', 'x=5; echo $((x--)); echo $x', 'x=5; ((x+=3)); echo $x', 'x=5; ((x*=2)); echo $x', 'x=5; ((x/=2)); echo $x', 'x=5; ((x%=3)); echo $x',
    'x=5; ((x<<=2)); echo $x', 'x=5; ((x|=2)); echo $x', 'echo $((0x1f))', 'echo $((010))', 'echo $((2#101))', 'echo $((16#ff))', 'echo $((36#z))', 'echo $((a=5, a*2))', 'a=3; b=4; echo $((a*a+b*b))',
    'echo $(( 1 + 2 ))', 'x=abc; echo $((x))', 'x=; echo $((x+1))', 'echo $((u+1))', '((1)); echo $?', '((0)); echo $?', 'x=3; ((x>2)) && echo big', 'x=3; if ((x==3)); then echo three; fi',
    'echo $((9223372036854775807+1))', 'echo $((-9223372036854775807-2))', 'echo $((1/0)) 2>/dev/null; echo $?', 'let x=2+3; echo $x', 'let "x = 2 * 4"; echo $x', 'let x=5 y=6; echo $((x+y))',
    'let 0; echo $?', 'let 1; echo $?', 'for ((i=0;i<3;i++)); do echo $i; done', 'for ((i=3;i>0;i--)); do echo -n $i; done; echo', 'for ((;;)); do echo once; break; done', 'i=0; while ((i<3)); do echo $i; ((i++)); done',
    'echo $((RANDOM>=0))', 'echo $(( $(echo 4) * 2 ))', 'a=(1 2 3); echo $(( ${#a[@]} * 2 ))', 'echo $((07))', 'echo $((08)) 2>/dev/null; echo $?', 'x=0x10; echo $((x))', 'echo $((1,2))', 'echo $((2**-1)) 2>/dev/null; echo $?',
    'echo $((5 > 3 && 2 < 4))', 'echo $((7 & ~2))', 'echo $((1<<62))', 'echo $((1<<63))', 'echo $((1<<64))', 'echo $((-1>>1))', 'n=5; f=1; while ((n>1)); do ((f*=n)); ((n--)); done; echo $f',
]

TESTS = [
    '[ 1 -eq 1 ]; echo $?', '[ 1 -ne 1 ]; echo $?', '[ 2 -gt 1 ]; echo $?', '[ 2 -lt 1 ]; echo $?', '[ a = a ]; echo $?', '[ a == a ]; echo $?', '[ a != b ]; echo $?', '[ -z "" ]; echo $?', '[ -n "" ]; echo $?', '[ -z "x" ]; echo $?',
    '[ -n x ]; echo $?', '[ ]; echo $?', '[ x ]; echo $?', '[ "" ]; echo $?', '[ ! -z x ]; echo $?', '[ -e /etc ]; echo $?', '[ -d /etc ]; echo $?', '[ -f /etc ]; echo $?', '[ -f /etc/passwd ]; echo $?', '[ -r /etc/passwd ]; echo $?',
    '[ -s /etc/passwd ]; echo $?', '[ -L /etc ]; echo $?', '[ -x /bin/sh ]; echo $?', '[ -w /nonexistent ]; echo $?', '[ a \\< b ]; echo $?', '[ b \\> a ]; echo $?', '[ 1 -eq 1 -a 2 -eq 2 ]; echo $?', '[ 1 -eq 2 -o 2 -eq 2 ]; echo $?',
    '[ \\( 1 -eq 1 \\) ]; echo $?', '[ -n "$u" ]; echo $?', '[ $u = x ] 2>/dev/null; echo $?', '[ "$u" = x ]; echo $?', '[[ -n $u ]]; echo $?', '[[ $u = x ]]; echo $?', '[[ a == a ]]; echo $?', '[[ a == b ]]; echo $?',
    '[[ abc == a* ]]; echo $?', '[[ abc == "a*" ]]; echo $?', '[[ abc != a* ]]; echo $?', '[[ abc =~ ^a.c$ ]]; echo $?', '[[ abc =~ ^b ]]; echo $?', '[[ abc =~ (b)(c) ]]; echo ${BASH_REMATCH[0]} ${BASH_REMATCH[1]} ${BASH_REMATCH[2]}',
    '[[ 2 -gt 10 ]]; echo $?', '[[ 2 > 10 ]]; echo $?', '[[ a < b ]]; echo $?', '[[ -z "" && -n x ]]; echo $?', '[[ -z x || -n x ]]; echo $?', '[[ ! -z x ]]; echo $?', '[[ ( 1 -eq 1 ) ]]; echo $?', '[[ 1 -eq 1 && 2 -eq 3 ]]; echo $?',
    '[[ -e /etc && -d /etc ]]; echo $?', '[[ "a b" == "a b" ]]; echo $?', '[[ a == [a-c] ]]; echo $?', '[[ ab == a? ]]; echo $?', '[[ 010 -eq 8 ]]; echo $?', '[[ x -eq 0 ]]; echo $?', '[[ -v u ]]; echo $?', 'u=1; [[ -v u ]]; echo $?',
    'test 1 -eq 1; echo $?', 'test -d /etc; echo $?', 'test a = a && echo y', 'test; echo $?', 'test -n; echo $?', '! true; echo $?', '! false; echo $?', 'true && echo a || echo b', 'false && echo a || echo b', 'false || echo b && echo c',
    'true; true && false; echo $?', '(exit 3); echo $?', '{ exit 3; }; echo not', 'f() { return 4; }; f; echo $?', 'f() { return; }; false; f; echo $?', 'true | false; echo $?', 'false | true; echo $?', 'set -o pipefail; false | true; echo $?',
    'set -o pipefail; true | false | true; echo $?', 'false | true; echo ${PIPESTATUS[@]}', 'true | false | true; echo ${PIPESTATUS[@]}', 'echo $?; true; echo $?', 'false; echo $?; echo $?', 'if true; then echo a; fi', 'if false; then echo a; else echo b; fi',
    'if false; then echo a; elif true; then echo b; fi', 'if false; then echo a; fi; echo $?', 'if true; then false; fi; echo $?', 'if [ -d /etc ]; then echo d; fi', 'if ! false; then echo neg; fi', 'if true && false; then echo a; else echo b; fi',
    'if (exit 2); then echo a; else echo $?; fi', 'while false; do :; done; echo $?', 'until true; do :; done; echo $?', 'for i in; do :; done; echo $?', 'case x in x) echo m;; esac', 'case x in y) echo m;; esac; echo $?',
    'case abc in a*) echo p;; *) echo q;; esac', 'case abc in x|abc) echo alt;; esac', 'case abc in a?c) echo q;; esac', 'case "a b" in "a b") echo sp;; esac', 'case x in x) echo 1;& y) echo 2;; z) echo 3;; esac',
    'case x in x) echo 1;;& *) echo 2;; esac', 'case a in [abc]) echo cls;; esac', 'case A in [[:upper:]]) echo up;; esac', 'case "" in "") echo empty;; esac', 'x=b; case $x in a) echo A;; b) echo B;; *) echo O;; esac',
]

LOOPS = [
    'for i in 1 2 3; do echo $i; done', 'for i in a b c; do echo -n $i; done; echo', 'for i in {1..5}; do echo -n $i; done; echo', 'for i in {5..1}; do echo -n $i; done; echo', 'for i in {1..10..3}; do echo -n $i; done; echo',
    'for i in {a..e}; do echo -n $i; done; echo', 'for i in {01..03}; do echo -n $i,; done; echo', 'for i in 1 2 3; do [ $i = 2 ] && continue; echo $i; done', 'for i in 1 2 3; do [ $i = 2 ] && break; echo $i; done',
    'for i in 1 2; do for j in a b; do echo $i$j; done; done', 'for i in 1 2; do for j in a b; do [ $j = a ] && continue 2; echo $i$j; done; done', 'for i in 1 2; do for j in a b; do break 2; done; done; echo done',
    'i=0; while [ $i -lt 3 ]; do echo $i; i=$((i+1)); done', 'i=3; until [ $i -eq 0 ]; do echo $i; i=$((i-1)); done', 'while read l; do echo "[$l]"; done <<< $\'a\\nb\'', 'printf "a\\nb\\n" | while read l; do echo "[$l]"; done',
    'printf "a b\\n" | while read x y; do echo "$y $x"; done', 'while read -r l; do echo "$l"; done <<< "x\\y"', 'while read l; do echo "$l"; done <<< "x\\y"', 'while IFS=: read a b; do echo $b $a; done <<< "k:v"',
    'n=0; printf "a\\nb\\n" | while read l; do n=$((n+1)); done; echo $n', 'n=0; while read l; do n=$((n+1)); done < <(printf "a\\nb\\n"); echo $n', 'for f in /etc/hostname /nonexistent; do [ -e $f ] && echo $f; done',
    'for i in $(seq 1 3); do echo $i; done', 'for i in $(echo a b); do echo $i; done', 'for i in "$(echo a b)"; do echo "[$i]"; done', 'for i in *.nomatch; do echo $i; done', 'for i in "a b" c; do echo "[$i]"; done',
    'i=0; while true; do i=$((i+1)); [ $i -ge 3 ] && break; done; echo $i', 'select x in a b; do echo $x; break; done <<< 1', 'for i in 1 2 3; do echo $i; done | tail -1', 'for i in 1 2 3; do echo $i; done > /tmp/o.txt; cat /tmp/o.txt',
    'i=0; until ((i==2)); do ((i++)); done; echo $i', 'echo a; (echo b; echo c) | tail -1', 'x=1; (x=2; echo $x); echo $x', 'x=1; { x=2; }; echo $x', 'x=1; echo $x | { read y; echo $y; }', '{ echo a; echo b; } | wc -l', '{ echo a; echo b; } > /tmp/b.txt; wc -l < /tmp/b.txt',
    'cd /tmp; (cd /; pwd); pwd', 'pwd; cd /etc && pwd', 'cd /nonexistent 2>/dev/null; echo $?', 'cd /tmp; cd -; echo done', 'echo ${PWD}; cd /usr; echo ${PWD} ${OLDPWD}',
]

FUNCTIONS = [
    'f() { echo hi; }; f', 'f() { echo $1; }; f x', 'function f { echo hi; }; f', 'function f() { echo hi; }; f', 'f() { echo a; }; f() { echo b; }; f', 'f() { return 3; }; f; echo $?', 'f() { echo $?; }; false; f',
    'f() { local x=1; g; echo $x; }; g() { x=2; }; f', 'f() { x=1; }; f; echo $x', 'f() { local x; x=1; }; f; echo ${x:-u}', 'x=0; f() { local x=1; echo $x; }; f; echo $x', 'f() { echo $FUNCNAME; }; f', 'f() { g; }; g() { echo ${FUNCNAME[0]} ${FUNCNAME[1]}; }; f',
    'f() { echo $#; }; f 1 2 3', 'f() { shift; echo $@; }; f 1 2 3', 'f() { echo "$0"; }; f', 'f() { set -- x y; echo $1; }; f a; echo done', 'f() { echo $@; }; set -- p q; f; f r', 'fact() { local n=$1; [ $n -le 1 ] && { echo 1; return; }; echo $(( n * $(fact $((n-1))) )); }; fact 5',
    'fib() { [ $1 -lt 2 ] && echo $1 || echo $(( $(fib $(($1-1))) + $(fib $(($1-2))) )); }; fib 10', 'f() { echo in; return 1; echo no; }; f; echo $?', 'f() { for i in 1 2 3; do [ $i = 2 ] && return $i; done; }; f; echo $?', 'f() { echo "[$1][$2]"; }; f "a b" c',
    'f() { echo $1; }; f $(echo a b)', 'f() { echo $1; }; f "$(echo a b)"', 'f() { cat; }; echo hi | f', 'f() { read x; echo "got $x"; }; echo v | f', 'f() { echo out; echo err >&2; }; f 2>/dev/null', 'f() { echo out; echo err >&2; }; f 2>&1 | wc -l',
    'f() { echo a; }; declare -F f', 'f() { echo a; }; unset -f f; f 2>/dev/null; echo $?', 'f() { echo a; }; type f | head -1', 'f() { echo a; }; declare -f f', 'alias ll="echo long"; ll', 'shopt -s expand_aliases; alias ll="echo long"; ll',
    'f() { local IFS=,; set -- a b; echo "$*"; }; f', 'f() { local -r c=1; echo $c; }; f', 'f() { eval "$1=5"; }; f v; echo $v', 'f() { printf "%s\\n" "$@"; }; f a b', 'f() { echo ${1:?missing}; }; f 2>/dev/null; echo $?', 'f() { : "${1:=def}"; echo $1; }; f',
    'eval echo hi', 'eval "x=5"; echo $x', 'eval "echo \\$HOME_X" ', 'cmd="echo hi"; $cmd', 'cmd="echo a b"; "$cmd" 2>/dev/null; echo $?', 'x="a b"; eval "echo $x"', 'eval "false"; echo $?', 'eval; echo $?', 'source /nonexistent 2>/dev/null; echo $?',
    'echo "echo sourced" > /tmp/s.sh; source /tmp/s.sh', 'echo "echo \\$1" > /tmp/s.sh; . /tmp/s.sh arg', 'echo "return 3" > /tmp/s.sh; source /tmp/s.sh; echo $?', 'trap "echo bye" EXIT; echo run', 'trap "echo err" ERR; false; echo after', 'trap "echo int" INT; kill -INT $$; echo after',
    'trap - EXIT; echo ok', 'trap "echo a" EXIT; trap "echo b" EXIT; echo run', 'trap "echo exit" EXIT; exit 3', 'f() { trap "echo in f" RETURN; echo body; }; f', 'trap "echo x" DEBUG; echo y', 'trap; echo ok', 'trap "echo t" EXIT; trap -p EXIT',
    'exit_code() { return $1; }; exit_code 7; echo $?', 'command -v echo', 'command -v nonexistent_cmd; echo $?', 'type -t echo', 'type -t ls', 'type -t if', 'type -t f; echo $?', 'builtin echo hi', 'command echo hi', 'hash -r; echo $?', 'enable -n echo; echo hi 2>/dev/null; echo done',
]

QUOTING = [
    "echo 'a b'", 'echo "a b"', 'echo a\\ b', "echo 'it'\\''s'", 'echo "it\'s"', 'echo "a\\"b"', 'echo "a\\\\b"', 'echo "a\\nb"', "echo $'a\\nb'", "echo $'tab\\there'", "echo $'\\x41\\101'", "echo $'q\\'q'", "echo \"$'x'\"",
    'echo a  b', 'echo "a  b"', 'echo   a', 'echo a   ', 'echo "a" "b"', 'echo a"b"c', 'echo ""', 'echo "" ""', 'echo -n', 'echo -n a b', 'echo -e "a\\tb"', 'echo -e "a\\\\nb"', 'echo -E "a\\nb"', 'echo -ne "a\\nb"', 'echo -en "a\\nb"', 'echo -- a', 'echo -x', 'echo -n -n a',
    'echo *', 'echo "*"', 'echo \\*', 'echo ~', 'echo "~"', 'echo ~root', 'echo ~nouser', 'echo a~', 'echo ~/x', 'echo {a,b}', 'echo {a,b}c', 'echo c{a,b}', 'echo {a,b}{1,2}', 'echo {a,b,}', 'echo {a}', 'echo {a,b', 'echo "{a,b}"', 'echo {1..3}{a,b}', 'echo x{,y}', 'echo {a..c}{1..2}',
    'echo a;b', 'echo a; echo b', 'echo a && echo b', 'echo a || echo b', 'echo a & wait', 'echo a # comment', 'echo a#b', 'echo "a # b"', '# only comment', 'echo a \\\n b', 'echo "$(echo a)"', 'echo `echo a`', 'echo "`echo a`"', 'echo $(echo $(echo n))', 'echo "$(echo "q")"',
    'echo $(printf "a\\n\\n")x', 'echo "$(printf "a\\n\\n")x"', 'x=$(printf "a\\nb\\n"); echo "$x"', 'x=$(printf "a\\nb\\n"); echo $x', 'x=$(false); echo $?', 'x=$(exit 3); echo $?', 'echo $(true)x', 'echo `echo \\`echo n\\``', 'x=`echo a b`; echo "$x"',
    'echo $((1+1))$((2+2))', 'echo "$((1+1))"', 'echo $(( $(echo 1) + 1 ))', 'a=1 b=2; echo $a$b', 'a=1; b=$a; echo $b', 'a=1 echo $a', 'a=1; a=2 env | grep -c "^a=2"', 'x="a=b"; echo $x', 'echo a=b', 'a=b=c; echo $a', 'a+=x; a+=y; echo $a', 'n=1; n+=2; echo $n',
    'echo $$ | grep -c "^[0-9]*$"', 'echo $0', 'echo $-  | grep -c .', 'echo $#', 'echo "$@"', 'echo [$*]', 'echo a; echo $_', 'echo $LINENO', 'echo $BASH_VERSINFO', 'echo ${BASH_VERSION%%.*}', 'echo $SECONDS | grep -c "^[0-9]"', 'echo ${RANDOM:+r}', 'echo $UID | grep -c "^[0-9]*$"',
    'echo "${IFS}" | wc -c', 'printf "%s" "$IFS" | wc -c', 'echo $PS1 | wc -c', 'echo ${PATH:+set}', 'echo ${HOME:+set}', 'echo $HOSTNAME | grep -c .', 'echo $OSTYPE', 'echo $HOSTTYPE', 'echo $MACHTYPE | grep -c linux',
    'x="a\tb"; echo "$x"', "x='a\\tb'; echo \"$x\"", 'x=$\'a\\tb\'; echo "$x"', 'echo "a$"', 'echo "$"', 'echo $ x', 'echo "\\$x"', 'echo \\\\', 'echo \\a', 'echo "\\a"', 'echo \'\\\'', 'echo "\\`"', 'echo \\`',
]

REDIRECTION = [
    'echo hi > /tmp/f.txt; cat /tmp/f.txt', 'echo a > /tmp/f.txt; echo b >> /tmp/f.txt; cat /tmp/f.txt', 'echo a > /tmp/f.txt; echo b > /tmp/f.txt; cat /tmp/f.txt', 'cat < /dev/null; echo $?', 'cat /nonexistent 2>/dev/null; echo $?', 'cat /nonexistent 2>&1 | wc -l',
    'echo a >&2 2>/dev/null; echo done', 'echo a 1>&2 2>/dev/null; echo done', '{ echo a; echo b >&2; } 2>/dev/null', '{ echo a; echo b >&2; } 2>&1 | wc -l', '{ echo a; echo b >&2; } >/dev/null 2>&1; echo done', '{ echo a; echo b >&2; } 2>&1 >/dev/null | wc -l',
    'echo a &> /tmp/f.txt; cat /tmp/f.txt', 'echo a &>> /tmp/f.txt; echo b &>> /tmp/f.txt; cat /tmp/f.txt', 'ls /nonexistent &> /dev/null; echo $?', 'echo a > /tmp/f.txt; < /tmp/f.txt cat', 'cat <<< "here"', 'cat <<< $x', 'x="a b"; cat <<< "$x"', 'x="a b"; cat <<< $x',
    'cat <<EOF\nline1\nline2\nEOF', 'x=5; cat <<EOF\nv=$x\nEOF', 'x=5; cat <<\'EOF\'\nv=$x\nEOF', 'x=5; cat <<"EOF"\nv=$x\nEOF', 'cat <<-EOF\n\tindented\n\tEOF', 'cat <<EOF\n$(echo sub)\nEOF', 'cat <<EOF\n$((1+2))\nEOF', 'cat <<EOF\n\\$esc\nEOF',
    'cat <<EOF | tr a-z A-Z\nabc\nEOF', 'cat <<EOF > /tmp/h.txt\nxyz\nEOF\ncat /tmp/h.txt', 'while read l; do echo "[$l]"; done <<EOF\na b\n  c\nEOF', 'cat <<A; cat <<B\na\nA\nb\nB', 'f() { cat <<EOF\nin $1\nEOF\n}; f arg',
    'exec 3>/tmp/fd.txt; echo a >&3; echo b >&3; exec 3>&-; cat /tmp/fd.txt', 'exec 3</etc/hostname; read -u 3 l; exec 3<&-; echo got', 'echo a | tee /tmp/t1.txt | cat; cat /tmp/t1.txt', 'echo a | tee -a /tmp/t2.txt >/dev/null; echo b | tee -a /tmp/t2.txt >/dev/null; cat /tmp/t2.txt',
    'diff <(echo a) <(echo a); echo $?', 'cat <(echo p)', 'cat <(echo a; echo b) | wc -l', 'wc -l < <(echo a)', 'echo a > >(cat); sleep 0.1', 'paste <(echo 1) <(echo 2)', 'echo $(< /etc/hostname) | grep -c .', 'echo x > /tmp/n.txt; echo $(<  /tmp/n.txt)', 'x=$(< /nonexistent) 2>/dev/null; echo $?',
    'echo a > /dev/null; echo $?', 'echo a > /nonexistent/f 2>/dev/null; echo $?', 'set -C; echo a > /tmp/nc.txt; echo b > /tmp/nc.txt 2>/dev/null; echo $?; cat /tmp/nc.txt', 'set -C; echo a >| /tmp/nc2.txt; echo b >| /tmp/nc2.txt; cat /tmp/nc2.txt',
    'echo a > /tmp/x1 > /tmp/x2; cat /tmp/x1 | wc -c; cat /tmp/x2', 'true > /tmp/trunc; echo a > /tmp/trunc; : > /tmp/trunc; wc -c < /tmp/trunc', 'echo hello | read x; echo "[$x]"', 'shopt -s lastpipe; echo hello | read x; echo "[$x]"', 'read x <<< "a b c"; echo "$x"', 'read x y <<< "a b c"; echo "$x|$y"',
    'read -r x <<< "a\\b"; echo "$x"', 'read x <<< "a\\b"; echo "$x"', 'read -d, x <<< "a,b"; echo "$x"', 'read -n2 x <<< "abc"; echo "$x"', 'read -a arr <<< "p q"; echo ${arr[1]}', 'IFS=: read a b <<< "1:2"; echo $b', 'read <<< "val"; echo "$REPLY"', 'read -p "prompt" x <<< v; echo "$x"',
    'read x < /dev/null; echo $?', 'printf "a\\n" | { read x; echo $x; }', 'printf "a" | { read x; echo $? $x; }', 'printf "a\\nb\\n" | { read x; read y; echo $x$y; }', 'echo "  lead" | { read x; echo "[$x]"; }', 'echo "  lead" | { IFS= read x; echo "[$x]"; }', 'echo "a  b" | { read x y; echo "[$x][$y]"; }',
]

PRINTF = [
    'printf "%s\\n" hi', 'printf "%s %s\\n" a b', 'printf "%s\\n" a b c', 'printf "%s %s\\n" a b c', 'printf "%d\\n" 42', 'printf "%d\\n" -5', 'printf "%d\\n" 0x1f', 'printf "%d\\n" 010', 'printf "%d\\n" abc 2>/dev/null; echo $?', 'printf "%i\\n" 7', 'printf "%u\\n" 3',
    'printf "%x\\n" 255', 'printf "%X\\n" 255', 'printf "%o\\n" 8', 'printf "%#x\\n" 255', 'printf "%#o\\n" 8', 'printf "%c\\n" abc', 'printf "%5s|\\n" ab', 'printf "%-5s|\\n" ab', 'printf "%05d\\n" 42', 'printf "%+d\\n" 5', 'printf "% d\\n" 5', 'printf "%.2s\\n" abcdef',
    'printf "%5.2s|\\n" abcdef', 'printf "%*d\\n" 5 42', 'printf "%-*d|\\n" 5 42', 'printf "%.3f\\n" 3.14159', 'printf "%f\\n" 1.5', 'printf "%e\\n" 1234.5', 'printf "%g\\n" 0.0001', 'printf "%g\\n" 1000000', 'printf "%10.3f|\\n" 3.14159', 'printf "%%\\n"', 'printf "%5%|\\n"',
    'printf "a\\tb\\n"', 'printf "a\\\\b\\n"', 'printf "\\x41\\n"', 'printf "\\101\\n"', 'printf "a\\nb"', 'printf "no newline"', 'printf ""', 'printf "%s"', 'printf "%s\\n"', 'printf "%d\\n"',
    'printf -v v "%s-%s" a b; echo $v', 'printf -v v "%05.1f" 3.14159; echo $v', 'printf "%q\\n" "a b"', 'printf "%q\\n" "it\'s"', 'printf "%q\\n" ""', 'printf "%q\\n" plain', 'printf "%b\\n" "a\\tb"', 'printf "%s\\n" "a\\tb"', 'printf "%(%Y)T\\n" 0', 'printf "%s\\n" "$(printf "%s" x)"',
    'printf "%s %s %s\\n" 1 2', 'printf "%d %d\\n" 1 2 3 4', 'printf "[%s]\\n" "" a', 'printf "%s\\n" "a b" c', 'printf "%.0f\\n" 2.5', 'printf "%.0f\\n" 3.5', 'printf "%d\\n" 3.7 2>/dev/null; echo $?', 'printf "%d\\n" "\'a"', 'printf "%d\\n" "\\"b"', 'printf "%s\\n" -- x',
    'printf -- "-n\\n"', 'printf "%s\\n" "$@"', 'set -- a b; printf "%s\\n" "$@"', 'set -- a b; printf "<%s>" "$@"; echo', 'printf "%-10s%s\\n" name value', 'printf "%3d|%-3d|%03d\\n" 5 5 5', 'printf "%s\\n" "multi\\nline"', 'printf "%b" "a\\n"', 'printf "%b" "a\\c" ; echo', 'printf "%.3d\\n" 5',
    'printf "%ld\\n" 5', 'printf "%lld\\n" 5', 'printf "%hd\\n" 5', 'printf "%5c|\\n" x', 'printf "%s\\n" 9223372036854775807', 'printf "%d\\n" 9223372036854775808 2>/dev/null; echo $?', 'printf "%x\\n" -1', 'printf "%u\\n" -1', 'printf "%d\\n" 1e3 2>/dev/null; echo $?',
]

SPECIAL = [
    'set -e; false; echo not', 'set -e; true; echo yes', 'set -e; false || echo rescued', 'set -e; if false; then :; fi; echo ok', 'set -e; f() { false; echo in; }; f; echo not', 'set -e; (false); echo not', 'set -e; false && true; echo ok', 'set -e; ! false; echo ok',
    'set -u; echo $u 2>/dev/null; echo $?', 'set -u; echo ${u:-d}', 'set -u; echo ${u-d}', 'set -u; a=(); echo ${a[@]} 2>/dev/null; echo $?', 'set -x; echo hi 2>/dev/null', 'set +e; false; echo cont', 'set -o noglob; echo *', 'set -f; echo *; set +f', 'set -o | grep -c errexit',
    'set -n; echo no', 'set -v; echo v 2>/dev/null', 'set -a; v=1; env | grep -c "^v=1"', 'set -o nounset; echo ${u:-x}', 'set -o posix; echo ok', 'shopt -s nullglob; echo /nonexistent*; echo x', 'shopt -s failglob; echo /nonexistent* 2>/dev/null; echo $?', 'shopt -s nocaseglob; echo done',
    'shopt -q nullglob; echo $?', 'shopt -s extglob; echo @(a|b)', 'shopt -s extglob; x=ab; [[ $x == @(ab|cd) ]] && echo m', 'shopt -s extglob; x=abc; echo ${x#+([a-b])}', 'shopt -s globstar; echo ok', 'shopt -s dotglob; echo ok', 'shopt -s nocasematch; [[ A == a ]] && echo m',
    'shopt -s nocasematch; case A in a) echo m;; esac', 'shopt -s lastpipe; echo ok', 'shopt -u expand_aliases; echo ok', 'shopt expand_aliases | cut -c1-14', 'shopt -p nullglob', 'shopt -s nullglob; shopt -p nullglob', 'shopt -o errexit | tr -s " \\t" " "',
    'mkdir -p /tmp/g; cd /tmp/g; touch a.txt b.txt c.log; echo *.txt', 'cd /tmp/g; echo *', 'cd /tmp/g; echo ?.txt', 'cd /tmp/g; echo [ab].txt', 'cd /tmp/g; echo [!a].txt', 'cd /tmp/g; echo [^a].*', 'cd /tmp/g; echo *.{txt,log}', 'cd /tmp/g; echo "*.txt"', 'cd /tmp/g; ls *.txt | wc -l',
    'cd /tmp/g; for f in *.txt; do echo ${f%.txt}; done', 'cd /tmp/g; echo .*', 'cd /tmp/g; touch .hid; echo *; echo .h*', 'cd /tmp/g; echo [[:alpha:]].txt', 'cd /tmp/g; echo a.*', 'cd /tmp/g; x=*.txt; echo $x', 'cd /tmp/g; x="*.txt"; echo "$x"', 'cd /tmp/g; echo ./*.log', 'cd /tmp/g; echo $PWD/*.log',
    'cd /tmp/g; mkdir -p d/e; touch d/e/f; echo */', 'cd /tmp/g; mkdir -p d/e; touch d/e/f; echo d/*/*', 'cd /tmp/g; mkdir d; echo ***', 'echo /nonexistent/*', 'echo [', 'echo []', 'echo [a', 'echo ?', 'echo a?', 'echo "$(echo *)" | wc -w',
    'wait; echo $?', 'sleep 0 & echo $!  | grep -c "^[0-9]*$"; wait', 'sleep 0 & wait $!; echo $?', '(sleep 0; exit 4) & wait $!; echo $?', 'jobs; echo $?', 'true & wait; echo done', 'echo a & echo b & wait', 'kill -0 $$; echo $?', 'kill -0 99999999 2>/dev/null; echo $?',
    'umask', 'umask 077; umask', 'umask -S', 'ulimit -n | grep -c "^[0-9]*"', 'type cd', 'help cd | head -1', 'let', 'times | wc -l', 'caller; echo $?', 'getopts a: o -a val; echo $o $OPTARG', 'set -- -a -b x; while getopts ab o; do echo opt=$o; done; echo $OPTIND',
    'set -- -a v -b; while getopts a:b o; do echo $o:$OPTARG; done', 'set -- -z; getopts a o 2>/dev/null; echo $o', 'OPTIND=1; set -- -ab; while getopts ab o; do echo $o; done', 'set -- foo; getopts a o; echo $?', 'set -- -- -a; getopts a o; echo $?',
    'dirs', 'pushd /tmp >/dev/null; pwd; popd >/dev/null; pwd', 'pushd /tmp > /dev/null; dirs', 'cd /tmp; pushd /usr > /dev/null; popd; pwd', 'read -t 0 x < /dev/null; echo $?', 'date +%Y | grep -c "^20"', 'printf "%(%s)T\\n" -1 | grep -c "^[0-9]*$"', 'echo $EPOCHSECONDS | grep -c "^[0-9]*$"',
    'mapfile -t l <<< $\'a\\nb\'; echo ${#l[@]}', 'mapfile l <<< "x"; declare -p l', 'mapfile -n1 -t l < <(printf "a\\nb\\n"); echo ${l[@]}', 'readarray -t l < <(echo p); echo ${l[0]}', 'compgen -b | grep -c "^echo$"', 'compgen -A function; echo $?', 'f() { :; }; compgen -A function',
    'ls /nonexistent 2>&1 | grep -c "cannot access"', 'false; echo $?', 'true; echo $?', ': ; echo $?', ': a b c; echo $?', 'echo $((RANDOM % 1))', 'echo ${BASH_SOURCE[0]:-none}', 'echo ${#BASH_SOURCE[@]}', 'echo ${BASH_LINENO[0]}', 'bash -c "echo sub"', 'bash -c "echo \\$0 \\$1" name arg',
    'sh -c "echo sh"', 'bash -c "exit 5"; echo $?', 'bash -c "echo \\$((1+1))"', 'echo echo piped | bash', 'echo "echo a; echo b" | bash | wc -l', 'x=1 bash -c "echo \\$x"', 'export x=2; bash -c "echo \\$x"', 'x=3; bash -c "echo \\${x:-unset}"', 'f() { echo fn; }; export -f f; bash -c f',
    'env -i bash -c "echo \\${HOME:-nohome}"', 'env x=1 bash -c "echo \\$x"', 'env | grep -c "^PATH="', 'printenv HOME | grep -c .', 'unset HOME; echo ${HOME:-gone}', 'export -p | grep -c "declare -x"', 'export A=1 B=2; env | grep -c "^[AB]="', 'A=1; export A; env | grep "^A="', 'export A; echo ok',
    'readonly A=1; unset A 2>/dev/null; echo $?', 'readonly -p | grep -c "declare -r"', 'xargs -n1 echo <<< "a b"', 'echo a b | xargs -n1', 'echo "a b" | xargs -I{} echo [{}]', 'seq 3 | xargs', 'seq 3 | paste -sd+ | bc', 'seq 5 | sed -n 2,4p', 'seq 3 | tac | head -1', 'seq 1 2 7', 'seq 3 1', 'seq -s, 3',
    'yes | head -2', 'yes a | head -1', 'true | yes | head -1', 'basename /a/b.c .c', 'dirname /a/b/c', 'basename a/', 'dirname a', 'dirname /', 'realpath /tmp/../etc', 'readlink -f /tmp/.', 'expr 1 + 2', 'expr length abc', 'expr 5 \\* 3', 'expr abc : "a\\(.*\\)"', 'test -t 0; echo $?',
    'echo $(( $(date +%s) > 0 ))', 'sleep 0.01; echo $?', 'nonexistent_cmd 2>/dev/null; echo $?', '/nonexistent/cmd 2>/dev/null; echo $?', '/etc 2>/dev/null; echo $?', './nonexistent 2>/dev/null; echo $?', 'echo hi | nonexistent_cmd 2>/dev/null; echo $?', 'nonexistent_cmd 2>&1 | grep -c "not found"',
]

GROUPS = {
    'parameter': PARAMETER, 'array': ARRAYS, 'arithmetic': ARITHMETIC, 'test': TESTS, 'loop': LOOPS, 'function': FUNCTIONS,
    'quoting': QUOTING, 'redirection': REDIRECTION, 'printf': PRINTF, 'special': SPECIAL,
}

PRELUDE = 'exec 2>/dev/null; rm -rf /tmp/w; mkdir -p /tmp/w; cd /tmp/w; '

def selfContained(snippet):
    snippet = snippet.replace('mkdir -p /tmp/g; cd /tmp/g; ', 'mkdir g; cd g; ').replace('cd /tmp/g; ', 'mkdir -p g; cd g; touch a.txt b.txt c.log; ')
    return snippet.replace('/tmp/g/', 'g/').replace('/tmp/', '')

def main():
    cases = []
    for group, snippets in GROUPS.items():
        for snippet in snippets:
            if group == 'redirection' and 'EOF' in snippet or snippet.startswith('cat <<A'):
                snippet = snippet.replace('\\n', '\n')
            snippet = selfContained(snippet)
            run = subprocess.run(['bash', '-c', PRELUDE + snippet], capture_output=True, text=True, env={'PATH': os.environ['PATH'], 'HOME': '/home/user'}, timeout=20, stdin=subprocess.DEVNULL)
            cases.append({'group': group, 'command': snippet, 'stdout': run.stdout, 'status': run.returncode})
    version = subprocess.run(['bash', '--version'], capture_output=True, text=True).stdout.split('\n')[0]
    json.dump({'bash': version, 'cases': cases}, open(sys.argv[1], 'w'), indent=1)

if __name__ == '__main__':
    main()
