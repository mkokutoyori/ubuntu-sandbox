/**
 * One daemon, one pid, one file — checked on a real machine.
 *
 * Three layers of this simulator describe the same sshd: the process
 * table (`ps`), the file rsyslog writes (`/var/log/auth.log`), and the
 * journal (`journalctl -u ssh`). They did not agree.
 *
 *   - `SshSyslogger` invented a random pid for `sshd[<pid>]`, so the log
 *     named a process `ps aux | grep sshd` never showed.
 *   - `LinuxLogManager` seeded a boot-time `Server listening on 0.0.0.0
 *     port 22.` under yet another invented pid (1234) — a duplicate of
 *     the line the real `tcp.listener.changed` event already produces.
 *   - `PortActivityLogProjection` logged sshd's connection activity
 *     through the DAEMON facility, landing it in `/var/log/syslog` while
 *     the authentications for the very same connection went to
 *     `/var/log/auth.log`: one connection, two files, and the file every
 *     operator opens held only half the story.
 *   - rsyslog copied auth messages into `/var/log/syslog` as well, which
 *     Debian's own `50-default.conf` explicitly prevents
 *     (`*.*;auth,authpriv.none`).
 *
 * Nothing here is stubbed: two machines, a cable between them, and a
 * genuine ssh login. What the test reads is what a student would type.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const MASK = new SubnetMask('255.255.255.0');

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

/** PC1 (10.0.0.1) cabled to SRV (10.0.0.2), after one real ssh login. */
async function afterOneLogin(): Promise<LinuxServer> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), MASK);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), MASK);
  new Cable('c1').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.powerOn(); srv.powerOn();

  await pc.executeCommand('ssh alice@10.0.0.2 hostname');
  return srv;
}

/** The pid of the listening daemon, read from the process table. */
function sshdPidFrom(psOutput: string): string {
  const line = psOutput.split('\n').find((l) => l.includes('/usr/sbin/sshd -D'));
  expect(line, 'the ssh unit must have spawned a daemon').toBeDefined();
  return line!.trim().split(/\s+/)[1];
}

describe('sshd is the same process everywhere it is named', () => {
  it('the pid in auth.log is the pid `ps` shows', async () => {
    const srv = await afterOneLogin();

    const pid = sshdPidFrom(await srv.executeCommand('ps aux'));
    const auth = await srv.executeCommand('cat /var/log/auth.log');

    expect(auth).toContain(`sshd[${pid}]: Accepted password for alice`);
  });

  it('no line names an sshd that does not exist', async () => {
    const srv = await afterOneLogin();

    const ps = await srv.executeCommand('ps aux');
    const auth = await srv.executeCommand('cat /var/log/auth.log');

    // Every `sshd[<pid>]` in the log must correspond to a real process:
    // the listener, or one of its per-session children.
    const livePids = new Set(
      ps.split('\n').filter((l) => l.includes('sshd'))
        .map((l) => l.trim().split(/\s+/)[1]),
    );
    const logged = [...auth.matchAll(/sshd\[(\d+)\]/g)].map((m) => m[1]);
    expect(logged.length, 'the login must have been logged at all').toBeGreaterThan(0);
    expect(logged.filter((p) => !livePids.has(p))).toEqual([]);
  });

  /**
   * « Une seule voix » veut dire un seul PID, pas une seule ligne.
   *
   * Un vrai sshd à double pile annonce une ligne par socket qu'il ouvre :
   * `Server listening on 0.0.0.0 port 22.` ET `... on :: port 22.`. Ce
   * test n'en attendait qu'une parce que le simulateur n'ouvrait aucune
   * écoute IPv6 — le commentaire de `LinuxLogManager` disait exactement
   * cela au point où la ligne v6 avait été retirée : « le simulateur ne
   * lie aucun listener IPv6, la ligne annoncerait une socket qui n'existe
   * pas ». Depuis PRD-Sockets §P2b elle existe, donc la ligne revient —
   * par l'événement réel, et non par un ensemencement.
   *
   * Ce qui est vérifié reste donc la propriété que ce fichier défend :
   * toutes ces lignes portent le pid du démon qui a réellement lié les
   * sockets, celui que `ps` montre.
   */
  it('`Server listening` est écrit par le démon qui a lié les sockets, une ligne par socket', async () => {
    const srv = await afterOneLogin();

    const pid = sshdPidFrom(await srv.executeCommand('ps aux'));
    const auth = await srv.executeCommand('cat /var/log/auth.log');

    const listening = auth.split('\n').filter((l) => l.includes('Server listening'));
    expect(listening).toHaveLength(2);
    for (const line of listening) expect(line).toContain(`sshd[${pid}]`);
    expect(listening.join('\n')).toContain('0.0.0.0 port 22');
    expect(listening.join('\n')).toContain(':: port 22');
  });
});

describe('sshd writes where an operator looks for it', () => {
  it('the whole connection — listen, authenticate, session — is in auth.log', async () => {
    const srv = await afterOneLogin();

    const auth = await srv.executeCommand('cat /var/log/auth.log');

    expect(auth).toContain('Server listening on 0.0.0.0 port 22.');
    expect(auth).toContain('Accepted password for alice from 10.0.0.1');
    expect(auth).toMatch(/pam_unix\(sshd:session\): session opened for user alice/);
  });

  it('and none of it leaks into /var/log/syslog', async () => {
    const srv = await afterOneLogin();

    // Debian's `*.*;auth,authpriv.none -/var/log/syslog` keeps usernames
    // out of the file with the looser permissions.
    expect(await srv.executeCommand('cat /var/log/syslog')).not.toContain('sshd[');
  });

  it('the journal shows the same events under the ssh unit', async () => {
    const srv = await afterOneLogin();

    const journal = await srv.executeCommand('journalctl -u ssh');

    expect(journal).toContain('Accepted password for alice from 10.0.0.1');
    expect(journal).toContain('Server listening on 0.0.0.0 port 22.');
  });
});
