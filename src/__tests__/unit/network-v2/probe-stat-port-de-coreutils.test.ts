/**
 * coreutils 8.32 src/stat.c : statut de sortie, `-L`, `-f`, `-t`, `--printf`, `--version`, les gabarits par défaut et les directives
 * (%n %N %d %D %i %a %A %f %F %h %u %U %g %G %m %s %t %T %B %b %o %w %W %x %X %y %Y %z %Z %C), les drapeaux et largeurs de printf,
 * « cannot statx 'x' » (le chemin statx de 8.32 sous glibc 2.35) et l'invite à reprendre `-c` avec %N quoté (shell_escape_always).
 *
 * Mesure de départ : `stat /absent; echo $?` rendait 0, `stat --version` « missing operand », `-L`, `-f`, `-t`, `--printf` étaient
 * ignorés. Les 12 cas tombent avant le correctif, y compris le témoin (l'ancien gabarit quotait `File: '/tmp/a'` et rendait `Device: 0h/0d`).
 * Non modélisé, et dit comme tel : la date de naissance (`%w` rend `-`, `%W` 0), les numéros de périphérique (ceux de la table des
 * montages), %C (pas de SELinux : « No data available », errno non attesté ici).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxServer } from '@/network/devices/LinuxServer';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function server(): Promise<LinuxServer> {
  const s = new LinuxServer('linux-server', 'S');
  await s.executeCommand('sh -c "echo hello > /tmp/a"');
  return s;
}

describe('stat (coreutils 8.32)', () => {
  it('un fichier absent : message statx et statut 1', async () => {
    const s = await server();
    expect(await s.executeCommand('stat /absent; echo rc=$?')).toBe("stat: cannot statx '/absent': No such file or directory\nrc=1");
  });

  it('continue après une erreur et sort en 1', async () => {
    const s = await server();
    const out = await s.executeCommand('stat -c %s /tmp/a /absent; echo rc=$?');
    expect(out).toBe("6\nstat: cannot statx '/absent': No such file or directory\nrc=1");
  });

  it('--version et --help', async () => {
    const s = await server();
    expect(await s.executeCommand('stat --version | head -1')).toBe('stat (GNU coreutils) 8.32');
    expect(await s.executeCommand('stat --help | head -1')).toBe('Usage: stat [OPTION]... FILE...');
  });

  it('--printf interprète les échappements et n\'ajoute pas de fin de ligne', async () => {
    const s = await server();
    expect(await s.executeCommand('stat --printf "%n\\t%s\\n%%" /tmp/a')).toBe('/tmp/a\t6\n%');
  });

  it('-t : le format terse', async () => {
    const s = await server();
    expect(await s.executeCommand('stat -t /tmp/a')).toMatch(/^\/tmp\/a 6 8 81a4 0 0 \S+ \d+ 1 0 0 \d+ \d+ \d+ 0 4096$/);
  });

  it('-L suit le lien, %N montre la cible sinon', async () => {
    const s = await server();
    await s.executeCommand('ln -s /tmp/a /tmp/l');
    expect(await s.executeCommand('stat -c "%F" /tmp/l')).toBe('symbolic link');
    expect(await s.executeCommand('stat -L -c "%F" /tmp/l')).toBe('regular file');
    expect(await s.executeCommand("stat -c '%N' /tmp/l")).toBe("'/tmp/l' -> '/tmp/a'");
  });

  it('-f : le système de fichiers', async () => {
    const s = await server();
    const out = await s.executeCommand('stat -f /tmp');
    expect(out).toContain('  File: "/tmp"');
    expect(out).toContain('Namelen: 255');
    expect(out).toContain('Type: ext2/ext3');
    expect(await s.executeCommand('stat -f -c "%S %l" /')).toBe('4096 255');
  });

  it('largeur, alignement et remplissage de printf', async () => {
    const s = await server();
    expect(await s.executeCommand('stat -c "%5s|%-5s|%05s|%.3X" /tmp/a')).toMatch(/^    6\|6    \|00006\|\d+\.\d{3}$/);
  });

  it('une directive invalide arrête stat', async () => {
    const s = await server();
    expect(await s.executeCommand('stat -c %5% /tmp/a; echo rc=$?')).toContain('invalid directive');
  });

  it('--cached refuse une valeur inconnue', async () => {
    const s = await server();
    expect(await s.executeCommand('stat --cached=bogus /tmp/a; echo rc=$?')).toContain('Valid arguments are:');
  });

  it('témoin : -c %s et le gabarit par défaut', async () => {
    const s = await server();
    expect(await s.executeCommand('stat -c %s /tmp/a')).toBe('6');
    const out = await s.executeCommand('stat /tmp/a');
    expect(out).toContain('Access: (0644/-rw-r--r--)  Uid: (    0/    root)   Gid: (    0/    root)');
    expect(out).toContain('  File: /tmp/a');
  });

  it('un périphérique caractère montre « Device type »', async () => {
    const s = await server();
    expect(await s.executeCommand('stat /dev/null')).toContain('Device type: 1,3');
  });
});
