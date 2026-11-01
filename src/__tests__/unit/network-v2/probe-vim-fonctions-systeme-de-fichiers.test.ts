/**
 * vim 9.1 : glob, globpath, expand, resolve, fnamemodify (:p :. :~ :s :gs :S), mkdir, writefile, rename, delete, tempname, strptime, reltime*, wordcount ; 115 expressions rejouées sur le vrai vim dans un répertoire de travail /tmp/vx (puis /tmp/vw pour les écritures, rejouées EN SÉQUENCE) ; valeurs relevées sur le vrai vim de cette machine.
 * Mesure de départ : « E117: Unknown function » pour chacune, et fnamemodify ignorait :p :. :~ :s :gs :S. 114 des 121 cas tombent avant (les refus de drapeaux D comptes) ; 7 passent dans les deux états (expressions dont la valeur attendue est celle d'un nom inchangé ou d'une erreur déjà levée, comme fnamemodify("f.txt", "bad")).
 */

import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

class LinkedFs extends InMemoryEditorFsContext {
  private static readonly LINKS: ReadonlyMap<string, string> = new Map([['/tmp/vx/lnk', 'f.txt'], ['/tmp/vx/dl', 'sub']]);

  private through(path: string): string {
    const absolute = this.resolvePath(path);
    for (const [link, target] of LinkedFs.LINKS) {
      if (absolute === link) return `/tmp/vx/${target}`;
      if (absolute.startsWith(`${link}/`)) return `/tmp/vx/${target}${absolute.slice(link.length)}`;
    }
    return absolute;
  }

  override kindOf(path: string) { return super.kindOf(this.through(path)); }
  override readFile(path: string) { return super.readFile(this.through(path)); }
  override listDirectory(path: string) {
    const names = super.listDirectory(this.through(path));
    return names !== null && this.resolvePath(path) === '/tmp/vx' ? [...names, 'dl', 'lnk'] : names;
  }
  override linkInfo(path: string) {
    const absolute = this.resolvePath(path);
    const target = LinkedFs.LINKS.get(absolute);
    if (target !== undefined) return { type: 'symlink', permissions: 0o777, target };
    return super.linkInfo(this.through(path));
  }
}

function makeFs(directory: string, files: Record<string, string>, folders: readonly string[]): InMemoryEditorFsContext {
  const fs = new LinkedFs({ ...files, '/tmp/vt/t.txt': 'x\n' }, () => '', undefined, directory);
  fs.refuseWritesIntoMissingDirectories();
  for (const folder of folders) fs.makeDirectory(folder, 0o755);
  fs.useEnvironmentVariable('HOME', '/root');
  return fs;
}

function evaluator(fs: InMemoryEditorFsContext, directory: string): (expression: string) => string {
  return (expression) => {
    const vim = new VimEngine(fs, '/tmp/vt/t.txt', 'x\n', false, 'vim', 'root');
    vim.applyKey(editorKey(':'));
    for (const ch of `s#x#\\=${expression}#`) vim.applyKey(editorKey(ch));
    vim.applyKey(editorKey('Enter'));
    const message = vim.message;
    const text = vim.content.replace(/\n$/, '');
    fs.deleteFile('/tmp/vt/.t.txt.swp');
    return message.startsWith('E') ? `ERR Vim(call):${message}` : text;
  };
}

