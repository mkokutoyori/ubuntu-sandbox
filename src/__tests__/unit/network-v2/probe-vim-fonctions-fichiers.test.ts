/**
 * vim 9.1 : filereadable, isdirectory, readfile (options b et maximum, E484), getfsize et readdir (tri, filtre) sur un système de fichiers en mémoire ; valeurs relevées sur le vrai vim de cette machine dans un répertoire /tmp/vd (f.txt = « a\nb\n\nc » sans saut final, crlf.txt, empty.txt, sub/).
 * Mesure de départ : « E117: Unknown function » pour chacune. 15 des 16 cas tombent avant ; seul le témoin trim passe dans les deux états. Ajout : hostname, getpid et localtime (3 cas, les 3 tombent avant, E117). Ajout : environ() (3 cas, les 3 tombent avant). Ajout : executable et exepath (13 cas rejoués sur le vrai vim, les 13 tombent avant ; un cas de plus sur la machine, executableAt, tombe aussi avant). Ajout : getftype et getfperm (3 cas, les 3 tombent avant).
 */

import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

function evaluate(expression: string): string {
  const fs = new InMemoryEditorFsContext({
    '/tmp/vd/f.txt': 'a\nb\n\nc', '/tmp/vd/crlf.txt': 'l1\r\nl2\r\n', '/tmp/vd/empty.txt': '', '/tmp/vd/sub/in.txt': 'z', '/tmp/vd/t.txt': 'x\n',
  }, () => '', undefined, '/tmp/vd');
  const vim = new VimEngine(fs, '/tmp/vd/t.txt', 'x\n', false, 'vim', 'root');
  vim.applyKey(editorKey(':'));
  for (const ch of `s#x#\\=${expression}#`) vim.applyKey(editorKey(ch));
  vim.applyKey(editorKey('Enter'));
  return vim.content.replace(/\n$/, '');
}

describe('fonctions de fichier de vim', () => {
  const ORACLE: ReadonlyArray<readonly [string, string]> = [
    ['filereadable("f.txt")', '1'],
    ['filereadable("sub")', '0'],
    ['filereadable("nope")', '0'],
    ['isdirectory("sub")', '1'],
    ['isdirectory("f.txt")', '0'],
    ["string(readfile('f.txt'))", "['a', 'b', '', 'c']"],
    ["string(readfile('f.txt','',2))", "['a', 'b']"],
    ["string(readfile('f.txt','',-1))", "['c']"],
    ["string(readfile('crlf.txt'))", "['l1', 'l2']"],
    ["string(readfile('empty.txt'))", '[]'],
    ['getfsize("f.txt")', '6'],
    ['getfsize("nope")', '-1'],
    ['getfsize("empty.txt")', '0'],
    ['getcwd()', '/tmp/vd'],
    ["string(readdir('.', {n -> n =~ '^[cef]'}))", "['crlf.txt', 'empty.txt', 'f.txt']"],
  ];
  for (const [expression, expected] of ORACLE) it(expression, () => { expect(evaluate(expression)).toBe(expected); });
  it('témoin : trim', () => { expect(evaluate('trim(" a ")')).toBe('a'); });
});

describe('identité et horloge de vim', () => {
  it('hostname rend le nom de la machine', () => { expect(evaluate('hostname()')).toBe('vm'); });
  it('getpid rend le pid de l\'éditeur', () => { expect(evaluate('getpid()')).toBe('4321'); });
  it('localtime est un entier de secondes récent', () => { expect(Number(evaluate('localtime()'))).toBeGreaterThan(1.5e9); });
});

describe('environ', () => {
  const withEnvironment = (expression: string): string => {
    const fs = new InMemoryEditorFsContext({ '/tmp/vd/t.txt': 'x\n' }, () => '', undefined, '/tmp/vd');
    fs.useEnvironmentVariable('FOO', 'bar');
    fs.useEnvironmentVariable('EMPTY', '');
    const vim = new VimEngine(fs, '/tmp/vd/t.txt', 'x\n', false, 'vim', 'root');
    vim.applyKey(editorKey(':'));
    for (const ch of `s#x#\\=${expression}#`) vim.applyKey(editorKey(ch));
    vim.applyKey(editorKey('Enter'));
    return vim.content.replace(/\n$/, '');
  };
  it('environ() est un dictionnaire des variables posées', () => { expect(withEnvironment('environ()["FOO"]')).toBe('bar'); });
  it('une variable vide y figure', () => { expect(withEnvironment('has_key(environ(), "EMPTY")')).toBe('1'); });
  it('type dictionnaire', () => { expect(withEnvironment('type(environ())')).toBe('4'); });
});

