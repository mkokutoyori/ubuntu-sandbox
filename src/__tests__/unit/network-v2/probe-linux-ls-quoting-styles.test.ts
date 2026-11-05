/*
/*
 * ls --quoting-style: shell, shell-always, shell-escape, shell-escape-always, locale and clocale were
 * stored and then rendered as literal or c. lsQuoteShell ports the gnulib rules measured on the real ls
 * 9.4 (single quotes with '\'' for an apostrophe, double quotes when the only special character is the
 * apostrophe and nothing needs escaping inside them, $'\n' runs in the escape styles, leading # ~ =,
 * the leading space that aligns unquoted names in long and column listings once one name is quoted);
 * locale and clocale follow the active quote characters; c-maybe quotes only what needs escaping; escape no
 * longer escapes the double quote; style names are matched by unique prefix, an ambiguous one is refused
 * with exit status 1; directory headings are quoted like the entries; --hide-control-chars applies to the
 * shell styles; ls usage errors exit 2.
 *
 * Every expected string was produced by the real GNU coreutils 9.4 of the dev container, by running
 * the identical line in bash with LC_ALL=C.UTF-8 (typographic quotes normalised, scratch directory
 * rewritten to /tmp/ff). Names are chosen so that the host's C collation and the simulator's locale sort
 * them alike. A literal tab in a column listing (width of a control character) is not pinned.
 *
 * Measured against the commit before (worktree): 79 of 109 cases fall.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const SETUP = "mkdir -p qd lead dd; cd qd; touch -- aplain 'b c' \"c'd\" 'd\"e' $'e\\tf' 'f$x' 'g*' 'h\\i' 'i;j' 'j=k' 'k&l' \"l'#\" \"m's#\" \"n's b\" \"o's9\" 'p{q' \"q's}\" 'r%s' 's~t' 't#u' 'u,v' 'v]w' 'w[x' \"x'\\\"y\" $'z\\nw' 'zz!' ; cd ..; touch lead/zz 'lead/y y'; touch -- '#h' '~t' '=eq' '-dash' 'plain'";

const normalise = (text: string): string => text.replace(/[\u2018\u2019]/g, "'").replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/ff; cd /tmp/ff');
  return machine;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["ls -1 --quoting-style=literal qd", "aplain\nb c\nc'd\nd\"e\ne\tf\nf$x\ng*\nh\\i\ni;j\nj=k\nk&l\nl'#\nm's#\nn's b\no's9\np{q\nq's}\nr%s\ns~t\nt#u\nu,v\nv]w\nw[x\nx'\"y\nz\nw\nzz!\n[0]"],
  ["ls -l --quoting-style=literal qd | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", "total 0\n aplain\n b c\n c'd\n d\"e\n e\tf\n f$x\n g*\n h\\i\n i;j\n j=k\n k&l\n l'#\n m's#\n n's b\n o's9\n p{q\n q's}\n r%s\n s~t\n t#u\n u,v\n v]w\n w[x\n x'\"y\n z\nw\n zz!\n[0]"],
  ["ls -m --quoting-style=literal qd", "aplain, b c, c'd, d\"e, e\tf, f$x, g*, h\\i, i;j, j=k, k&l, l'#, m's#, n's b, o's9,\np{q, q's}, r%s, s~t, t#u, u,v, v]w, w[x, x'\"y, z\nw, zz!\n[0]"],
  ["ls -x -w 40 --quoting-style=literal qd", "aplain\tb c    c'd   d\"e  e\tf\tf$x\ng*\th\\i    i;j   j=k  k&l\tl'#\nm's#\tn's b  o's9  p{q  q's}\tr%s\ns~t\tt#u    u,v   v]w  w[x\tx'\"y\nz\nw\tzz!\n[0]"],
  ["ls -R -1 --quoting-style=literal lead", "lead:\ny y\nzz\n[0]"],
  ["ls -1dU --quoting-style=literal -- '#h' '~t' '=eq' '-dash' plain", "#h\n~t\n=eq\n-dash\nplain\n[0]"],
  ["ls -ld --quoting-style=literal -- plain | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " plain\n[0]"],
  ["ls -ld --quoting-style=literal -- '#h' | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " #h\n[0]"],
  ["ls -1 --quoting-style=shell qd", "aplain\n'b c'\n\"c'd\"\n'd\"e'\n'e\tf'\n'f$x'\n'g*'\n'h\\i'\n'i;j'\n'j=k'\n'k&l'\n'l'\\''#'\n'm'\\''s#'\n\"n's b\"\n\"o's9\"\np{q\n'q'\\''s}'\nr%s\ns~t\nt#u\nu,v\nv]w\n'w[x'\n'x'\\''\"y'\n'z\nw'\n'zz!'\n[0]"],
  ["ls -l --quoting-style=shell qd | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", "total 0\n  aplain\n 'b c'\n \"c'd\"\n 'd\"e'\n 'e\tf'\n 'f$x'\n 'g*'\n 'h\\i'\n 'i;j'\n 'j=k'\n 'k&l'\n 'l'\\''#'\n 'm'\\''s#'\n \"n's b\"\n \"o's9\"\n  p{q\n 'q'\\''s}'\n  r%s\n  s~t\n  t#u\n  u,v\n  v]w\n 'w[x'\n 'x'\\''\"y'\n 'z\nw'\n 'zz!'\n[0]"],
  ["ls -m --quoting-style=shell qd", "aplain, 'b c', \"c'd\", 'd\"e', 'e\tf', 'f$x', 'g*', 'h\\i', 'i;j', 'j=k', 'k&l',\n'l'\\''#', 'm'\\''s#', \"n's b\", \"o's9\", p{q, 'q'\\''s}', r%s, s~t, t#u, u,v, v]w,\n'w[x', 'x'\\''\"y', 'z\nw', 'zz!'\n[0]"],
  ["ls -x -w 40 --quoting-style=shell qd", " aplain    'b c'    \"c'd\"   'd\"e'\n'e\tf'\t   'f$x'    'g*'    'h\\i'\n'i;j'\t   'j=k'    'k&l'   'l'\\''#'\n'm'\\''s#'  \"n's b\"  \"o's9\"   p{q\n'q'\\''s}'   r%s      s~t     t#u\n u,v\t    v]w     'w[x'   'x'\\''\"y'\n'z\nw'\t   'zz!'\n[0]"],
  ["ls -C -w 50 --quoting-style=shell qd", " aplain  'g*'\t   'm'\\''s#'   s~t\t 'z\nw'\n'b c'\t 'h\\i'\t   \"n's b\"     t#u\t 'zz!'\n\"c'd\"\t 'i;j'\t   \"o's9\"      u,v\n'd\"e'\t 'j=k'\t    p{q        v]w\n'e\tf'\t 'k&l'\t   'q'\\''s}'  'w[x'\n'f$x'\t 'l'\\''#'   r%s       'x'\\''\"y'\n[0]"],
  ["ls -R -1 --quoting-style=shell lead", "lead:\n'y y'\nzz\n[0]"],
  ["ls -1dU --quoting-style=shell -- '#h' '~t' '=eq' '-dash' plain", "'#h'\n'~t'\n'=eq'\n-dash\nplain\n[0]"],
  ["ls -ld --quoting-style=shell -- plain | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " plain\n[0]"],
  ["ls -ld --quoting-style=shell -- '#h' | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " '#h'\n[0]"],
  ["ls -1 --quoting-style=shell-always qd", "'aplain'\n'b c'\n\"c'd\"\n'd\"e'\n'e\tf'\n'f$x'\n'g*'\n'h\\i'\n'i;j'\n'j=k'\n'k&l'\n'l'\\''#'\n'm'\\''s#'\n\"n's b\"\n\"o's9\"\n'p{q'\n'q'\\''s}'\n'r%s'\n's~t'\n't#u'\n'u,v'\n'v]w'\n'w[x'\n'x'\\''\"y'\n'z\nw'\n'zz!'\n[0]"],
  ["ls -l --quoting-style=shell-always qd | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", "total 0\n 'aplain'\n 'b c'\n \"c'd\"\n 'd\"e'\n 'e\tf'\n 'f$x'\n 'g*'\n 'h\\i'\n 'i;j'\n 'j=k'\n 'k&l'\n 'l'\\''#'\n 'm'\\''s#'\n \"n's b\"\n \"o's9\"\n 'p{q'\n 'q'\\''s}'\n 'r%s'\n 's~t'\n 't#u'\n 'u,v'\n 'v]w'\n 'w[x'\n 'x'\\''\"y'\n 'z\nw'\n 'zz!'\n[0]"],
  ["ls -m --quoting-style=shell-always qd", "'aplain', 'b c', \"c'd\", 'd\"e', 'e\tf', 'f$x', 'g*', 'h\\i', 'i;j', 'j=k', 'k&l',\n'l'\\''#', 'm'\\''s#', \"n's b\", \"o's9\", 'p{q', 'q'\\''s}', 'r%s', 's~t', 't#u',\n'u,v', 'v]w', 'w[x', 'x'\\''\"y', 'z\nw', 'zz!'\n[0]"],
  ["ls -x -w 40 --quoting-style=shell-always qd", "'aplain'   'b c'    \"c'd\"   'd\"e'\n'e\tf'\t   'f$x'    'g*'    'h\\i'\n'i;j'\t   'j=k'    'k&l'   'l'\\''#'\n'm'\\''s#'  \"n's b\"  \"o's9\"  'p{q'\n'q'\\''s}'  'r%s'    's~t'   't#u'\n'u,v'\t   'v]w'    'w[x'   'x'\\''\"y'\n'z\nw'\t   'zz!'\n[0]"],
  ["ls -C -w 50 --quoting-style=shell-always qd", "'aplain'  'g*'\t    'm'\\''s#'  's~t'\t  'z\nw'\n'b c'\t  'h\\i'     \"n's b\"    't#u'\t  'zz!'\n\"c'd\"\t  'i;j'     \"o's9\"     'u,v'\n'd\"e'\t  'j=k'     'p{q'      'v]w'\n'e\tf'\t  'k&l'     'q'\\''s}'  'w[x'\n'f$x'\t  'l'\\''#'  'r%s'      'x'\\''\"y'\n[0]"],
  ["ls -R -1 --quoting-style=shell-always lead", "'lead':\n'y y'\n'zz'\n[0]"],
  ["ls -1dU --quoting-style=shell-always -- '#h' '~t' '=eq' '-dash' plain", "'#h'\n'~t'\n'=eq'\n'-dash'\n'plain'\n[0]"],
  ["ls -ld --quoting-style=shell-always -- plain | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " 'plain'\n[0]"],
  ["ls -ld --quoting-style=shell-always -- '#h' | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " '#h'\n[0]"],
  ["ls -1 --quoting-style=shell-escape qd", "aplain\n'b c'\n\"c'd\"\n'd\"e'\n'e'$'\\t''f'\n'f$x'\n'g*'\n'h\\i'\n'i;j'\n'j=k'\n'k&l'\n'l'\\''#'\n'm'\\''s#'\n\"n's b\"\n\"o's9\"\np{q\n'q'\\''s}'\nr%s\ns~t\nt#u\nu,v\nv]w\n'w[x'\n'x'\\''\"y'\n'z'$'\\n''w'\n'zz!'\n[0]"],
  ["ls -l --quoting-style=shell-escape qd | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", "total 0\n  aplain\n 'b c'\n \"c'd\"\n 'd\"e'\n 'e'$'\\t''f'\n 'f$x'\n 'g*'\n 'h\\i'\n 'i;j'\n 'j=k'\n 'k&l'\n 'l'\\''#'\n 'm'\\''s#'\n \"n's b\"\n \"o's9\"\n  p{q\n 'q'\\''s}'\n  r%s\n  s~t\n  t#u\n  u,v\n  v]w\n 'w[x'\n 'x'\\''\"y'\n 'z'$'\\n''w'\n 'zz!'\n[0]"],
  ["ls -m --quoting-style=shell-escape qd", "aplain, 'b c', \"c'd\", 'd\"e', 'e'$'\\t''f', 'f$x', 'g*', 'h\\i', 'i;j', 'j=k',\n'k&l', 'l'\\''#', 'm'\\''s#', \"n's b\", \"o's9\", p{q, 'q'\\''s}', r%s, s~t, t#u, u,v,\nv]w, 'w[x', 'x'\\''\"y', 'z'$'\\n''w', 'zz!'\n[0]"],
  ["ls -x -w 40 --quoting-style=shell-escape qd", " aplain      'b c'    \"c'd\"   'd\"e'\n'e'$'\\t''f'  'f$x'    'g*'    'h\\i'\n'i;j'\t     'j=k'    'k&l'   'l'\\''#'\n'm'\\''s#'    \"n's b\"  \"o's9\"   p{q\n'q'\\''s}'     r%s      s~t     t#u\n u,v\t      v]w     'w[x'   'x'\\''\"y'\n'z'$'\\n''w'  'zz!'\n[0]"],
  ["ls -C -w 50 --quoting-style=shell-escape qd", " aplain      'h\\i'\t\"o's9\"\t    v]w\n'b c'\t     'i;j'\t p{q\t   'w[x'\n\"c'd\"\t     'j=k'\t'q'\\''s}'  'x'\\''\"y'\n'd\"e'\t     'k&l'\t r%s\t   'z'$'\\n''w'\n'e'$'\\t''f'  'l'\\''#'\t s~t\t   'zz!'\n'f$x'\t     'm'\\''s#'\t t#u\n'g*'\t     \"n's b\"\t u,v\n[0]"],
  ["ls -R -1 --quoting-style=shell-escape lead", "lead:\n'y y'\nzz\n[0]"],
  ["ls -1dU --quoting-style=shell-escape -- '#h' '~t' '=eq' '-dash' plain", "'#h'\n'~t'\n'=eq'\n-dash\nplain\n[0]"],
  ["ls -ld --quoting-style=shell-escape -- plain | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " plain\n[0]"],
  ["ls -ld --quoting-style=shell-escape -- '#h' | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " '#h'\n[0]"],
  ["ls -1 --quoting-style=shell-escape-always qd", "'aplain'\n'b c'\n\"c'd\"\n'd\"e'\n'e'$'\\t''f'\n'f$x'\n'g*'\n'h\\i'\n'i;j'\n'j=k'\n'k&l'\n'l'\\''#'\n'm'\\''s#'\n\"n's b\"\n\"o's9\"\n'p{q'\n'q'\\''s}'\n'r%s'\n's~t'\n't#u'\n'u,v'\n'v]w'\n'w[x'\n'x'\\''\"y'\n'z'$'\\n''w'\n'zz!'\n[0]"],
  ["ls -l --quoting-style=shell-escape-always qd | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", "total 0\n 'aplain'\n 'b c'\n \"c'd\"\n 'd\"e'\n 'e'$'\\t''f'\n 'f$x'\n 'g*'\n 'h\\i'\n 'i;j'\n 'j=k'\n 'k&l'\n 'l'\\''#'\n 'm'\\''s#'\n \"n's b\"\n \"o's9\"\n 'p{q'\n 'q'\\''s}'\n 'r%s'\n 's~t'\n 't#u'\n 'u,v'\n 'v]w'\n 'w[x'\n 'x'\\''\"y'\n 'z'$'\\n''w'\n 'zz!'\n[0]"],
  ["ls -m --quoting-style=shell-escape-always qd", "'aplain', 'b c', \"c'd\", 'd\"e', 'e'$'\\t''f', 'f$x', 'g*', 'h\\i', 'i;j', 'j=k',\n'k&l', 'l'\\''#', 'm'\\''s#', \"n's b\", \"o's9\", 'p{q', 'q'\\''s}', 'r%s', 's~t',\n't#u', 'u,v', 'v]w', 'w[x', 'x'\\''\"y', 'z'$'\\n''w', 'zz!'\n[0]"],
  ["ls -x -w 40 --quoting-style=shell-escape-always qd", "'aplain'     'b c'    \"c'd\"   'd\"e'\n'e'$'\\t''f'  'f$x'    'g*'    'h\\i'\n'i;j'\t     'j=k'    'k&l'   'l'\\''#'\n'm'\\''s#'    \"n's b\"  \"o's9\"  'p{q'\n'q'\\''s}'    'r%s'    's~t'   't#u'\n'u,v'\t     'v]w'    'w[x'   'x'\\''\"y'\n'z'$'\\n''w'  'zz!'\n[0]"],
  ["ls -C -w 50 --quoting-style=shell-escape-always qd", "'aplain'     'h\\i'\t\"o's9\"\t   'v]w'\n'b c'\t     'i;j'\t'p{q'\t   'w[x'\n\"c'd\"\t     'j=k'\t'q'\\''s}'  'x'\\''\"y'\n'd\"e'\t     'k&l'\t'r%s'\t   'z'$'\\n''w'\n'e'$'\\t''f'  'l'\\''#'\t's~t'\t   'zz!'\n'f$x'\t     'm'\\''s#'\t't#u'\n'g*'\t     \"n's b\"\t'u,v'\n[0]"],
  ["ls -R -1 --quoting-style=shell-escape-always lead", "'lead':\n'y y'\n'zz'\n[0]"],
  ["ls -1dU --quoting-style=shell-escape-always -- '#h' '~t' '=eq' '-dash' plain", "'#h'\n'~t'\n'=eq'\n'-dash'\n'plain'\n[0]"],
  ["ls -ld --quoting-style=shell-escape-always -- plain | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " 'plain'\n[0]"],
  ["ls -ld --quoting-style=shell-escape-always -- '#h' | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " '#h'\n[0]"],
  ["ls -1 --quoting-style=c qd", "\"aplain\"\n\"b c\"\n\"c'd\"\n\"d\\\"e\"\n\"e\\tf\"\n\"f$x\"\n\"g*\"\n\"h\\\\i\"\n\"i;j\"\n\"j=k\"\n\"k&l\"\n\"l'#\"\n\"m's#\"\n\"n's b\"\n\"o's9\"\n\"p{q\"\n\"q's}\"\n\"r%s\"\n\"s~t\"\n\"t#u\"\n\"u,v\"\n\"v]w\"\n\"w[x\"\n\"x'\\\"y\"\n\"z\\nw\"\n\"zz!\"\n[0]"],
  ["ls -l --quoting-style=c qd | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", "total 0\n \"aplain\"\n \"b c\"\n \"c'd\"\n \"d\\\"e\"\n \"e\\tf\"\n \"f$x\"\n \"g*\"\n \"h\\\\i\"\n \"i;j\"\n \"j=k\"\n \"k&l\"\n \"l'#\"\n \"m's#\"\n \"n's b\"\n \"o's9\"\n \"p{q\"\n \"q's}\"\n \"r%s\"\n \"s~t\"\n \"t#u\"\n \"u,v\"\n \"v]w\"\n \"w[x\"\n \"x'\\\"y\"\n \"z\\nw\"\n \"zz!\"\n[0]"],
  ["ls -m --quoting-style=c qd", "\"aplain\", \"b c\", \"c'd\", \"d\\\"e\", \"e\\tf\", \"f$x\", \"g*\", \"h\\\\i\", \"i;j\", \"j=k\",\n\"k&l\", \"l'#\", \"m's#\", \"n's b\", \"o's9\", \"p{q\", \"q's}\", \"r%s\", \"s~t\", \"t#u\",\n\"u,v\", \"v]w\", \"w[x\", \"x'\\\"y\", \"z\\nw\", \"zz!\"\n[0]"],
  ["ls -x -w 40 --quoting-style=c qd", "\"aplain\"  \"b c\"    \"c'd\"   \"d\\\"e\"\n\"e\\tf\"\t  \"f$x\"    \"g*\"    \"h\\\\i\"\n\"i;j\"\t  \"j=k\"    \"k&l\"   \"l'#\"\n\"m's#\"\t  \"n's b\"  \"o's9\"  \"p{q\"\n\"q's}\"\t  \"r%s\"    \"s~t\"   \"t#u\"\n\"u,v\"\t  \"v]w\"    \"w[x\"   \"x'\\\"y\"\n\"z\\nw\"\t  \"zz!\"\n[0]"],
  ["ls -C -w 50 --quoting-style=c qd", "\"aplain\"  \"f$x\"   \"k&l\"    \"p{q\"   \"u,v\"    \"zz!\"\n\"b c\"\t  \"g*\"\t  \"l'#\"    \"q's}\"  \"v]w\"\n\"c'd\"\t  \"h\\\\i\"  \"m's#\"   \"r%s\"   \"w[x\"\n\"d\\\"e\"\t  \"i;j\"   \"n's b\"  \"s~t\"   \"x'\\\"y\"\n\"e\\tf\"\t  \"j=k\"   \"o's9\"   \"t#u\"   \"z\\nw\"\n[0]"],
  ["ls -R -1 --quoting-style=c lead", "\"lead\":\n\"y y\"\n\"zz\"\n[0]"],
  ["ls -1dU --quoting-style=c -- '#h' '~t' '=eq' '-dash' plain", "\"#h\"\n\"~t\"\n\"=eq\"\n\"-dash\"\n\"plain\"\n[0]"],
  ["ls -ld --quoting-style=c -- plain | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " \"plain\"\n[0]"],
  ["ls -ld --quoting-style=c -- '#h' | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " \"#h\"\n[0]"],
  ["ls -1 --quoting-style=c-maybe qd", "aplain\nb c\nc'd\n\"d\\\"e\"\n\"e\\tf\"\nf$x\ng*\nh\\i\ni;j\nj=k\nk&l\nl'#\nm's#\nn's b\no's9\np{q\nq's}\nr%s\ns~t\nt#u\nu,v\nv]w\nw[x\n\"x'\\\"y\"\n\"z\\nw\"\nzz!\n[0]"],
  ["ls -l --quoting-style=c-maybe qd | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", "total 0\n  aplain\n  b c\n  c'd\n \"d\\\"e\"\n \"e\\tf\"\n  f$x\n  g*\n  h\\i\n  i;j\n  j=k\n  k&l\n  l'#\n  m's#\n  n's b\n  o's9\n  p{q\n  q's}\n  r%s\n  s~t\n  t#u\n  u,v\n  v]w\n  w[x\n \"x'\\\"y\"\n \"z\\nw\"\n  zz!\n[0]"],
  ["ls -m --quoting-style=c-maybe qd", "aplain, b c, c'd, \"d\\\"e\", \"e\\tf\", f$x, g*, h\\i, i;j, j=k, k&l, l'#, m's#, n's b,\no's9, p{q, q's}, r%s, s~t, t#u, u,v, v]w, w[x, \"x'\\\"y\", \"z\\nw\", zz!\n[0]"],
  ["ls -x -w 40 --quoting-style=c-maybe qd", " aplain   b c\t c'd   \"d\\\"e\"\t\"e\\tf\"\n f$x\t  g*\t h\\i    i;j\t j=k\n k&l\t  l'#\t m's#   n's b\t o's9\n p{q\t  q's}\t r%s    s~t\t t#u\n u,v\t  v]w\t w[x   \"x'\\\"y\"\t\"z\\nw\"\n zz!\n[0]"],
  ["ls -C -w 50 --quoting-style=c-maybe qd", " aplain   f$x   k&l     p{q    u,v      zz!\n b c\t  g*    l'#     q's}   v]w\n c'd\t  h\\i   m's#    r%s    w[x\n\"d\\\"e\"\t  i;j   n's b   s~t   \"x'\\\"y\"\n\"e\\tf\"\t  j=k   o's9    t#u   \"z\\nw\"\n[0]"],
  ["ls -R -1 --quoting-style=c-maybe lead", "lead:\ny y\nzz\n[0]"],
  ["ls -1dU --quoting-style=c-maybe -- '#h' '~t' '=eq' '-dash' plain", "#h\n~t\n=eq\n-dash\nplain\n[0]"],
  ["ls -ld --quoting-style=c-maybe -- plain | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " plain\n[0]"],
  ["ls -ld --quoting-style=c-maybe -- '#h' | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " #h\n[0]"],
  ["ls -1 --quoting-style=escape qd", "aplain\nb\\ c\nc'd\nd\"e\ne\\tf\nf$x\ng*\nh\\\\i\ni;j\nj=k\nk&l\nl'#\nm's#\nn's\\ b\no's9\np{q\nq's}\nr%s\ns~t\nt#u\nu,v\nv]w\nw[x\nx'\"y\nz\\nw\nzz!\n[0]"],
  ["ls -l --quoting-style=escape qd | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", "total 0\n aplain\n b\\ c\n c'd\n d\"e\n e\\tf\n f$x\n g*\n h\\\\i\n i;j\n j=k\n k&l\n l'#\n m's#\n n's\\ b\n o's9\n p{q\n q's}\n r%s\n s~t\n t#u\n u,v\n v]w\n w[x\n x'\"y\n z\\nw\n zz!\n[0]"],
  ["ls -m --quoting-style=escape qd", "aplain, b\\ c, c'd, d\"e, e\\tf, f$x, g*, h\\\\i, i;j, j=k, k&l, l'#, m's#, n's\\ b,\no's9, p{q, q's}, r%s, s~t, t#u, u,v, v]w, w[x, x'\"y, z\\nw, zz!\n[0]"],
  ["ls -x -w 40 --quoting-style=escape qd", "aplain\tb\\ c\tc'd   d\"e  e\\tf  f$x\ng*\th\\\\i\ti;j   j=k  k&l\t l'#\nm's#\tn's\\ b\to's9  p{q  q's}  r%s\ns~t\tt#u\tu,v   v]w  w[x\t x'\"y\nz\\nw\tzz!\n[0]"],
  ["ls -C -w 50 --quoting-style=escape qd", "aplain\te\\tf  i;j  m's#    q's}  u,v   z\\nw\nb\\ c\tf$x   j=k  n's\\ b  r%s\t v]w   zz!\nc'd\tg*    k&l  o's9    s~t\t w[x\nd\"e\th\\\\i  l'#  p{q\t   t#u\t x'\"y\n[0]"],
  ["ls -R -1 --quoting-style=escape lead", "lead:\ny\\ y\nzz\n[0]"],
  ["ls -1dU --quoting-style=escape -- '#h' '~t' '=eq' '-dash' plain", "#h\n~t\n=eq\n-dash\nplain\n[0]"],
  ["ls -ld --quoting-style=escape -- plain | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " plain\n[0]"],
  ["ls -ld --quoting-style=escape -- '#h' | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " #h\n[0]"],
  ["ls -1 --quoting-style=locale qd", "'aplain'\n'b c'\n'c'd'\n'd\"e'\n'e\\tf'\n'f$x'\n'g*'\n'h\\\\i'\n'i;j'\n'j=k'\n'k&l'\n'l'#'\n'm's#'\n'n's b'\n'o's9'\n'p{q'\n'q's}'\n'r%s'\n's~t'\n't#u'\n'u,v'\n'v]w'\n'w[x'\n'x'\"y'\n'z\\nw'\n'zz!'\n[0]"],
  ["ls -l --quoting-style=locale qd | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", "total 0\n 'aplain'\n 'b c'\n 'c'd'\n 'd\"e'\n 'e\\tf'\n 'f$x'\n 'g*'\n 'h\\\\i'\n 'i;j'\n 'j=k'\n 'k&l'\n 'l'#'\n 'm's#'\n 'n's b'\n 'o's9'\n 'p{q'\n 'q's}'\n 'r%s'\n 's~t'\n 't#u'\n 'u,v'\n 'v]w'\n 'w[x'\n 'x'\"y'\n 'z\\nw'\n 'zz!'\n[0]"],
  ["ls -m --quoting-style=locale qd", "'aplain', 'b c', 'c'd', 'd\"e', 'e\\tf', 'f$x', 'g*', 'h\\\\i', 'i;j', 'j=k', 'k&l',\n'l'#', 'm's#', 'n's b', 'o's9', 'p{q', 'q's}', 'r%s', 's~t', 't#u', 'u,v',\n'v]w', 'w[x', 'x'\"y', 'z\\nw', 'zz!'\n[0]"],
  ["ls -x -w 40 --quoting-style=locale qd", "'aplain'  'b c'    'c'd'   'd\"e'\n'e\\tf'\t  'f$x'    'g*'    'h\\\\i'\n'i;j'\t  'j=k'    'k&l'   'l'#'\n'm's#'\t  'n's b'  'o's9'  'p{q'\n'q's}'\t  'r%s'    's~t'   't#u'\n'u,v'\t  'v]w'    'w[x'   'x'\"y'\n'z\\nw'\t  'zz!'\n[0]"],
  ["ls -C -w 50 --quoting-style=locale qd", "'aplain'  'f$x'   'k&l'    'p{q'   'u,v'   'zz!'\n'b c'\t  'g*'\t  'l'#'    'q's}'  'v]w'\n'c'd'\t  'h\\\\i'  'm's#'   'r%s'   'w[x'\n'd\"e'\t  'i;j'   'n's b'  's~t'   'x'\"y'\n'e\\tf'\t  'j=k'   'o's9'   't#u'   'z\\nw'\n[0]"],
  ["ls -R -1 --quoting-style=locale lead", "'lead':\n'y y'\n'zz'\n[0]"],
  ["ls -1dU --quoting-style=locale -- '#h' '~t' '=eq' '-dash' plain", "'#h'\n'~t'\n'=eq'\n'-dash'\n'plain'\n[0]"],
  ["ls -ld --quoting-style=locale -- plain | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " 'plain'\n[0]"],
  ["ls -ld --quoting-style=locale -- '#h' | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " '#h'\n[0]"],
  ["ls -1 --quoting-style=clocale qd", "'aplain'\n'b c'\n'c'd'\n'd\"e'\n'e\\tf'\n'f$x'\n'g*'\n'h\\\\i'\n'i;j'\n'j=k'\n'k&l'\n'l'#'\n'm's#'\n'n's b'\n'o's9'\n'p{q'\n'q's}'\n'r%s'\n's~t'\n't#u'\n'u,v'\n'v]w'\n'w[x'\n'x'\"y'\n'z\\nw'\n'zz!'\n[0]"],
  ["ls -l --quoting-style=clocale qd | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", "total 0\n 'aplain'\n 'b c'\n 'c'd'\n 'd\"e'\n 'e\\tf'\n 'f$x'\n 'g*'\n 'h\\\\i'\n 'i;j'\n 'j=k'\n 'k&l'\n 'l'#'\n 'm's#'\n 'n's b'\n 'o's9'\n 'p{q'\n 'q's}'\n 'r%s'\n 's~t'\n 't#u'\n 'u,v'\n 'v]w'\n 'w[x'\n 'x'\"y'\n 'z\\nw'\n 'zz!'\n[0]"],
  ["ls -m --quoting-style=clocale qd", "'aplain', 'b c', 'c'd', 'd\"e', 'e\\tf', 'f$x', 'g*', 'h\\\\i', 'i;j', 'j=k', 'k&l',\n'l'#', 'm's#', 'n's b', 'o's9', 'p{q', 'q's}', 'r%s', 's~t', 't#u', 'u,v',\n'v]w', 'w[x', 'x'\"y', 'z\\nw', 'zz!'\n[0]"],
  ["ls -x -w 40 --quoting-style=clocale qd", "'aplain'  'b c'    'c'd'   'd\"e'\n'e\\tf'\t  'f$x'    'g*'    'h\\\\i'\n'i;j'\t  'j=k'    'k&l'   'l'#'\n'm's#'\t  'n's b'  'o's9'  'p{q'\n'q's}'\t  'r%s'    's~t'   't#u'\n'u,v'\t  'v]w'    'w[x'   'x'\"y'\n'z\\nw'\t  'zz!'\n[0]"],
  ["ls -C -w 50 --quoting-style=clocale qd", "'aplain'  'f$x'   'k&l'    'p{q'   'u,v'   'zz!'\n'b c'\t  'g*'\t  'l'#'    'q's}'  'v]w'\n'c'd'\t  'h\\\\i'  'm's#'   'r%s'   'w[x'\n'd\"e'\t  'i;j'   'n's b'  's~t'   'x'\"y'\n'e\\tf'\t  'j=k'   'o's9'   't#u'   'z\\nw'\n[0]"],
  ["ls -R -1 --quoting-style=clocale lead", "'lead':\n'y y'\n'zz'\n[0]"],
  ["ls -1dU --quoting-style=clocale -- '#h' '~t' '=eq' '-dash' plain", "'#h'\n'~t'\n'=eq'\n'-dash'\n'plain'\n[0]"],
  ["ls -ld --quoting-style=clocale -- plain | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " 'plain'\n[0]"],
  ["ls -ld --quoting-style=clocale -- '#h' | sed 's/^.*[0-9][0-9]:[0-9][0-9]//'", " '#h'\n[0]"],
  ["ls --quoting-style=bogus", "ls: invalid argument 'bogus' for '--quoting-style'\nValid arguments are:\n  - 'literal'\n  - 'shell'\n  - 'shell-always'\n  - 'shell-escape'\n  - 'shell-escape-always'\n  - 'c'\n  - 'c-maybe'\n  - 'escape'\n  - 'locale'\n  - 'clocale'\nTry 'ls --help' for more information.\n[1]"],
  ["ls --quoting-style", "ls: option '--quoting-style' requires an argument\nTry 'ls --help' for more information.\n[2]"],
  ["ls --quoting-style=sh", "ls: ambiguous argument 'sh' for '--quoting-style'\nValid arguments are:\n  - 'literal'\n  - 'shell'\n  - 'shell-always'\n  - 'shell-escape'\n  - 'shell-escape-always'\n  - 'c'\n  - 'c-maybe'\n  - 'escape'\n  - 'locale'\n  - 'clocale'\nTry 'ls --help' for more information.\n[1]"],
  ["ls --quoting-style=shell-e", "ls: ambiguous argument 'shell-e' for '--quoting-style'\nValid arguments are:\n  - 'literal'\n  - 'shell'\n  - 'shell-always'\n  - 'shell-escape'\n  - 'shell-escape-always'\n  - 'c'\n  - 'c-maybe'\n  - 'escape'\n  - 'locale'\n  - 'clocale'\nTry 'ls --help' for more information.\n[1]"],
  ["ls -1 -Q qd", "\"aplain\"\n\"b c\"\n\"c'd\"\n\"d\\\"e\"\n\"e\\tf\"\n\"f$x\"\n\"g*\"\n\"h\\\\i\"\n\"i;j\"\n\"j=k\"\n\"k&l\"\n\"l'#\"\n\"m's#\"\n\"n's b\"\n\"o's9\"\n\"p{q\"\n\"q's}\"\n\"r%s\"\n\"s~t\"\n\"t#u\"\n\"u,v\"\n\"v]w\"\n\"w[x\"\n\"x'\\\"y\"\n\"z\\nw\"\n\"zz!\"\n[0]"],
  ["ls -1 -N qd", "aplain\nb c\nc'd\nd\"e\ne\tf\nf$x\ng*\nh\\i\ni;j\nj=k\nk&l\nl'#\nm's#\nn's b\no's9\np{q\nq's}\nr%s\ns~t\nt#u\nu,v\nv]w\nw[x\nx'\"y\nz\nw\nzz!\n[0]"],
  ["ls -1 -b qd", "aplain\nb\\ c\nc'd\nd\"e\ne\\tf\nf$x\ng*\nh\\\\i\ni;j\nj=k\nk&l\nl'#\nm's#\nn's\\ b\no's9\np{q\nq's}\nr%s\ns~t\nt#u\nu,v\nv]w\nw[x\nx'\"y\nz\\nw\nzz!\n[0]"],
  ["ls -1 --quoting-style=shell -Q qd", "\"aplain\"\n\"b c\"\n\"c'd\"\n\"d\\\"e\"\n\"e\\tf\"\n\"f$x\"\n\"g*\"\n\"h\\\\i\"\n\"i;j\"\n\"j=k\"\n\"k&l\"\n\"l'#\"\n\"m's#\"\n\"n's b\"\n\"o's9\"\n\"p{q\"\n\"q's}\"\n\"r%s\"\n\"s~t\"\n\"t#u\"\n\"u,v\"\n\"v]w\"\n\"w[x\"\n\"x'\\\"y\"\n\"z\\nw\"\n\"zz!\"\n[0]"],
  ["ls -1 --quoting-style=shell -N qd", "aplain\nb c\nc'd\nd\"e\ne\tf\nf$x\ng*\nh\\i\ni;j\nj=k\nk&l\nl'#\nm's#\nn's b\no's9\np{q\nq's}\nr%s\ns~t\nt#u\nu,v\nv]w\nw[x\nx'\"y\nz\nw\nzz!\n[0]"],
  ["ls -1 --quoting-style=shell -b qd", "aplain\nb\\ c\nc'd\nd\"e\ne\\tf\nf$x\ng*\nh\\\\i\ni;j\nj=k\nk&l\nl'#\nm's#\nn's\\ b\no's9\np{q\nq's}\nr%s\ns~t\nt#u\nu,v\nv]w\nw[x\nx'\"y\nz\\nw\nzz!\n[0]"],
  ["ls -1 -b --quoting-style=shell qd", "aplain\n'b c'\n\"c'd\"\n'd\"e'\n'e\tf'\n'f$x'\n'g*'\n'h\\i'\n'i;j'\n'j=k'\n'k&l'\n'l'\\''#'\n'm'\\''s#'\n\"n's b\"\n\"o's9\"\np{q\n'q'\\''s}'\nr%s\ns~t\nt#u\nu,v\nv]w\n'w[x'\n'x'\\''\"y'\n'z\nw'\n'zz!'\n[0]"],
  ["ls -1 --quote-name qd", "\"aplain\"\n\"b c\"\n\"c'd\"\n\"d\\\"e\"\n\"e\\tf\"\n\"f$x\"\n\"g*\"\n\"h\\\\i\"\n\"i;j\"\n\"j=k\"\n\"k&l\"\n\"l'#\"\n\"m's#\"\n\"n's b\"\n\"o's9\"\n\"p{q\"\n\"q's}\"\n\"r%s\"\n\"s~t\"\n\"t#u\"\n\"u,v\"\n\"v]w\"\n\"w[x\"\n\"x'\\\"y\"\n\"z\\nw\"\n\"zz!\"\n[0]"],
  ["ls -1 --literal qd", "aplain\nb c\nc'd\nd\"e\ne\tf\nf$x\ng*\nh\\i\ni;j\nj=k\nk&l\nl'#\nm's#\nn's b\no's9\np{q\nq's}\nr%s\ns~t\nt#u\nu,v\nv]w\nw[x\nx'\"y\nz\nw\nzz!\n[0]"],
  ["ls -1 --escape qd", "aplain\nb\\ c\nc'd\nd\"e\ne\\tf\nf$x\ng*\nh\\\\i\ni;j\nj=k\nk&l\nl'#\nm's#\nn's\\ b\no's9\np{q\nq's}\nr%s\ns~t\nt#u\nu,v\nv]w\nw[x\nx'\"y\nz\\nw\nzz!\n[0]"],
  ["ls -1 -q qd", "aplain\nb c\nc'd\nd\"e\ne?f\nf$x\ng*\nh\\i\ni;j\nj=k\nk&l\nl'#\nm's#\nn's b\no's9\np{q\nq's}\nr%s\ns~t\nt#u\nu,v\nv]w\nw[x\nx'\"y\nz?w\nzz!\n[0]"],
  ["ls -1 --hide-control-chars --quoting-style=shell qd", "aplain\n'b c'\n\"c'd\"\n'd\"e'\n'e?f'\n'f$x'\n'g*'\n'h\\i'\n'i;j'\n'j=k'\n'k&l'\n'l'\\''#'\n'm'\\''s#'\n\"n's b\"\n\"o's9\"\np{q\n'q'\\''s}'\nr%s\ns~t\nt#u\nu,v\nv]w\n'w[x'\n'x'\\''\"y'\n'z?w'\n'zz!'\n[0]"],
  ["ls -1 --show-control-chars --quoting-style=shell qd", "aplain\n'b c'\n\"c'd\"\n'd\"e'\n'e\tf'\n'f$x'\n'g*'\n'h\\i'\n'i;j'\n'j=k'\n'k&l'\n'l'\\''#'\n'm'\\''s#'\n\"n's b\"\n\"o's9\"\np{q\n'q'\\''s}'\nr%s\ns~t\nt#u\nu,v\nv]w\n'w[x'\n'x'\\''\"y'\n'z\nw'\n'zz!'\n[0]"],
  ["ls -1 -p --quoting-style=shell qd", "aplain\n'b c'\n\"c'd\"\n'd\"e'\n'e\tf'\n'f$x'\n'g*'\n'h\\i'\n'i;j'\n'j=k'\n'k&l'\n'l'\\''#'\n'm'\\''s#'\n\"n's b\"\n\"o's9\"\np{q\n'q'\\''s}'\nr%s\ns~t\nt#u\nu,v\nv]w\n'w[x'\n'x'\\''\"y'\n'z\nw'\n'zz!'\n[0]"],
  ["ls -1 -F --quoting-style=shell lead", "'y y'\nzz\n[0]"],
  ["ls -1 -i --quoting-style=shell lead | sed 's/^ *[0-9]* //'", "'y y'\nzz\n[0]"],
];

describe('ls quoting styles against the real GNU ls', () => {
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