const READ_CASES: ReadonlyArray<readonly [string, string]> = [
  ["string(glob(\"*\"))", "'dl\nemptyd\nf.txt\ng.log\nlnk\nsp ace.txt\nsub'"],
  ["string(glob(\"*.txt\"))", "'f.txt\nsp ace.txt'"],
  ["string(glob(\"*\", 0, 1))", "['dl', 'emptyd', 'f.txt', 'g.log', 'lnk', 'sp ace.txt', 'sub']"],
  ["string(glob(\"*.txt\", 0, 1))", "['f.txt', 'sp ace.txt']"],
  ["string(glob(\".*\", 0, 1))", "['.', '..', '.hid']"],
  ["string(glob(\"*\", 1, 1))", "['dl', 'emptyd', 'f.txt', 'g.log', 'lnk', 'sp ace.txt', 'sub']"],
  ["string(glob(\"nope*\", 0, 1))", "[]"],
  ["string(glob(\"nope*\"))", "''"],
  ["string(glob(\"nope\"))", "''"],
  ["string(glob(\"f.txt\"))", "'f.txt'"],
  ["string(glob(\"sub/*\", 0, 1))", "['sub/b.c', 'sub/deep', 'sub/in.txt']"],
  ["string(glob(\"s*/*.c\", 0, 1))", "['sub/b.c']"],
  ["string(glob(\"[fg]*\", 0, 1))", "['f.txt', 'g.log']"],
  ["string(glob(\"?.log\", 0, 1))", "['g.log']"],
  ["string(glob(\"{f,g}.*\", 0, 1))", "['f.txt', 'g.log']"],
  ["string(glob(\"**/*.c\", 0, 1))", "['dl/b.c', 'sub/b.c']"],
  ["string(glob(\"sub/**\", 0, 1))", "['sub/b.c', 'sub/deep', 'sub/in.txt']"],
  ["string(glob(\"emptyd\", 0, 1))", "['emptyd']"],
  ["string(glob(\"emptyd/*\", 0, 1))", "[]"],
  ["string(glob(\"/tmp/vx/g*\", 0, 1))", "['/tmp/vx/g.log']"],
  ["string(glob(\"~\"))", "'/root'"],
  ["string(globpath(\".\", \"*.txt\"))", "'./f.txt\n./sp ace.txt'"],
  ["string(globpath(\".\", \"*.txt\", 0, 1))", "['./f.txt', './sp ace.txt']"],
  ["string(globpath(\"sub,.\", \"*.c\", 0, 1))", "['sub/b.c']"],
  ["string(globpath(\"sub,.\", \"*\", 0, 1))", "['sub/b.c', 'sub/deep', 'sub/in.txt', './dl', './emptyd', './f.txt', './g.log', './lnk', './sp ace.txt', './sub']"],
  ["string(globpath(\"nope\", \"*\", 0, 1))", "[]"],
  ["string(globpath(\".\", \"**/*.c\", 0, 1))", "['./dl/b.c', './sub/b.c']"],
  ["string(globpath(\"/tmp/vx/sub\", \"*\"))", "'/tmp/vx/sub/b.c\n/tmp/vx/sub/deep\n/tmp/vx/sub/in.txt'"],
  ["string(expand(\"$HOME\"))", "'/root'"],
  ["string(expand(\"~\"))", "'/root'"],
  ["string(expand(\"~/x\"))", "'/root/x'"],
  ["string(expand(\"*.txt\"))", "'f.txt\nsp ace.txt'"],
  ["string(expand(\"*.txt\", 0, 1))", "['f.txt', 'sp ace.txt']"],
  ["string(expand(\"nope*\"))", "'nope*'"],
  ["string(expand(\"nope*\", 0, 1))", "['nope*']"],
  ["string(expand(\"nope\"))", "'nope'"],
  ["string(expand(\"f.txt\"))", "'f.txt'"],
  ["string(expand(\"./f.txt\"))", "'./f.txt'"],
  ["string(expand(\"/tmp/../tmp/vx/f.txt\"))", "'/tmp/../tmp/vx/f.txt'"],
  ["string(expand(\"$NOPE_Q\"))", "'$NOPE_Q'"],
  ["string(expand(\"a$HOME\"))", "'a/root'"],
  ["string(expand(\"$HOME/x\"))", "'/root/x'"],
  ["string(expand(\"sub/*\"))", "'sub/b.c\nsub/deep\nsub/in.txt'"],
  ["string(expand(\"g.log\", 1))", "'g.log'"],
  ["string(resolve(\"lnk\"))", "'f.txt'"],
  ["string(resolve(\"dl\"))", "'sub'"],
  ["string(resolve(\"dl/in.txt\"))", "'sub/in.txt'"],
  ["string(resolve(\"f.txt\"))", "'f.txt'"],
  ["string(resolve(\"nope\"))", "'nope'"],
  ["string(resolve(\"./f.txt\"))", "'./f.txt'"],
  ["string(resolve(\"sub/../f.txt\"))", "'f.txt'"],
  ["string(resolve(\"/tmp/vx/lnk\"))", "'/tmp/vx/f.txt'"],
  ["string(resolve(\"lnk/\"))", "'f.txt/'"],
  ["string(strptime(\"%Y-%m-%d\", \"2020-01-02\"))", "1577923200"],
  ["string(strptime(\"%Y-%m-%d %H:%M:%S\", \"2020-01-02 03:04:05\"))", "1577934245"],
  ["string(strptime(\"%Y\", \"abc\"))", "0"],
  ["string(strptime(\"%d/%m/%y\", \"02/01/20\"))", "1577923200"],
  ["string(strptime(\"%Y-%m-%d\", \"2020-01-02 extra\"))", "1577923200"],
  ["string(strptime(\"%b %d %Y\", \"Jan 05 2021\"))", "1609804800"],
  ["string(strptime(\"%Y\", \"\"))", "0"],
  ["string(reltimestr([1,500000]))", "'  1.000500'"],
  ["string(reltimefloat([2, 500000]))", "2.0005"],
  ["string(fnamemodify(\"f.txt\", \":p\"))", "'/tmp/vx/f.txt'"],
  ["string(fnamemodify(\"sub\", \":p\"))", "'/tmp/vx/sub/'"],
  ["string(fnamemodify(\"sub/\", \":p\"))", "'/tmp/vx/sub/'"],
  ["string(fnamemodify(\"nope\", \":p\"))", "'/tmp/vx/nope'"],
  ["string(fnamemodify(\"f.txt\", \":p:h\"))", "'/tmp/vx'"],
  ["string(fnamemodify(\"f.txt\", \":.\"))", "'f.txt'"],
  ["string(fnamemodify(\"/tmp/vx/f.txt\", \":.\"))", "'f.txt'"],
  ["string(fnamemodify(\"/tmp/vx/sub/in.txt\", \":.\"))", "'sub/in.txt'"],
  ["string(fnamemodify(\"/etc/passwd\", \":~\"))", "'/etc/passwd'"],
  ["string(fnamemodify(\"f.txt\", \":s?f?g?\"))", "'g.txt'"],
  ["string(fnamemodify(\"ffx\", \":gs?f?g?\"))", "'ggx'"],
  ["string(fnamemodify(\"f.txt\", \":s?f?g?:r\"))", "'g'"],
  ["string(fnamemodify(\"a b\", \":S\"))", "'''a b'''"],
  ["string(fnamemodify(\"f.txt\", \":e:u\"))", "'txt'"],
  ["string(fnamemodify(\"lnk\", \":p\"))", "'/tmp/vx/lnk'"],
  ["string(fnamemodify(\"lnk\", \":p:r\"))", "'/tmp/vx/lnk'"],
  ["string(fnamemodify(\"./f.txt\", \":p\"))", "'/tmp/vx/f.txt'"],
  ["string(fnamemodify(\"../vx/f.txt\", \":p\"))", "'/tmp/vx/f.txt'"],
  ["string(fnamemodify(\"\", \":p\"))", "'/tmp/vx/'"],
  ["string(fnamemodify(\"f.txt\", \"bad\"))", "'f.txt'"],
  ["string(fnamemodify(\"f.txt\", \":x\"))", "'f.txt'"],
];

