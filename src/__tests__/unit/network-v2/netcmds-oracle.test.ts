/**
 * nc, ss, netstat, fuser et ps rejoues contre les VRAIS binaires d'Ubuntu 24.04 : netcat-openbsd 1.226-1ubuntu2 (source Debian,
 * patches appliques), iproute2 6.1.0, net-tools 2.10, psmisc 23.7, procps-ng 4.0.4.
 *
 * Enregistrement (scripts/oracle/record_netcmds.py, labos de scripts/oracle/netcmds_labs.py) : chaque cas tourne dans un espace de noms
 * reseau et de processus neuf (`unshare -n -p -f --mount-proc`), sur un pty de 80 colonnes, donc hermetique : rien d'autre que le
 * labo n'y ecoute, les PID repartent de 1.  Le meme script de labo (les memes lignes `nc ... &` puis les memes commandes) est rejoue sur
 * une machine Linux simulee neuve, en root, dont les demons ont ete arretes ; la sortie ET le code de retour de chaque commande sont
 * compares.  Deux differences de MODE sont effacees des deux cotes (comparableOutput) : le port ephemere qu'un client choisit sans `-p`
 * (tire au hasard par le noyau d'enregistrement, en suite dans le simulateur) et les avis de fin de job `[2]+ Done ...` (un script ne les
 * affiche jamais, le terminal simule, interactif, oui).  Differences d'environnement connues, hors de portee du simulateur : le noyau
 * d'enregistrement n'a pas IPv6 (les labos IPv6 ne sont pas enregistres), pas de module dummy (les adresses 10.0.0.x sont posees sur
 * `lo` en vrai, sur eth0 ici), et un resolveur DNS injoignable (les noms inconnus ne sont pas enregistres).
 *
 * ss : les lignes sont triees avant la comparaison (l'ordre est celui des tables de hachage du noyau), les pid, inodes, cookies, minuteries
 * et chemins de cgroup sont remplaces par un jeton, et les totaux machine de `ss -s` par une difference a la base mesuree avant le labo.
 * La machine simulee se dit Ubuntu 22.04 alors que les binaires enregistres sont ceux de 24.04 (iproute2 6.1.0, net-tools 2.10, psmisc 23.7) :
 * leurs versions suivent les enregistrements et la base de paquets les annonce de meme (TODO.md note le reste de l'identite).  Le noyau d'enregistrement utilise bbr (facteur 3 pour le tampon d'emission, tcp_info
 * propre a bbr), la pile simulee un Reno : les tampons autoregles et `-i` d'une connexion etablie ne se comparent pas.
 *
 * `fuser -m ... | head -3` depend de l'ensemble des processus : le noyau d'enregistrement n'en a que ceux du labo, la machine simulee tous ses demons.
 * Un pas qui passe alors qu'il est declare non porte fait echouer le test pour qu'on le retire de la liste.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { comparableOutput, replayNetCmdsCase, type NetCmdsFixture } from '../../support/oracle/netCmdsReplay';
import { looksLikeNetlinkRun, normalizeNetOutput } from '../../support/oracle/netCmdsNormalize';

const directory = 'src/__tests__/support/oracle/netcmds';

const UNIX_LABS = ['unix-stream', 'unix-listen', 'unix-two', 'unix-dgram', 'unix-dgram-listen', 'unix-closed', 'unix-none'];

function unportedInEveryUnixLab(commands: readonly string[]): string[] {
  return UNIX_LABS.flatMap((lab) => commands.map((command) => `${lab}|${command}`));
}

const UNPORTED_LABS: ReadonlySet<string> = new Set(['unix-user']);

const UNPORTED_STEPS: ReadonlySet<string> = new Set([
  'nc-scan-down|nc -zv -s 10.0.0.2 127.0.0.1 9000',
  'nc-scan-up|nc -zv -s 10.0.0.2 127.0.0.1 9000',
  'ss-connected|ss -tai',
  'ss-two-connections|ss -tai',
  'fuser-files|fuser -vm / 2>&1 | head -3',
  'fuser-files-none|fuser -vm / 2>&1 | head -3',
  ...unportedInEveryUnixLab([
    'ss -xaE | head -2',
    'lsof -U',
    'lsof -U -a -p $P1',
    'lsof -p $P1',
    'lsof /tmp/lab/s1',
    'lsof -a -U -c nc',
    'lsof -nP -U',
    'timeout 1 nc -lU /tmp/lab/plain; echo rc=$?; ls -l /tmp/lab/plain | cut -c1-10',
    'timeout 1 nc -lU /tmp/lab/s1; echo rc=$?',
  ]),
  ...[
    "umask 022; trap 'umask' EXIT; umask 077",
    'umask 022; builtin umask 077; umask',
    'command -V umask',
    'type -a umask',
    'help umask | head -3',
    'enable -n umask; umask 077; echo rc=$?; enable umask; umask',
    'umask 022; which umask; echo rc=$?',
    'umask 077; su -s /bin/sh nobody -c umask',
  ].map((command) => `umask-scopes|${command}`),
  ...[
    'ps -M', 'ps Z', 'ps --context', 'ps -Z; echo rc=$?',
    'ps -p $P1 -o label,context,zone,zoneid',
    'ps -p $P1 -o comm,ucmd,ucomm,fname,args,cmd,command,cgroup,cgname,exe',
    'ps -p $P1 -o ouid,oom,oomadj,ag_id,ag_nice,luid,lsession,lxc,seat,slice,unit,uunit,machine',
    'ps -p $P1 -o supgid,supgrp',
    'ps S', 'ps -S; echo rc=$?',
    'ps -H -m; echo rc=$?',
  ].map((command) => `ps-formats|${command}`),
  ...['ps e', 'ps -e e', 'ps ae', 'ps ce', 'ps ef'].map((command) => `ps-formats|${command}`),
  ...['ps -ef -aux; echo rc=$?', 'ps -r -e; echo rc=$?'].map((command) => `ps-misc|${command}`),
  ...['ps -o comm=,args=', 'ps -o pid=,comm=,args= --headers', 'ps -o user=,pid', 'ps --no-headers -f'].map((command) => `ps-formats|${command}`),
  ...[
    'ps -e --sort=args -o pid,args', 'ps -e --sort=cmd -o pid,cmd', 'ps -e --sort=time -o pid,time', 'ps -e --sort=rss -o pid,rss', 'ps -e --sort=pcpu -o pid,pcpu',
    'ps -e --sort=pmem -o pid,pmem', 'ps -e --sort=etime -o pid,etime', 'ps O c', 'ps O r', 'ps O v', 'ps O Pf',
  ].map((command) => `ps-sorting|${command}`),
  ...['ps -u -1; echo rc=$?', 'ps -N -u root; echo rc=$?'].map((command) => `ps-selection|${command}`),
  'ps-misc|ps 5; echo rc=$?',
  ...[
    'ps --rows 5 --headers -e', 'ps --lines 5 --headers -e', 'LINES=5 ps --headers -e', 'COLUMNS=5 ps -ef',
    'ps -ef | cat', 'ps aux | cat', 'ps -efl | cat', 'ps -o pid,args | cat', 'ps l | cat', 'ps -ef -w | cat', 'COLUMNS=30 ps -ef | cat',
    'ps -ef --cols 30 | cat', 'ps --forest -e -o pid,args | cat',
  ].map((command) => `ps-formats|${command}`),
  'unix-closed|ls -l /proc/$P1/fd | tail -n +2 | awk \'{print $1,$3,$4,$9,$10,$11}\'',
  'unix-none|ls -l /proc/$P1/fd | tail -n +2 | awk \'{print $1,$3,$4,$9,$10,$11}\'',
  'unix-none|stat -c \'%F %a %U\' /tmp/lab/s1 2>&1',
]);

const fixtures = readdirSync(directory).filter((name) => name.endsWith('.json')).sort()
  .map((name) => ({ name, fixture: JSON.parse(readFileSync(`${directory}/${name}`, 'utf8')) as NetCmdsFixture }));

describe('the recordings come from the real tools', () => {
  it('names the version of every tool it was recorded with', () => {
    expect(fixtures.length).toBeGreaterThan(0);
    for (const { fixture } of fixtures) {
      expect(fixture.tools.nc).toContain('1.226');
      expect(fixture.tools.ss).toContain('iproute2-6.1');
      expect(fixture.tools.netstat).toContain('2.10');
      expect(fixture.tools.fuser).toContain('23.7');
    }
  });
});

for (const { name, fixture } of fixtures) {
  describe(name, () => {
    for (const lab of fixture.cases) {
      it(lab.id, async () => {
        const run = await replayNetCmdsCase(lab);
        const wrong: string[] = [];
        const fixed: string[] = [];
        let identical = true;
        lab.steps.forEach((step, index) => {
          const got = run.steps[index];
          const loose = looksLikeNetlinkRun(step.output);
          const expected = normalizeNetOutput(comparableOutput(step.output), { pids: lab.recordedPids, baseline: lab.baseline, shellPid: lab.shellPid ?? 1, initPid: lab.shellPid === undefined ? undefined : 1 }, step.cmd, loose);
          const actual = normalizeNetOutput(comparableOutput(got.output), { pids: run.pids, baseline: run.baseline, shellPid: run.shellPid, visible: got.visible }, step.cmd, loose);
          const same = actual === expected && got.status === step.status;
          const key = `${lab.id}|${step.cmd}`;
          if (!same) identical = false;
          if (!same && !UNPORTED_STEPS.has(key) && !UNPORTED_LABS.has(lab.id)) wrong.push(`$ ${step.cmd}\n  real (rc ${step.status}): ${JSON.stringify(expected)}\n  sim  (rc ${got.status}): ${JSON.stringify(actual)}`);
          if (same && UNPORTED_STEPS.has(key)) fixed.push(key);
        });
        if (identical && UNPORTED_LABS.has(lab.id)) fixed.push(lab.id);
        expect(wrong, wrong.join('\n')).toEqual([]);
        expect(fixed, 'now passing: remove from UNPORTED_STEPS').toEqual([]);
      }, 120000);
    }
  });
}
