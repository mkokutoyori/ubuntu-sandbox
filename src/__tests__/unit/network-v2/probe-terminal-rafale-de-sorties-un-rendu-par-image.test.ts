/**
 * Laboratoire « nat-lab » : `debug ip nat` sur R-AKWA, `tcpdump` dans le terminal du serveur web, puis, depuis un hote, 200 curl lances en
 * arriere-plan (`for i in $(seq 1 200); do curl -s -o /dev/null --max-time 5 http://… & done; wait`) faisaient planter l'outil dans le navigateur.
 *
 * Mesure. Rien ne se bloque cote simulation (la rafale se termine en ~3 s) : le serveur affiche ~4 400 lignes de tcpdump, le routeur ~2 400
 * lignes de debug, chacune par un `addLine` qui appelait `notify()`, donc CHAQUE abonne (`useSyncExternalStore` de TerminalView) une fois par
 * ligne. Les lignes arrivent chacune dans sa propre tache de micro-file (la simulation attend entre deux trames), ce que React ne regroupe pas :
 * 4 408 rendus de TerminalView pour 4 408 lignes, chacun reconstruisant les 5 000 lignes du defilement -- plus de 20 millions de noeuds
 * en quelques secondes, le navigateur gele puis tue l'onglet.
 *
 * Corrige : `notify()` incremente toujours la version (getVersion reste exact a chaque ligne) mais ne reveille les abonnes qu'une fois par
 * intervalle de 16 ms -- tout de suite quand le terminal etait calme (la frappe s'affiche sans delai), puis une fois pour la rafale entiere ;
 * le dernier etat est toujours livre.
 *
 * Discrimine par `git stash push -- src/terminal` : 2 cas sur 3 tombent (4 410 rendus au lieu de moins de 400 pour la rafale du laboratoire ; 1 000 reveils
 * au lieu de moins de 100 pour une rafale de 1 000 lignes). Passe des deux cotes, TEMOIN : la ligne isolee reveille l'abonne tout de suite et la version est exacte.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';
import { tutoNatLab } from './_helpers/tutoNatLab';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const key = (name: string): KeyEvent => ({ key: name, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function submit(session: TerminalSession, command: string): void {
  session.setInput(command);
  session.handleKey(key('Enter'));
}

interface Watch {
  wakeups: number;
  microtaskRenders: number;
  lastSeenVersion: number;
}

function watch(session: TerminalSession): Watch {
  const watched: Watch = { wakeups: 0, microtaskRenders: 0, lastSeenVersion: -1 };
  let scheduled = false;
  session.subscribe(() => {
    watched.wakeups++;
    watched.lastSeenVersion = session.getVersion();
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; watched.microtaskRenders++; });
  });
  return watched;
}

describe('un terminal inonde de lignes ne reveille pas son affichage a chaque ligne', () => {
  it('200 curl derriere un NAT statique avec tcpdump dans le serveur : moins de 400 reveils pour plus de 4 000 lignes', async () => {
    const lab = await tutoNatLab(['ip nat inside source list 1 interface GigabitEthernet0/1 overload', 'ip nat inside source static 192.168.10.10 203.0.113.3']);
    const server = new LinuxTerminalSession('srv', lab.srv);
    submit(server, 'sudo tcpdump -i eth0 -n');
    await pause(300);
    const client = new LinuxTerminalSession('ext', lab.ext);
    const watched = watch(server);
    const before = server.lines.length;
    const versionBefore = server.getVersion();
    submit(client, 'for i in $(seq 1 200); do curl -s -o /dev/null --max-time 5 http://203.0.113.3/ & done; wait; echo FINISHED');
    for (let i = 0; i < 2400 && !client.lines.some((line) => line.text === 'FINISHED'); i++) await pause(50);
    await pause(100);
    const added = server.lines.length - before;
    expect(added).toBeGreaterThan(4000);
    expect(server.getVersion() - versionBefore).toBeGreaterThanOrEqual(added);
    expect(watched.microtaskRenders).toBeLessThan(400);
    expect(watched.lastSeenVersion).toBe(server.getVersion());
  }, 120_000);

  it('TEMOIN — une ligne isolee reveille l\'abonne tout de suite', async () => {
    const lab = await tutoNatLab();
    const session = new LinuxTerminalSession('srv', lab.srv);
    await pause(60);
    const watched = watch(session);
    session.addLine('une seule ligne');
    expect(watched.wakeups).toBe(1);
    expect(watched.lastSeenVersion).toBe(session.getVersion());
  });

  it('une rafale de 1 000 lignes livre l\'etat final et ne reveille pas 1 000 fois', async () => {
    const lab = await tutoNatLab();
    const session = new LinuxTerminalSession('srv', lab.srv);
    await pause(60);
    const watched = watch(session);
    for (let i = 0; i < 1000; i++) {
      session.addLine(`ligne ${i}`);
      await Promise.resolve();
    }
    await pause(60);
    expect(watched.lastSeenVersion).toBe(session.getVersion());
    expect(session.lines[session.lines.length - 1].text).toBe('ligne 999');
    expect(watched.wakeups).toBeLessThan(100);
  });
});