const WRITE_SEQUENCE: ReadonlyArray<readonly [string, string]> = [
  ["string(mkdir(\"d1\"))", "1"],
  ["string(mkdir(\"d1\"))", "ERR Vim(call):E739: Cannot create directory: d1"],
  ["string(mkdir(\"p/q/r\",\"p\"))", "1"],
  ["string(mkdir(\"sub/deep/x\"))", "1"],
  ["string(mkdir(\"nope/z\"))", "ERR Vim(call):E739: Cannot create directory: nope/z"],
  ["string(mkdir(\"p2\",\"\",0700))", "1"],
  ["getfperm(\"p2\")", "rwx------"],
  ["string(writefile([\"l1\",\"l2\"],\"w.txt\"))", "0"],
  ["string(readfile(\"w.txt\"))", "['l1', 'l2']"],
  ["string(writefile([\"l3\"],\"w.txt\",\"a\"))", "0"],
  ["string(readfile(\"w.txt\"))", "['l1', 'l2', 'l3']"],
  ["string(writefile([\"nb\"],\"w2.txt\",\"b\"))", "0"],
  ["getfsize(\"w2.txt\")", "2"],
  ["string(writefile([\"a\",\"b\"],\"w3.txt\",\"b\"))", "0"],
  ["getfsize(\"w3.txt\")", "3"],
  ["string(writefile([\"s\"],\"nodir/w.txt\"))", "ERR Vim(call):E482: Can't create file nodir/w.txt"],
  ["string(rename(\"w.txt\",\"w9.txt\"))", "0"],
  ["string(filereadable(\"w.txt\"))", "0"],
  ["string(rename(\"nofile\",\"zz\"))", "-1"],
  ["string(delete(\"w9.txt\"))", "0"],
  ["string(delete(\"w9.txt\"))", "-1"],
  ["string(delete(\"d1\"))", "-1"],
  ["string(delete(\"d1\",\"d\"))", "0"],
  ["string(delete(\"sub\",\"d\"))", "-1"],
  ["string(delete(\"sub\",\"rf\"))", "0"],
  ["string(isdirectory(\"sub\"))", "0"],
  ["string(delete(\"p\",\"rf\"))", "0"],
  ["string(delete(\"nofile\",\"rf\"))", "-1"],
  ["string(delete(\"f.txt\",\"x\"))", "ERR Vim(call):E15: Invalid expression: \"x\""],
  ["string(filereadable(\"f.txt\"))", "1"],
  ["string(delete(\"\"))", "ERR Vim(call):E474: Invalid argument"],
];

