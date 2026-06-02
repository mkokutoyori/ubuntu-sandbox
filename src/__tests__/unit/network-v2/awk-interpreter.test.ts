import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

let pc: LinuxPC;

beforeEach(() => {
  pc = new LinuxPC('linux-pc', 'AWKPC');
});

async function sh(cmd: string): Promise<string> {
  return (await pc.executeCommand(cmd)).trim();
}

async function seedCsv(): Promise<void> {
  await pc.executeCommand('printf "John,25,Engineer\\nJane,30,Doctor\\nBob,35,Teacher\\n" > data.csv');
}

describe('awk — fields and records', () => {
  it('prints a single field', async () => {
    const out = await sh("echo 'a b c' | awk '{print $2}'");
    expect(out).toBe('b');
  });

  it('prints $0 by default for a true pattern', async () => {
    const out = await sh("printf 'x\\ny\\n' | awk '/y/'");
    expect(out).toBe('y');
  });

  it('reports NF and NR', async () => {
    const out = await sh("printf 'a b c\\nd e\\n' | awk '{print NR, NF}'");
    expect(out).toBe('1 3\n2 2');
  });

  it('references the last field with $NF', async () => {
    const out = await sh("echo 'one two three' | awk '{print $NF}'");
    expect(out).toBe('three');
  });

  it('supports -F field separator', async () => {
    await seedCsv();
    const out = await sh('awk -F"," \'{print $1}\' data.csv');
    expect(out).toBe('John\nJane\nBob');
  });

  it('rebuilds $0 when a field is reassigned using OFS', async () => {
    const out = await sh("echo 'a b c' | awk 'BEGIN{OFS=\"-\"} {$2=\"X\"; print}'");
    expect(out).toBe('a-X-c');
  });

  it('splits on a multi-char regex FS', async () => {
    const out = await sh("printf 'a::b:::c\\n' | awk -F':+' '{print $2}'");
    expect(out).toBe('b');
  });
});

describe('awk — patterns', () => {
  it('filters numeric comparison as numeric strings', async () => {
    await seedCsv();
    const out = await sh('awk -F"," \'$2 > 30\' data.csv');
    expect(out).toContain('Bob');
    expect(out).not.toContain('John');
  });

  it('matches a regex with ~', async () => {
    const out = await sh("printf 'apple\\nbanana\\ncherry\\n' | awk '$0 ~ /an/ {print}'");
    expect(out).toBe('banana');
  });

  it('negates a regex with !~', async () => {
    const out = await sh("printf 'apple\\nbanana\\n' | awk '$1 !~ /an/'");
    expect(out).toBe('apple');
  });

  it('supports range patterns', async () => {
    const out = await sh("printf '1\\n2\\n3\\n4\\n5\\n' | awk '/2/,/4/'");
    expect(out).toBe('2\n3\n4');
  });

  it('runs BEGIN and END once', async () => {
    const out = await sh("printf 'a\\nb\\n' | awk 'BEGIN{print \"start\"} {print} END{print \"end\"}'");
    expect(out).toBe('start\na\nb\nend');
  });
});

describe('awk — arithmetic and variables', () => {
  it('sums a column in END', async () => {
    await seedCsv();
    const out = await sh('awk -F"," \'{sum += $2} END {print sum}\' data.csv');
    expect(parseInt(out, 10)).toBe(90);
  });

  it('computes averages with NR', async () => {
    const out = await sh("printf '10\\n20\\n30\\n' | awk '{s+=$1} END{print s/NR}'");
    expect(out).toBe('20');
  });

  it('passes -v variables', async () => {
    await seedCsv();
    const out = await sh('awk -F"," -v bonus=5 \'{print $1, $2 + bonus}\' data.csv');
    expect(out).toContain('John 30');
    expect(out).toContain('Bob 40');
  });

  it('handles pre/post increment', async () => {
    const out = await sh("awk 'BEGIN{i=5; print i++, i, ++i}'");
    expect(out).toBe('5 6 7');
  });

  it('exponentiation and modulo', async () => {
    const out = await sh("awk 'BEGIN{print 2^10, 17%5}'");
    expect(out).toBe('1024 2');
  });

  it('ternary expressions', async () => {
    const out = await sh("awk 'BEGIN{x=7; print (x%2==0)?\"even\":\"odd\"}'");
    expect(out).toBe('odd');
  });
});

describe('awk — control flow', () => {
  it('if / else if / else', async () => {
    const out = await sh("printf '95\\n82\\n50\\n' | awk '{ if($1>=90) print \"A\"; else if($1>=80) print \"B\"; else print \"F\" }'");
    expect(out).toBe('A\nB\nF');
  });

  it('C-style for loop', async () => {
    const out = await sh("awk 'BEGIN{ for(i=1;i<=3;i++) s=s i; print s }'");
    expect(out).toBe('123');
  });

  it('while loop with break', async () => {
    const out = await sh("awk 'BEGIN{ i=0; while(1){ i++; if(i==4) break }; print i }'");
    expect(out).toBe('4');
  });

  it('continue skips iterations', async () => {
    const out = await sh("awk 'BEGIN{ for(i=1;i<=5;i++){ if(i%2==0) continue; s+=i }; print s }'");
    expect(out).toBe('9');
  });
});

