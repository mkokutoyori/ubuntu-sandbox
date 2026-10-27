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

const UNPORTED_STEPS: ReadonlySet<string> = new Set([
  'nc-scan-down|nc -zv -s 10.0.0.2 127.0.0.1 9000',
  'nc-scan-up|nc -zv -s 10.0.0.2 127.0.0.1 9000',
  'ss-connected|ss -tai',
  'ss-two-connections|ss -tai',
  'ss-unix|ss',
  'ss-unix|ss -a',
  'ss-unix|ss -l',
  'ss-unix|ss -n',
  'ss-unix|ss -an',
  'ss-unix|ss -x',
  'ss-unix|ss -xa',
  'ss-unix|ss -xl',
  'ss-unix|ss -f unix -a',
  'netstat-unix|netstat',
  'netstat-unix|netstat -a',
  'netstat-unix|netstat -l',
  'netstat-unix|netstat -n',
  'netstat-unix|netstat -an',
  'netstat-unix|netstat -x',
  'netstat-unix|netstat -xa',
  'netstat-unix|netstat -A unix',
  'fuser-files|fuser -vm / 2>&1 | head -3',
  'fuser-files-none|fuser -vm / 2>&1 | head -3',
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
        lab.steps.forEach((step, index) => {
          const got = run.steps[index];
          const loose = looksLikeNetlinkRun(step.output);
          const expected = normalizeNetOutput(comparableOutput(step.output), { pids: lab.recordedPids, baseline: lab.baseline, shellPid: 1 }, step.cmd, loose);
          const actual = normalizeNetOutput(comparableOutput(got.output), { pids: run.pids, baseline: run.baseline, shellPid: run.shellPid }, step.cmd, loose);
          const same = actual === expected && got.status === step.status;
          const key = `${lab.id}|${step.cmd}`;
          if (!same && !UNPORTED_STEPS.has(key)) wrong.push(`$ ${step.cmd}\n  real (rc ${step.status}): ${JSON.stringify(expected)}\n  sim  (rc ${got.status}): ${JSON.stringify(actual)}`);
          if (same && UNPORTED_STEPS.has(key)) fixed.push(key);
        });
        expect(wrong, wrong.join('\n')).toEqual([]);
        expect(fixed, 'now passing: remove from UNPORTED_STEPS').toEqual([]);
      }, 120000);
    }
  });
}