describe('fonctions de fichier, de chemin et de temps de vim (lecture)', () => {
  const fs = makeFs('/tmp/vx', {
    '/tmp/vx/f.txt': 'a\nb\n', '/tmp/vx/g.log': 'x', '/tmp/vx/.hid': '', '/tmp/vx/sub/in.txt': 'q', '/tmp/vx/sub/b.c': 'r', '/tmp/vx/sp ace.txt': 'w',
  }, ['/tmp/vx', '/tmp/vx/emptyd', '/tmp/vx/sub', '/tmp/vx/sub/deep']);
  const evaluate = evaluator(fs, '/tmp/vx');
  for (const [expression, expected] of READ_CASES) it(expression, () => { expect(evaluate(expression)).toBe(expected); });
});

describe('fonctions d\'écriture de vim (séquence)', () => {
  const fs = makeFs('/tmp/vw', { '/tmp/vw/f.txt': 'a\nb\n', '/tmp/vw/g.log': 'x', '/tmp/vw/.hid': '', '/tmp/vw/sub/in.txt': 'q' }, ['/tmp/vw', '/tmp/vw/sub', '/tmp/vw/sub/deep']);
  const evaluate = evaluator(fs, '/tmp/vw');
  for (const [expression, expected] of WRITE_SEQUENCE) it(expression, () => { expect(evaluate(expression)).toBe(expected); });
});

describe('tampon courant : wordcount, expand("%"), <cword>, bufname, tempname', () => {
  const content = 'hello wörld\nsecond line here\n\nlast';
  const open = (): { vim: VimEngine; run: (line: number, word: string, expression: string) => string } => {
    const fs = new InMemoryEditorFsContext({ '/tmp/vx/wc.txt': content }, () => '', undefined, '/tmp/vx');
    const vim = new VimEngine(fs, '/tmp/vx/wc.txt', content, false, 'vim', 'root');
    const run = (line: number, word: string, expression: string): string => {
      vim.applyKey(editorKey(':'));
      for (const ch of `${line}s#${word}#\\=${expression}#`) vim.applyKey(editorKey(ch));
      vim.applyKey(editorKey('Enter'));
      return vim.content.split('\n')[line - 1];
    };
    return { vim, run };
  };
  it('wordcount() pendant :1s (curseur en 1,1)', () => {
    expect(open().run(1, 'hello', 'string(wordcount())')).toBe("{'chars': 35, 'cursor_chars': 1, 'words': 6, 'cursor_words': 1, 'bytes': 36, 'cursor_bytes': 1} wörld");
  });
  it('wordcount() pendant :2s (curseur en 2,1)', () => {
    expect(open().run(2, 'second', 'string(wordcount())')).toBe("{'chars': 35, 'cursor_chars': 13, 'words': 6, 'cursor_words': 3, 'bytes': 36, 'cursor_bytes': 14} line here");
  });
  it('expand("<cword>"), expand("%:t") et bufname("%") sur la dernière ligne', () => {
    expect(open().run(4, 'last', 'expand("<cword>") . "|" . expand("%:t") . "|" . bufname("%")')).toBe('last|wc.txt|/tmp/vx/wc.txt');
  });
  it('tempname() : /tmp/v<id>/<n>, distinct à chaque appel, dans un répertoire qui existe', () => {
    const [first, second, exists] = open().run(1, 'hello', 'tempname() . "|" . tempname() . "|" . isdirectory(fnamemodify(tempname(), ":h"))').replace(/ wörld$/, '').split('|');
    expect(first).toMatch(/^\/tmp\/v[a-zA-Z0-9]+\/[0-9]+$/);
    expect(second).not.toBe(first);
    expect(exists).toBe('1');
  });
});

describe('drapeaux non portés : refusés plutôt qu\'ignorés', () => {
  const fs = makeFs('/tmp/vw', { '/tmp/vw/f.txt': 'a' }, ['/tmp/vw']);
  const evaluate = evaluator(fs, '/tmp/vw');
  it('mkdir avec D', () => { expect(evaluate('string(mkdir("dd", "D"))')).toBe('ERR Vim(call):E474: Invalid argument'); });
  it('writefile avec D', () => { expect(evaluate('string(writefile(["a"], "ww", "D"))')).toBe('ERR Vim(call):E474: Invalid argument'); });
  it('témoin : writefile avec s est un synchronisme sans autre effet', () => { expect(evaluate('string(writefile(["a"], "ww", "s"))')).toBe('0'); });
});