describe('awk — arrays', () => {
  it('counts occurrences with an associative array', async () => {
    const out = await sh("printf 'a\\nb\\na\\nc\\na\\n' | awk '{c[$1]++} END{print c[\"a\"], c[\"b\"], c[\"c\"]}'");
    expect(out).toBe('3 1 1');
  });

  it('iterates with for-in and the in operator', async () => {
    const out = await sh("awk 'BEGIN{ a[\"x\"]=1; a[\"y\"]=1; n=0; for(k in a) n++; print n, (\"x\" in a), (\"z\" in a) }'");
    expect(out).toBe('2 1 0');
  });

  it('delete removes elements', async () => {
    const out = await sh("awk 'BEGIN{ a[1]=1;a[2]=1; delete a[1]; print (1 in a), (2 in a) }'");
    expect(out).toBe('0 1');
  });
});

describe('awk — string functions', () => {
  it('length, toupper, tolower', async () => {
    const out = await sh("awk 'BEGIN{print length(\"hello\"), toupper(\"ab\"), tolower(\"CD\")}'");
    expect(out).toBe('5 AB cd');
  });

  it('substr with and without length', async () => {
    const out = await sh("awk 'BEGIN{print substr(\"abcdef\",2,3), substr(\"abcdef\",4)}'");
    expect(out).toBe('bcd def');
  });

  it('index returns 1-based position', async () => {
    const out = await sh("awk 'BEGIN{print index(\"abcabc\",\"c\"), index(\"abc\",\"z\")}'");
    expect(out).toBe('3 0');
  });

  it('split returns count and fills the array', async () => {
    const out = await sh("awk 'BEGIN{ n=split(\"a:b:c\",parts,\":\"); print n, parts[1], parts[3] }'");
    expect(out).toBe('3 a c');
  });

  it('gsub substitutes globally and returns the count', async () => {
    const out = await sh("awk 'BEGIN{ s=\"aaa\"; n=gsub(/a/,\"b\",s); print n, s }'");
    expect(out).toBe('3 bbb');
  });

  it('sub substitutes the first match with & backreference', async () => {
    const out = await sh("awk 'BEGIN{ s=\"cat\"; sub(/cat/,\"[&]\",s); print s }'");
    expect(out).toBe('[cat]');
  });

  it('match sets RSTART and RLENGTH', async () => {
    const out = await sh("awk 'BEGIN{ if(match(\"foobar\",/o+/)) print RSTART, RLENGTH }'");
    expect(out).toBe('2 2');
  });

  it('sprintf formats numbers', async () => {
    const out = await sh("awk 'BEGIN{print sprintf(\"%05.2f|%d|%s\", 3.14159, 42, \"hi\")}'");
    expect(out).toBe('03.14|42|hi');
  });
});

describe('awk — printf', () => {
  it('formats a table row', async () => {
    await seedCsv();
    const out = await sh('awk -F"," \'{printf "%-6s %3d\\n", $1, $2}\' data.csv');
    expect(out).toBe('John    25\nJane    30\nBob     35');
  });

  it('formats hex and width', async () => {
    const out = await sh("awk 'BEGIN{printf \"%x %04o\\n\", 255, 8}'");
    expect(out).toBe('ff 0010');
  });
});

describe('awk — user functions', () => {
  it('calls a user-defined function', async () => {
    const out = await sh("awk 'function sq(n){return n*n} BEGIN{print sq(9)}'");
    expect(out).toBe('81');
  });

  it('supports recursion', async () => {
    const out = await sh("awk 'function fib(n){ return n<2 ? n : fib(n-1)+fib(n-2) } BEGIN{print fib(10)}'");
    expect(out).toBe('55');
  });

  it('passes arrays by reference', async () => {
    const out = await sh("awk 'function fill(a){ a[1]=\"set\" } BEGIN{ fill(arr); print arr[1] }'");
    expect(out).toBe('set');
  });
});

describe('awk — output redirection and concat', () => {
  it('redirects print to a file', async () => {
    await pc.executeCommand("awk 'BEGIN{ print \"line1\" > \"out.txt\"; print \"line2\" > \"out.txt\" }'");
    const out = await sh('cat out.txt');
    expect(out).toBe('line1\nline2');
  });

  it('concatenates strings by juxtaposition', async () => {
    const out = await sh("awk 'BEGIN{ a=\"foo\"; b=\"bar\"; print a b \"!\" }'");
    expect(out).toBe('foobar!');
  });

  it('reports a syntax error for malformed programs', async () => {
    const out = await sh("echo x | awk '{ print '");
    expect(out).toMatch(/awk:.*syntax error/i);
  });
});
