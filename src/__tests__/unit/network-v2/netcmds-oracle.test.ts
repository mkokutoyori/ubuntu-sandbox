/**
 * nc, ss, netstat, fuser et ps rejoues contre les VRAIS binaires d'Ubuntu 24.04 : netcat-openbsd 1.226-1ubuntu2 (source Debian,
 * patches appliques), iproute2 6.1.0, net-tools 2.10, psmisc 23.7, procps-ng 4.0.4.
 *
 * Enregistrement (scripts/oracle/record_netcmds.py, labos de scripts/oracle/netcmds_labs.py) : chaque cas tourne dans un espace de noms
 * reseau et de processus neuf (`unshare -n -p -f --mount-proc`), sur un pty de 80 colonnes, donc hermetique : rien d'autre que le
 * labo n'y ecoute, les PID repartent de 1.  Le meme script de labo (les memes lignes `nc ... &` puis les memes commandes) est rejoue sur
 * une machine Linux simulee neuve, en root, dont les demons ont ete arretes ; la sortie ET le code de retour de chaque commande sont
 * compares.  Le port ephemere qu'un client choisit sans `-p` est tire au hasard par le noyau d'enregistrement et suit une suite dans le simulateur : il est masque des deux cotes (maskEphemeralPorts).  Differences d'environnement connues, hors de portee du simulateur : le noyau d'enregistrement n'a pas IPv6 (les labos IPv6
 * ne sont pas enregistres), pas de module dummy (les adresses 10.0.0.x sont posees sur `lo` en vrai, sur eth0 ici), et un resolveur
 * DNS injoignable (les noms inconnus ne sont pas enregistres).
 *
 * Un pas qui passe alors qu'il est declare non porte fait echouer le test pour qu'on le retire de la liste.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { maskEphemeralPorts, replayNetCmdsCase, type NetCmdsFixture } from '../../support/oracle/netCmdsReplay';

const directory = 'src/__tests__/support/oracle/netcmds';

const UNPORTED_STEPS: ReadonlySet<string> = new Set([
  'nc-scan-down|nc -zv -s 10.0.0.2 127.0.0.1 9000',
  'nc-scan-up|nc -zv -s 10.0.0.2 127.0.0.1 9000',
]);

const fixtures = readdirSync(directory).filter((name) => name.endsWith('.json')).sort()
  .map((name) => ({ name, fixture: JSON.parse(readFileSync(`${directory}/${name}`, 'utf8')) as NetCmdsFixture }));

describe('the recordings come from the real tools', () => {
  it('names the version of every tool it was recorded with', () => {
    expect(fixtures.length).toBeGreaterThan(0);
    for (const { fixture } of fixtures) {
      expect(fixture.tools.nc).toContain('1.226');
      expect(fixture.tools.ss).toContain('iproute2-6.1');
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
          const same = maskEphemeralPorts(got.output) === maskEphemeralPorts(step.output) && got.status === step.status;
          const key = `${lab.id}|${step.cmd}`;
          if (!same && !UNPORTED_STEPS.has(key)) wrong.push(`$ ${step.cmd}\n  real (rc ${step.status}): ${JSON.stringify(step.output)}\n  sim  (rc ${got.status}): ${JSON.stringify(got.output)}`);
          if (same && UNPORTED_STEPS.has(key)) fixed.push(key);
        });
        expect(wrong, wrong.join('\n')).toEqual([]);
        expect(fixed, 'now passing: remove from UNPORTED_STEPS').toEqual([]);
      }, 120000);
    }
  });
}
