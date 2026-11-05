/*
 * bc was an expression calculator: no define, if, while, for, break, continue, return, print, auto, arrays, functions, halt, limits, no math library (-l
 * answered 'not available'), numbers never wrapped at 68 columns with a backslash, obase above 10 lost its fractions and its two-digit groups, ibase fractions
 * were dropped, -2^2 was -4 (GNU bc parses the unary minus tighter than ^: 4), a bare zero kept its scale, errors went to the output stream and the
 * adr= of a runtime error was a constant. Bc.ts is now a parser and an interpreter of the GNU bc language: statement grammar, user functions with auto
 * variables and array parameters, break/continue/return, print with its escapes, last and '.', the 70-column wrap of numbers, obase digit rules
 * (groups above 16, fraction digit count from the scale of the value), ibase with fractions, 'Runtime error (func=..., adr=N)' where N follows
 * the pcode byte count of the real compiler (constants 0 and 1 are one byte, others 'n<text>:', loads and stores two bytes, a pop one, a builtin two, a call
 * four), syntax errors with the line the parser stood on, the Runtime warning for a fractional exponent, stderr kept apart, and bc -l loading the
 * GNU math library (s c a l e j) at scale 20.
 *
 * Every expected string was produced by the real bc 1.07.1 of the dev container. adr values inside loops (for/while jump offsets) are not modelled and
 * not pinned; read() and the interactive banner are not modelled.
 *
 * Measured against the commit before (worktree): 106 of 156 cases fall. The 50 that pass either way are the arithmetic, scale, comparison and plain-expression cases the old
 * calculator already got right; they are the witnesses that the rewrite did not regress the core.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const SETUP = "mkdir -p sub/deep sub/empty; printf 'hi\\n' > a.txt; printf 'yo\\n' > sub/b.log; : > sub/deep/c.txt; printf 'x%.0s' $(seq 1 3000) > big; ln -sf a.txt lnk; ln -sfn sub dlnk; ln -sfn nowhere dang; ln -sfn lnk2 lnk2; printf 'a.txt\\0sub\\0' > list0; chmod 600 sub/b.log; chmod 755 sub/deep; seq 1 10 > nums; printf 'foo bar\\nbaz qux\\nFoo BAR\\nhello world\\nbaz qux\\nbaz qux\\nz:y:x\\n' > words; printf 'a\\0b\\0a\\0' > z";

const normalise = (text: string): string => text.replace(/line 1: /g, '').replace(/[\u2018\u2019]/g, "'").replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/ff; cd /tmp/ff');
  return machine;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["echo 'scale=20; s(1); c(1); a(1); l(2); e(1); j(2,3)' | bc -l", ".84147098480789650665\n.54030230586813971740\n.78539816339744830961\n.69314718055994530941\n2.71828182845904523536\n.48609126058589107690\n[0]"],
  ["echo 's(1)' | bc -l", ".84147098480789650665\n[0]"],
  ["echo 'e(10)' | bc -l", "22026.46579480671651695790\n[0]"],
  ["echo 'l(1000)' | bc -l", "6.90775527898213705205\n[0]"],
  ["echo 'scale=50; a(1)*4' | bc -l", "3.14159265358979323846264338327950288419716939937508\n[0]"],
  ["echo 'scale=30; e(1)' | bc -l", "2.718281828459045235360287471352\n[0]"],
  ["echo 'scale=10; s(3.14159265)' | bc -l", ".0000000035\n[0]"],
  ["echo 'scale=10; c(0)' | bc -l", "1.0000000000\n[0]"],
  ["echo 'scale=5; j(0,1)' | bc -l", ".76519\n[0]"],
  ["echo 'scale=40; l(10)' | bc -l", "2.3025850929940456840179914546843642076011\n[0]"],
  ["echo 'scale=15; s(-2)' | bc -l", "-.909297426825681\n[0]"],
  ["echo 'scale=15; c(100)' | bc -l", ".862318872287683\n[0]"],
  ["echo 'scale=15; a(-5)' | bc -l", "-1.373400766945015\n[0]"],
  ["echo 'scale=15; a(0.1)' | bc -l", ".099668652491162\n[0]"],
  ["echo 'scale=15; e(-3)' | bc -l", ".049787068367863\n[0]"],
  ["echo 'scale=15; e(0.5)' | bc -l", "1.648721270700128\n[0]"],
  ["echo 'scale=15; l(0.5)' | bc -l", "-.693147180559945\n[0]"],
  ["echo 'scale=15; l(0)' | bc -l", "-999999999999999.000000000000000\n[0]"],
  ["echo 'scale=15; l(-1)' | bc -l", "-999999999999999.000000000000000\n[0]"],
  ["echo 'scale=8; j(1,2.5)' | bc -l", ".49709410\n[0]"],
  ["echo 'scale=8; j(3,1)' | bc -l", ".01956335\n[0]"],
  ["echo 'scale=8; j(-1,1)' | bc -l", "-.44005058\n[0]"],
  ["echo 'scale=0; e(2)' | bc -l", "7\n[0]"],
  ["echo 'scale=2; s(1)' | bc -l", ".84\n[0]"],
  ["echo 'scale=60; 4*a(1)' | bc -l", "3.141592653589793238462643383279502884197169399375105820974944\n[0]"],
  ["echo 'scale=100; 4*a(1)' | bc -l", "3.141592653589793238462643383279502884197169399375105820974944592307\\\n8164062862089986280348253421170676\n[0]"],
  ["echo 'e(1)' | bc -l", "2.71828182845904523536\n[0]"],
  ["echo '1/3' | bc -l", ".33333333333333333333\n[0]"],
  ["echo 'scale' | bc -l", "20\n[0]"],
  ["echo 'scale=25; sqrt(2)' | bc -l", "1.4142135623730950488016887\n[0]"],
  ["printf 'define f(n){if(n<2)return 1;return n*f(n-1)}\\nf(20)\\nf(30)\\n' | bc", "2432902008176640000\n265252859812191058636308480000000\n[0]"],
  ["printf 'for(i=0;i<3;i++){print i,\"\\\\n\"}\\n' | bc", "0\n1\n2\n[0]"],
  ["printf 'ibase=16;scale=2;.8;FF.8;.1\\n' | bc", ".5\n255.5\n0\n[0]"],
  ["printf 'scale=3;1/3;x=1/3;x\\nobase=2;10.5;scale=0;7\\n' | bc", ".333\n.333\n1010.1000\n111\n[0]"],
  ["echo 'scale=70; 1/3' | bc", ".3333333333333333333333333333333333333333333333333333333333333333333\\\n333\n[0]"],
  ["echo '10^100' | bc", "10000000000000000000000000000000000000000000000000000000000000000000\\\n000000000000000000000000000000000\n[0]"],
  ["printf 'define g(x[]){return x[0]+x[1]}\\nv[0]=3;v[1]=4;g(v[])\\n' | bc", "7\n[0]"],
  ["printf 'define h(n){auto i,s;for(i=1;i<=n;i++)s+=i;return s}\\nh(100)\\n' | bc", "5050\n[0]"],
  ["echo 'if (1) 5 else 6' | bc", "5\n[0]"],
  ["echo 'if (0) 5 else 6' | bc", "6\n[0]"],
  ["printf 'i=3\\nwhile(1){i--;if(i<0)break}\\ni\\n' | bc", "3\n2\n1\n0\n-1\n[0]"],
  ["echo 'x=y=3;x+y' | bc", "6\n[0]"],
  ["echo '(x=5)' | bc", "5\n[0]"],
  ["echo 'x=5' | bc", "[0]"],
  ["echo '2^3^2' | bc", "512\n[0]"],
  ["echo '-2^2' | bc", "4\n[0]"],
  ["echo '2^-2' | bc", "0\n[0]"],
  ["echo '7%3' | bc", "1\n[0]"],
  ["echo 'scale=2;7%3' | bc", ".01\n[0]"],
  ["echo 'scale=2;-7/2' | bc", "-3.50\n[0]"],
  ["echo 'scale=20;-7/2*3' | bc", "-10.50000000000000000000\n[0]"],
  ["printf 'define f(x){\\n  return(x+1)\\n}\\nf(2)\\n' | bc", "3\n[0]"],
  ["printf 'define f(x)\\n{\\n  return(x+1)\\n}\\nf(2)\\n' | bc", "3\n[0]"],
  ["printf 'for(i=1;i<=3;i++){\\nfor(j=1;j<=i;j++) print j,\" \"\\nprint \"\\\\n\"\\n}\\n' | bc", "1 \n1 2 \n1 2 3 \n[0]"],
  ["printf 'a=1\\nb=2\\nc=a+b\\nc\\n1 +\\n2\\n' | bc 2>&1", "3\n(standard_in) 6: syntax error\n2\n[0]"],
  ["printf '1\\n2 +* 3\\n4\\n' | bc 2>&1", "1\n(standard_in) 2: syntax error\n4\n[0]"],
  ["printf 'define f(x){\\nreturn x\\n}\\nf(1)\\nf()\\n' | bc 2>&1", "1\nRuntime error (func=(main), adr=3): Parameter number mismatch\n[0]"],
  ["printf 'x[1]=1\\nx[2]=2\\nx[1]+x[2]\\n' | bc", "3\n[0]"],
  ["printf 'define f(){return 7}\\nf()\\n' | bc", "7\n[0]"],
  ["printf 'define p(n){print n,\"\\\\n\"}\\np(3)\\n' | bc", "3\n0\n[0]"],
  ["printf 'i=0\\nwhile(i<5){i+=1;if(i==3)continue;print i,\" \"}\\nprint \"\\\\n\"\\n' | bc", "1 2 4 5 \n[0]"],
  ["echo 'ibase=2;obase=A;1010' | bc", "10\n[0]"],
  ["echo 'obase=2;255' | bc", "11111111\n[0]"],
  ["echo 'obase=8;255' | bc", "377\n[0]"],
  ["echo 'obase=36;100' | bc", " 02 28\n[0]"],
  ["echo 'scale=5;obase=16;3.14159' | bc", "3.243F3\n[0]"],
  ["echo 'obase=16;-255' | bc", "-FF\n[0]"],
  ["echo 'length(123456)' | bc", "6\n[0]"],
  ["echo 'scale(3.14159)' | bc", "5\n[0]"],
  ["echo 'sqrt(144)' | bc", "12\n[0]"],
  ["echo 'sqrt(0)' | bc", "0\n[0]"],
  ["echo 'scale=5;sqrt(10)' | bc", "3.16227\n[0]"],
  ["echo 'a=2;a^=3;a' | bc", "8\n[0]"],
  ["echo 'a=7;a%=4;a' | bc", "3\n[0]"],
  ["echo 'a=7;a/=2;a' | bc", "3\n[0]"],
  ["echo 'scale=1;a=7;a/=2;a' | bc", "3.5\n[0]"],
  ["echo '!1;!0;!!3' | bc", "0\n1\n1\n[0]"],
  ["echo '1<2&&2<3' | bc", "1\n[0]"],
  ["echo '1>2||0' | bc", "0\n[0]"],
  ["echo '0.1+0.2' | bc", ".3\n[0]"],
  ["echo '3.0*2' | bc", "6.0\n[0]"],
  ["echo '1.5*1.5' | bc", "2.2\n[0]"],
  ["echo 'scale=2;1.5*1.5' | bc", "2.25\n[0]"],
  ["echo 'scale=1;1.5*1.5' | bc", "2.2\n[0]"],
  ["echo '1000000000000*1000000000000' | bc", "1000000000000000000000000\n[0]"],
  ["echo '0.000001*3' | bc", ".000003\n[0]"],
  ["echo '100/3' | bc", "33\n[0]"],
  ["echo 'scale=2;100/3' | bc", "33.33\n[0]"],
  ["echo 'scale=2;-100/3' | bc", "-33.33\n[0]"],
  ["echo 'x=100/3;x' | bc", "33\n[0]"],
  ["echo 'last' | bc", "0\n[0]"],
  ["printf '5\\nlast*2\\n' | bc", "5\n10\n[0]"],
  ["echo 'scale=0; 2^300' | bc", "20370359763344860862684456884093781610514683936659362506361404493543\\\n81299763336706183397376\n[0]"],
  ["echo 'obase=16; 255; 1/3; scale=5; 1/3' | bc", "FF\n0\n.55551\n[0]"],
  ["echo 'obase=100; 12345; 5' | bc", " 01 23 45\n 05\n[0]"],
  ["echo 'ibase=16; FF; A+1' | bc", "255\n11\n[0]"],
  ["echo 'ibase=2; 101' | bc", "5\n[0]"],
  ["echo '1/0' | bc 2>&1", "Runtime error (func=(main), adr=3): Divide by zero\n[0]"],
  ["echo 'x=1;y=2;1%0' | bc 2>&1", "Runtime error (func=(main), adr=13): Modulo by zero\n[0]"],
  ["echo 'f(1)' | bc 2>&1", "Runtime error (func=(main), adr=3): Function f not defined.\n[0]"],
  ["printf 'define f(x){return x*2}\\nf(4)\\nf(1,2)\\n' | bc 2>&1", "8\nRuntime error (func=(main), adr=8): Parameter number mismatch\n[0]"],
  ["echo '1+' | bc 2>&1", "(standard_in) 2: syntax error\n[0]"],
  ["echo '1 +* 2' | bc 2>&1", "(standard_in) 1: syntax error\n[0]"],
  ["echo ')' | bc 2>&1", "(standard_in) 1: syntax error\n[0]"],
  ["echo 'print \"a\",\"b\",1+1,\"\\n\"' | bc 2>&1", "ab2\n[0]"],
  ["printf '3\\n.\\nlast+1\\n. +1\\n' | bc", "3\n3\n4\n5\n[0]"],
  ["echo 'sqrt(2)' | bc", "1\n[0]"],
  ["echo 'scale=3;sqrt(2)' | bc", "1.414\n[0]"],
  ["echo 'sqrt(-1)' | bc 2>&1", "Runtime error (func=(main), adr=4): Square root of a negative number\n[0]"],
  ["printf 'length(1.250)\\nscale(1.250)\\nlength(0)\\nlength(0.001)\\n' | bc", "4\n3\n1\n3\n[0]"],
  ["echo 'a[3]=5; a[3]; a[0]' | bc", "5\n0\n[0]"],
  ["echo 'for(i=0;i<3;i++) i' | bc", "0\n1\n2\n[0]"],
  ["echo 'i=0; while(i<3){ i; i+=1 }' | bc", "0\n1\n2\n[0]"],
  ["printf '1\\nhalt\\n2\\n' | bc", "1\n[0]"],
  ["printf '1\\nquit\\n2\\n' | bc", "1\n[0]"],
  ["echo 'x=5; x++; x; ++x; x--; x' | bc", "5\n6\n7\n7\n6\n[0]"],
  ["printf '1<2\\n2<1\\n1==1\\n1&&0\\n1||0\\n!0\\n!5\\n' | bc", "1\n0\n1\n0\n1\n1\n0\n[0]"],
  ["echo 'scale=5;2^-2' | bc", ".25000\n[0]"],
  ["printf -- '-5\\n- 5\\n' | bc", "-5\n-5\n[0]"],
  ["printf '.5\\n5.\\n0.0\\n-0.5\\n1.0*3\\n' | bc", ".5\n5\n0\n-.5\n3.0\n[0]"],
  ["echo '1 /* c */ + 2 # trailing' | bc", "3\n[0]"],
  ["echo 'limits' | bc", "BC_BASE_MAX     = 2147483647\nBC_DIM_MAX      = 16777215\nBC_SCALE_MAX    = 2147483647\nBC_STRING_MAX   = 2147483647\nMAX Exponent    = 9223372036854775807\nNumber of vars  = 32767\n[0]"],
  ["echo 'scale=0;2^0.5' | bc 2>&1", "Runtime warning (func=(main), adr=12): non-zero scale in exponent\n1\n[0]"],
  ["bc -h", "usage: bc [options] [file ...]\n  -h  --help         print this usage and exit\n  -i  --interactive  force interactive mode\n  -l  --mathlib      use the predefined math routines\n  -q  --quiet        don't print initial banner\n  -s  --standard     non-standard bc constructs are errors\n  -w  --warn         warn about non-standard bc constructs\n  -v  --version      print version information and exit\n[0]"],
  ["bc -v", "bc 1.07.1\nCopyright 1991-1994, 1997, 1998, 2000, 2004, 2006, 2008, 2012-2017 Free Software Foundation, Inc.\n[0]"],
  ["bc -x </dev/null 2>&1", "bc: invalid option -- 'x'\nusage: bc [options] [file ...]\n  -h  --help         print this usage and exit\n  -i  --interactive  force interactive mode\n  -l  --mathlib      use the predefined math routines\n  -q  --quiet        don't print initial banner\n  -s  --standard     non-standard bc constructs are errors\n  -w  --warn         warn about non-standard bc constructs\n  -v  --version      print version information and exit\n[1]"],
  ["bc nosuch </dev/null 2>&1", "File nosuch is unavailable.\n[1]"],
  ["printf '%s\\n' '2/0' | bc 2>&1", "Runtime error (func=(main), adr=5): Divide by zero\n[0]"],
  ["printf '%s\\n' 'x/0' | bc 2>&1", "Runtime error (func=(main), adr=4): Divide by zero\n[0]"],
  ["printf '%s\\n' 'scale=2;1/0' | bc 2>&1", "Runtime error (func=(main), adr=9): Divide by zero\n[0]"],
  ["printf '%s\\n' 'a[1]/0' | bc 2>&1", "Runtime error (func=(main), adr=5): Divide by zero\n[0]"],
  ["printf '%s\\n' '-1/0' | bc 2>&1", "Runtime error (func=(main), adr=4): Divide by zero\n[0]"],
  ["printf '%s\\n' '(1+2)/0' | bc 2>&1", "Runtime error (func=(main), adr=7): Divide by zero\n[0]"],
  ["printf '%s\\n' '1;1/0' | bc 2>&1", "1\nRuntime error (func=(main), adr=5): Divide by zero\n[0]"],
  ["printf '%s\\n' 'x=5;x/0' | bc 2>&1", "Runtime error (func=(main), adr=10): Divide by zero\n[0]"],
  ["printf '%s\\n' '5;6;1/0' | bc 2>&1", "5\n6\nRuntime error (func=(main), adr=11): Divide by zero\n[0]"],
  ["printf '%s\\n' 'xy=1;1/0' | bc 2>&1", "Runtime error (func=(main), adr=7): Divide by zero\n[0]"],
  ["printf '%s\\n' '10/0' | bc 2>&1", "Runtime error (func=(main), adr=6): Divide by zero\n[0]"],
  ["printf '%s\\n' '1+1/0' | bc 2>&1", "Runtime error (func=(main), adr=4): Divide by zero\n[0]"],
  ["printf '%s\\n' 'sqrt(-2)' | bc 2>&1", "Runtime error (func=(main), adr=6): Square root of a negative number\n[0]"],
  ["printf '%s\\n' 'x=1/0' | bc 2>&1", "Runtime error (func=(main), adr=3): Divide by zero\n[0]"],
  ["printf '%s\\n' '1/(2-2)' | bc 2>&1", "Runtime error (func=(main), adr=9): Divide by zero\n[0]"],
  ["printf '%s\\n' 'abc=1;abc/0' | bc 2>&1", "Runtime error (func=(main), adr=8): Divide by zero\n[0]"],
  ["printf '%s\\n' '2%0' | bc 2>&1", "Runtime error (func=(main), adr=5): Modulo by zero\n[0]"],
  ["printf '%s\\n' 'x%0' | bc 2>&1", "Runtime error (func=(main), adr=4): Modulo by zero\n[0]"],
  ["printf '%s\\n' '2^-1/0' | bc 2>&1", "Runtime error (func=(main), adr=8): Divide by zero\n[0]"],
  ["printf '%s\\n' 'length(1)/0' | bc 2>&1", "Runtime error (func=(main), adr=5): Divide by zero\n[0]"],
  ["printf '%s\\n' '2^0.5' | bc 2>&1", "Runtime warning (func=(main), adr=8): non-zero scale in exponent\n1\n[0]"],
  ["printf '%s\\n' 'scale=0;2^0.5' | bc 2>&1", "Runtime warning (func=(main), adr=12): non-zero scale in exponent\n1\n[0]"],
  ["printf '%s\\n' '1;2;3;4;5;6;7;8;9;10;11;1/0' | bc 2>&1", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\nRuntime error (func=(main), adr=47): Divide by zero\n[0]"],
  ["printf '%s\\n' 'x=3;y=x+1;y/0' | bc 2>&1", "Runtime error (func=(main), adr=17): Divide by zero\n[0]"],
  ["printf '%s\\n' 'a[2]=3;a[2]/0' | bc 2>&1", "Runtime error (func=(main), adr=16): Divide by zero\n[0]"],
  ["printf '%s\\n' '.5/0' | bc 2>&1", "Runtime error (func=(main), adr=6): Divide by zero\n[0]"],
  ["printf '%s\\n' '1.25/0' | bc 2>&1", "Runtime error (func=(main), adr=8): Divide by zero\n[0]"],
  ["printf '%s\\n' 'x++;1/0' | bc 2>&1", "0\nRuntime error (func=(main), adr=8): Divide by zero\n[0]"],
  ["printf '%s\\n' 'x+=2;1/0' | bc 2>&1", "Runtime error (func=(main), adr=12): Divide by zero\n[0]"],
];

describe('bc against the real bc 1.07.1', () => {
  it.each(CASES)('%s', async (line, expected) => {
    const machine = await lab();
    const asRoot = (text: string): Promise<string> => machine.executor.runAsUser('root', () => machine.executeCommand(text));
    const root = line.startsWith('ROOT:');
    const command = line.replace(/^ROOT:/, '');
    await asRoot('cd /tmp/ff; chmod -R u+rwx /tmp/ff; rm -rf /tmp/ff/*');
    if (root) await asRoot(`cd /tmp/ff; ${SETUP}`); else await machine.executeCommand(`cd /tmp/ff; ${SETUP}`);
    const script = `cd /tmp/ff; ${command} 2>&1; echo "[$?]"`;
    const answer = root ? await asRoot(script) : await machine.executeCommand(script);
    expect(normalise(answer)).toBe(expected);
  });
});
