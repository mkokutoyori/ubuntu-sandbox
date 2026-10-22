/**
 * `curl http://170.20.0.2` vers un hote qui ne repond pas laissait le terminal de PC1 mort : le client attend la fin du
 * delai du noyau (127 s, TcpRetryPolicy.activeOpen = tcp_syn_retries), comme un vrai Linux, mais Ctrl-C n'avait aucun
 * effet -- la commande passait par `shell.processLine`, pas par une tache de premier plan --, la file de commandes de la
 * machine (SessionWorkQueue) restait tenue par le curl et tout ce qu'on tapait ensuite (`ls`, `cd /`, `ls`) etait
 * affiche avec l'invite, sans sortie, l'invite gardait `~`, et un autre terminal de la meme machine n'obtenait plus rien.
 * Trouve avec la topologie « nat-lab » d'un utilisateur : Server2 n'a pas de passerelle par defaut (le bail DHCP ne porte
 * pas `option routers`), il ne sait donc pas repondre a 204.0.10.2, le SYN reste sans reponse.
 *
 * Ce que dit un vrai Linux : Ctrl-C envoie SIGINT au processus de premier plan, le noyau ferme ses sockets, le curl
 * disparait sans rien ecrire (statut 130), le terminal affiche `^C` et jette ce qui avait ete tape d'avance (la discipline
 * de ligne vide sa file sur SIGINT) ; ce qui est tape pendant l'attente s'execute, dans l'ordre, quand la commande se
 * termine ; `ps` voit le curl ; `timeout 5 curl` rend la main apres 5 s avec 124.
 *
 * Corrige : un curl lance depuis un terminal est un PROCESSUS (spawn dans la table des processus, `ps` le montre,
 * `kill -INT` l'atteint) ; Ctrl-C lui envoie SIGINT par la table des processus (LinuxMachine.interruptForeground) ;
 * `whenKilled`, qui servait deja a ping et a `timeout`, ferme les sockets du client (CurlHost.signal) ; le terminal
 * garde ce qu'on tape pendant la commande et le rejoue ensuite.
 *
 * Discrimine par `git stash` sur src/network et src/terminal : 11 des 13 cas tombent avant.  Les 2 qui passent des deux
 * cotes sont des TEMOINS : le curl vers un hote muet echoue au bout de 127 s comme le noyau, et ce qui est tape pendant
 * un curl qui se termine seul s execute apres lui, dans l ordre.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { simulationNowMs } from '@/network/core/SystemClock';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { WindowsPC } from '@/network/devices/WindowsPC';

let clock: SimulationClock;

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installSimulationClock(new SimulationClock());
});
afterEach(() => { __resetSimulationClock(); });

const key = (k: string, ctrlKey = false) => ({ key: k, ctrlKey, altKey: false, metaKey: false, shiftKey: false });
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function lab(): Promise<{ pc: LinuxPC; session: LinuxTerminalSession }> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV');
  new Cable('c').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  await pc.executeCommand('ip addr add 10.0.0.1/24 dev eth0');
  await pc.executeCommand('ip link set eth0 up');
  await srv.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
  await srv.executeCommand('ip link set eth0 up');
  await srv.executeCommand('iptables -A INPUT -p tcp --dport 80 -j DROP');
  return { pc, session: new LinuxTerminalSession('t', pc) };
}

async function type(session: LinuxTerminalSession, text: string): Promise<void> {
  session.setInput(text);
  session.handleKey(key('Enter'));
  await settle();
}

async function wait(seconds: number): Promise<void> {
  for (let elapsed = 0; elapsed < seconds; elapsed++) { await clock.advance(1000); await settle(2); }
}

const texts = (session: LinuxTerminalSession): string[] => session.lines.map((line) => line.text);
const blocked = Symbol('blocked');
const within = <T>(promise: Promise<T>, ms = 300): Promise<T | typeof blocked> =>
  Promise.race([promise, new Promise<typeof blocked>((resolve) => setTimeout(() => resolve(blocked), ms))]);

describe('Ctrl-C interrompt un curl en attente', () => {
  it('TEMOIN — un curl vers un hote qui ne repond pas echoue au bout de 127 s, comme le noyau', async () => {
    const { session } = await lab();
    await type(session, 'curl http://10.0.0.2');
    await wait(126);
    expect(texts(session).some((line) => line.startsWith('curl: (28)'))).toBe(false);
    await wait(2);
    expect(texts(session)).toContain('curl: (28) Failed to connect to 10.0.0.2 port 80 after 127000 ms: Couldn\'t connect to server');
  });

  it('Ctrl-C ecrit ^C, le curl ne dit plus rien, et la commande suivante s execute aussitot', async () => {
    const { session } = await lab();
    await type(session, 'curl http://10.0.0.2');
    await wait(3);
    session.handleKey(key('c', true));
    await settle();
    expect(texts(session)).toContain('^C');
    await type(session, 'echo apres');
    expect(texts(session)).toContain('apres');
    await wait(200);
    expect(texts(session).some((line) => line.startsWith('curl: ('))).toBe(false);
  });

  it('la file de commandes de la machine est liberee : un autre terminal obtient sa reponse', async () => {
    const { pc, session } = await lab();
    const other = new LinuxTerminalSession('t2', pc);
    await type(session, 'curl http://10.0.0.2');
    await wait(2);
    session.handleKey(key('c', true));
    await type(other, 'echo libre');
    expect(texts(other)).toContain('libre');
  });

  it('le statut de sortie est 130', async () => {
    const { session } = await lab();
    await type(session, 'curl http://10.0.0.2');
    session.handleKey(key('c', true));
    await settle();
    await type(session, 'echo $?');
    expect(texts(session).filter((line) => line === '130')).toHaveLength(1);
  });

  it('ce qui etait tape d avance est jete par Ctrl-C', async () => {
    const { session } = await lab();
    await type(session, 'curl http://10.0.0.2');
    await type(session, 'echo fantome');
    session.handleKey(key('c', true));
    await settle();
    await wait(130);
    expect(texts(session).filter((line) => line === 'fantome')).toEqual([]);
  });
});

describe('ce qui est tape pendant un curl s execute apres lui, dans l ordre', () => {
  it('TEMOIN — les lignes tapees d avance s executent quand le curl a rendu la main', async () => {
    const { session } = await lab();
    await type(session, 'curl --connect-timeout 2 http://10.0.0.2');
    await type(session, 'echo premier');
    await type(session, 'echo second');
    await wait(4);
    const lines = texts(session);
    const failure = lines.findIndex((line) => line.startsWith('curl: (28)'));
    expect(failure).toBeGreaterThan(-1);
    expect(lines.indexOf('premier')).toBeGreaterThan(failure);
    expect(lines.indexOf('second')).toBeGreaterThan(lines.indexOf('premier'));
  });

  it('pendant l attente, la ligne tapee est affichee telle quelle, sans invite, et rien ne s execute encore', async () => {
    const { session } = await lab();
    await type(session, 'curl http://10.0.0.2');
    await type(session, 'echo patience');
    await wait(3);
    expect(texts(session)).toContain('echo patience');
    expect(session.lines.filter((line) => line.promptText !== undefined && line.text === 'echo patience')).toEqual([]);
    expect(texts(session)).not.toContain('patience');
  });
});

describe('le curl est un processus de la machine', () => {
  it('ps le voit pendant l attente et plus apres', async () => {
    const { pc, session } = await lab();
    await type(session, 'curl http://10.0.0.2');
    await wait(1);
    const running = (): number | undefined =>
      (pc as unknown as { executor: { processMgr: { list(): { comm: string; pid: number }[] } } })
        .executor.processMgr.list().find((p) => p.comm === 'curl')?.pid;
    expect(running()).toBeDefined();
    session.handleKey(key('c', true));
    await settle();
    expect(running()).toBeUndefined();
  });

  it('kill -INT du processus met fin au curl comme Ctrl-C', async () => {
    const { pc, session } = await lab();
    await type(session, 'curl http://10.0.0.2');
    await wait(1);
    const manager = (pc as unknown as { executor: { processMgr: { list(): { comm: string; pid: number }[]; kill(pid: number, signal: string): boolean } } }).executor.processMgr;
    manager.kill(manager.list().find((p) => p.comm === 'curl')!.pid, 'SIGINT');
    await settle();
    await type(session, 'echo libre');
    expect(texts(session)).toContain('libre');
  });
});

describe('un client qui ne sait pas se faire interrompre est libere quand meme', () => {
  it('Ctrl-C pendant un dig sans reponse rend la main : la commande suivante s execute', async () => {
    const { session } = await lab();
    await type(session, 'dig @10.0.0.2 example.com');
    await wait(3);
    session.handleKey(key('c', true));
    await settle();
    await type(session, 'echo libre');
    expect(texts(session)).toContain('^C');
    expect(texts(session)).toContain('libre');
  });

  it('timeout 3 dig rend la main apres 3 s avec le statut 124', async () => {
    const { pc } = await lab();
    const started = simulationNowMs();
    const done = pc.executeCommand('timeout 3 dig @10.0.0.2 example.com; echo statut=$?');
    for (let elapsed = 0; elapsed < 60; elapsed++) {
      const outcome = await within(done, 5);
      if (outcome !== blocked) {
        expect(String(outcome).split('\n').pop()).toBe('statut=124');
        expect(simulationNowMs() - started).toBeLessThan(8_000);
        return;
      }
      await clock.advance(1000);
    }
    expect.fail('timeout 3 dig never returned');
  });
});

describe('timeout coupe un curl au bout du delai demande', () => {
  it('timeout 5 curl rend la main apres 5 s avec le statut 124', async () => {
    const { pc } = await lab();
    const started = simulationNowMs();
    const done = pc.executeCommand('timeout 5 curl http://10.0.0.2; echo statut=$?');
    for (let elapsed = 0; elapsed < 200; elapsed++) {
      const outcome = await within(done, 5);
      if (outcome !== blocked) {
        expect(outcome).toBe('statut=124');
        expect(simulationNowMs() - started).toBeLessThan(10_000);
        return;
      }
      await clock.advance(1000);
    }
    expect.fail('timeout 5 curl never returned');
  });
});

describe('le terminal Windows a le meme defaut et la meme correction', () => {
  async function windowsLab(): Promise<{ session: WindowsTerminalSession }> {
    const pc = new WindowsPC('windows-pc', 'PC2');
    const srv = new LinuxServer('linux-server', 'SRV');
    new Cable('c').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
    await pc.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.1 255.255.255.0');
    await srv.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
    await srv.executeCommand('ip link set eth0 up');
    await srv.executeCommand('iptables -A INPUT -p tcp --dport 80 -j DROP');
    return { session: new WindowsTerminalSession('w', pc) };
  }

  async function typeWindows(session: WindowsTerminalSession, text: string): Promise<void> {
    session.setInput(text);
    session.handleKey(key('Enter'));
    await settle();
  }

  it('Ctrl-C interrompt un curl en attente, la commande suivante s execute, le statut est celui de Ctrl-C', async () => {
    const { session } = await windowsLab();
    await typeWindows(session, 'curl http://10.0.0.2');
    for (let elapsed = 0; elapsed < 3; elapsed++) { await clock.advance(1000); await settle(2); }
    session.handleKey(key('c', true));
    await settle();
    await typeWindows(session, 'echo %errorlevel%');
    await typeWindows(session, 'ver');
    const lines = session.lines.map((line) => line.text);
    expect(lines).toContain('^C');
    expect(lines.some((line) => line.startsWith('Microsoft Windows'))).toBe(true);
    expect(lines).toContain('-1073741510');
    expect(lines.some((line) => line.startsWith('curl: ('))).toBe(false);
  });
});