describe('executable et exepath', () => {
  const withBinaries = (expression: string): string => {
    const fs = new InMemoryEditorFsContext({
      '/tmp/vd/f.txt': 'a', '/tmp/vd/crlf.txt': 'b', '/usr/bin/sh': '', '/bin/sh': '', '/tmp/vd/t.txt': 'x\n',
    }, () => '', undefined, '/tmp/vd');
    fs.useEnvironmentVariable('PATH', '/usr/bin:/bin');
    fs.useExecutable('/usr/bin/sh');
    fs.useExecutable('/bin/sh');
    fs.useExecutable('/tmp/vd/f.txt');
    const vim = new VimEngine(fs, '/tmp/vd/t.txt', 'x\n', false, 'vim', 'root');
    vim.applyKey(editorKey(':'));
    for (const ch of `s#x#\\=${expression}#`) vim.applyKey(editorKey(ch));
    vim.applyKey(editorKey('Enter'));
    return vim.content.replace(/\n$/, '');
  };
  const ORACLE: ReadonlyArray<readonly [string, string]> = [
    ['executable("sh")', '1'],
    ['executable("/bin/sh")', '1'],
    ['executable("nope_zz")', '0'],
    ['executable("f.txt")', '0'],
    ['executable("./f.txt")', '1'],
    ['executable("crlf.txt")', '0'],
    ['executable("sub")', '0'],
    ['executable("")', '0'],
    ['exepath("sh")', '/usr/bin/sh'],
    ['exepath("nope")', ''],
    ['exepath("./f.txt")', '/tmp/vd/f.txt'],
    ['exepath("/bin/sh")', '/bin/sh'],
    ['exepath("f.txt")', ''],
  ];
  for (const [expression, expected] of ORACLE) it(expression, () => { expect(withBinaries(expression)).toBe(expected); });
});

describe('executableAt sur la machine', () => {
  it('un binaire livré est exécutable, un fichier non exécutable et un répertoire ne le sont pas', async () => {
    const { LinuxPC } = await import('@/network/devices/LinuxPC');
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('echo hi > /tmp/plain.txt');
    expect(pc.editorExecutableAt('/bin/ls')).toBe(true);
    expect(pc.editorExecutableAt('/tmp/plain.txt')).toBe(false);
    expect(pc.editorExecutableAt('/tmp')).toBe(false);
    expect(pc.editorExecutableAt('/nope')).toBe(false);
  });
});

describe('getftype et getfperm', () => {
  const inMemory = (expression: string): string => {
    const fs = new InMemoryEditorFsContext({ '/tmp/vd/f.txt': 'a', '/tmp/vd/sub/in.txt': 'z', '/tmp/vd/t.txt': 'x\n' }, () => '', undefined, '/tmp/vd');
    const vim = new VimEngine(fs, '/tmp/vd/t.txt', 'x\n', false, 'vim', 'root');
    vim.applyKey(editorKey(':'));
    for (const ch of `s#x#\\=${expression}#`) vim.applyKey(editorKey(ch));
    vim.applyKey(editorKey('Enter'));
    return vim.content.replace(/\n$/, '');
  };
  it('getftype : file, dir, absent', () => {
    expect(inMemory('getftype("f.txt")')).toBe('file');
    expect(inMemory('getftype("sub")')).toBe('dir');
    expect(inMemory('getftype("nope")')).toBe('');
  });
  it('getfperm : rw-r--r-- pour un fichier, rwxr-xr-x pour un répertoire, vide si absent', () => {
    expect(inMemory('getfperm("f.txt")')).toBe('rw-r--r--');
    expect(inMemory('getfperm("sub")')).toBe('rwxr-xr-x');
    expect(inMemory('getfperm("nope")')).toBe('');
  });
  it('sur la machine : lien, fifo, périphérique et droits (vim 9.1 : link, fifo, cdev, rwxrwxrwx, rw-rw-rw-)', async () => {
    const { LinuxPC } = await import('@/network/devices/LinuxPC');
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('cd /tmp; echo hello > f.txt; ln -s f.txt lnk; mkfifo ff; chmod 4750 f.txt');
    expect(pc.editorLinkInfo('/tmp/lnk')?.type).toBe('symlink');
    expect(pc.editorLinkInfo('/tmp/ff')?.type).toBe('fifo');
    expect(pc.editorLinkInfo('/dev/null')?.type).toBe('chardev');
    expect(pc.editorLinkInfo('/tmp/f.txt')?.permissions).toBe(0o4750);
    expect(pc.editorLinkInfo('/tmp/nope')).toBeNull();
  });
});
