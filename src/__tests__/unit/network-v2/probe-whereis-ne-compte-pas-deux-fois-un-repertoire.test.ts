/**
 * `whereis` comptait DEUX fois le meme repertoire fusionne (/bin == /usr/bin).
 *
 * MESURE DE DEPART sur `3104e0a8', sur un `LinuxCommandExecutor' neuf :
 *
 *   whereis -b ls   ->  ls: /usr/bin/ls /bin/ls
 *   whereis -b cp   ->  cp: /usr/bin/cp /bin/cp
 *
 * La machine porte DEJA la fusion /usr d'Ubuntu — `VirtualFileSystem'
 * cree `/bin' comme lien symbolique vers `usr/bin', et `/sbin' vers
 * `usr/sbin'. Le resolveur, lui, parcourait sa liste de repertoires
 * telle quelle : il trouvait donc le meme fichier, par le meme inode,
 * sous ses deux orthographes, et l'annoncait deux fois.
 *
 * AUTORITE. Deux sources concordantes.
 *
 * 1. La source d'util-linux, `misc-utils/whereis.c', fonction
 *    `dirlist_add_dir' (l. 223-259) : elle refuse un repertoire dont
 *    l'(st_dev, st_ino, type) figure deja dans la liste, et range le
 *    chemin CANONIQUE (`ul_canonicalize_path'). Un repertoire illisible
 *    ou absent est ecarte avant meme cela (`access', `stat').
 *
 * 2. La machine hote de cette session est une Ubuntu 24.04.4 reelle.
 *    Transcription capturee :
 *
 *      $ whereis -b ls          ->  ls: /usr/bin/ls
 *      $ which -a ls            ->  /usr/bin/ls
 *                                   /bin/ls
 *      $ stat -c %i /usr/bin    ->  299
 *      $ stat -c %i /bin        ->  299   (lien symbolique -> usr/bin)
 *
 *    Les deux commandes divergent EXPRES : `whereis' deduplique par
 *    inode, `which' (script debianutils, /etc/alternatives/which) parcourt
 *    `$PATH' mot pour mot et ne deduplique rien. Les deux reponses sont
 *    justes, et elles ne sont pas la meme.
 *
 * MESURE : 4 cas tombent sur 8 (`git stash' sur les trois fichiers touches).
 * Les quatre cas qui passent des deux cotes sont nommes :
 *   - TEMOIN : `whereis -b ls' cite bien /usr/bin/ls — sans lui, une sonde
 *     faite de refus ne prouverait pas que le lab sait trouver un binaire ;
 *   - TEMOIN : `which -a' garde ses DEUX lignes, la reponse que la
 *     deduplication ne doit surtout pas toucher ;
 *   - STRUCTUREL : /bin et /usr/bin partagent deja un inode avant la
 *     correction — c'est la premisse mesuree, pas son effet ;
 *   - NON-REGRESSION : `whereis -l' annonce toujours les trois familles.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

let exec: LinuxCommandExecutor;
beforeEach(() => { exec = new LinuxCommandExecutor(false); });

const run = (cmd: string): string => exec.execute(cmd);

describe('whereis deduplique ses repertoires par inode', () => {
  it('TEMOIN : whereis -b ls cite /usr/bin/ls', () => {
    expect(run('whereis -b ls')).toContain('/usr/bin/ls');
  });

  it('/bin et /usr/bin sont le meme inode sur la machine simulee', () => {
    const merged = exec.vfs.resolveInode('/bin')?.id;
    expect(merged).toBeDefined();
    expect(merged).toBe(exec.vfs.resolveInode('/usr/bin')?.id);
  });

  it('whereis -b ls ne cite le binaire qu une seule fois', () => {
    expect(run('whereis -b ls')).toBe('ls: /usr/bin/ls');
  });

  it('whereis -b cp ne cite le binaire qu une seule fois', () => {
    expect(run('whereis -b cp')).toBe('cp: /usr/bin/cp');
  });

  it('un binaire de /usr/sbin echappe aussi au doublon via /sbin', () => {
    const out = run('whereis -b iptables');
    expect(out).toBe('iptables: /usr/sbin/iptables');
  });

  it('whereis -l ne montre plus les orthographes fusionnees', () => {
    const dirs = run('whereis -l').split('\n');
    expect(dirs).toContain('/usr/bin');
    expect(dirs).not.toContain('/bin');
    expect(dirs).not.toContain('/sbin');
  });

  it('TEMOIN : which -a garde ses deux lignes, lui qui ne deduplique pas', () => {
    exec.vfs.writeFile('/usr/bin/zorglub', '#!/bin/sh\n', 0, 0, 0o022);
    const inode = exec.vfs.resolveInode('/usr/bin/zorglub');
    if (inode) inode.permissions = 0o755;
    expect(run('which -a zorglub').split('\n')).toEqual(['/usr/bin/zorglub', '/bin/zorglub']);
  });

  it('NON-REGRESSION : whereis -l annonce toujours binaires, manuels et sources', () => {
    const out = run('whereis -l');
    expect(out).toContain('/usr/bin');
    expect(out).toContain('/usr/share/man');
    expect(out).toContain('/usr/src');
  });
});
