/**
 * §F5.7 — l'état `D`, et pourquoi `kill -9` n'y peut rien.
 *
 * Un processus bloqué dans un appel système ininterruptible est hors de
 * portée des signaux. C'est la panne la plus déroutante de la famille F5,
 * parce que **la commande réussit** : le noyau accepte le signal, `kill`
 * sort avec 0, l'opérateur n'a aucun message d'erreur — et le processus est
 * toujours là. L'état `D` existait dans le type `ProcessState` et servait
 * aux threads noyau, mais `kill()` ne le consultait jamais : un `kill -9`
 * emportait un processus en `D` comme n'importe quel autre.
 *
 * Le détail qui fait tout : **le signal n'est pas perdu, il est mis en
 * attente**. Linux l'empile et le délivre à l'instant où la tâche quitte
 * `D`. C'est ce qui rend la réparation spectaculaire — le processus meurt
 * d'un `kill -9` envoyé bien plus tôt, dès que la ressource revient. Le
 * jeter donnerait un processus qui survit à sa libération, ce qui n'arrive
 * jamais.
 *
 * La cause modélisée est celle du PRD : un montage réseau dont le serveur
 * a disparu. **Aucun protocole NFS n'est implémenté** — ce qui décide, c'est
 * que le serveur soit encore atteignable à travers les vrais câbles depuis
 * cette machine, le fait physique que le simulateur connaît vraiment.
 *
 * Limite assumée, et énoncée plutôt que contournée : un accès au PREMIER
 * PLAN ne fige pas ce shell. La chaîne d'exécution est synchrone de bout en
 * bout (même mur que `SELECT … FOR UPDATE` côté Oracle), donc la forme
 * observable est l'accès lancé en arrière-plan — ce qu'un opérateur fait de
 * toute façon dès qu'il soupçonne un montage mort.
 *
 * Écrire l'équivalent e2e a d'ailleurs révélé que le terminal interactif ne
 * lançait PAS `ls /mnt/data &` : il répondait un prompt de continuation
 * parce que `incompleteInput.ts` enregistrait un `&` seul comme `&&`. Cette
 * incohérence est corrigée (`incomplete-input.test.ts`), et le spec e2e
 * exerce donc bien le même scénario que ce fichier.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const MASK = new SubnetMask('255.255.255.0');

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

interface Lab { cli: LinuxServer; srv: LinuxServer; sw: GenericSwitch; cable: Cable }

/** CLI —— SW —— SRV, avec /mnt/data monté en NFS depuis SRV. */
async function lab(): Promise<Lab> {
  const cli = new LinuxServer('linux-server', 'CLI');
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV');
  cli.configureInterface('eth0', new IPAddress('10.0.0.1'), MASK);
  srv.configureInterface('eth0', new IPAddress('10.0.0.2'), MASK);
  new Cable('c1').connect(cli.getPort('eth0')!, sw.getPorts()[0]);
  const cable = new Cable('c2');
  cable.connect(srv.getPort('eth0')!, sw.getPorts()[1]);

  await cli.executeCommand('mkdir -p /mnt/data');
  await cli.executeCommand('mount -t nfs 10.0.0.2:/export /mnt/data');
  return { cli, srv, sw, cable };
}

/** L'état que `ps` donne pour ce pid. */
async function stateOf(d: LinuxServer, pid: string): Promise<string | undefined> {
  const ps = await d.executeCommand('ps aux');
  return ps.split('\n').find((l) => l.trim().split(/\s+/)[1] === pid)
    ?.trim().split(/\s+/)[7];
}

/** Le pid annoncé par `cmd &` — `[1] 1234`. */
function bgPid(announce: string): string {
  const m = announce.match(/\[\d+\]\s+(\d+)/);
  expect(m, `pas d'annonce de job dans « ${announce} »`).toBeTruthy();
  return m![1];
}

/**
 * Le processus vit-il encore ? Le pid seul ne suffit pas : il est recyclé,
 * et le `ps` qui pose la question hérite volontiers du numéro qu'on vient
 * de libérer. La commande doit correspondre aussi.
 */
async function alive(d: LinuxServer, pid: string, comm: string): Promise<boolean> {
  const ps = await d.executeCommand('ps aux');
  return ps.split('\n').some((l) => {
    const f = l.trim().split(/\s+/);
    return f[1] === pid && l.includes(comm);
  });
}

describe('un montage réseau vivant ne bloque personne', () => {
  it('le montage est là, avec son serveur', async () => {
    const { cli } = await lab();

    const out = await cli.executeCommand('mount');
    expect(out).toContain('10.0.0.2:/export on /mnt/data type nfs');
  });

  it('un accès en arrière-plan se termine normalement', async () => {
    const { cli } = await lab();

    const pid = bgPid(await cli.executeCommand('ls /mnt/data &'));

    // Serveur joignable : rien ne dort, le job a fait son travail.
    expect(await stateOf(cli, pid)).not.toBe('D');
  });
});

describe('§F5.7 — le serveur disparaît : l\'accès part en `D`', () => {
  it('`ps` montre l\'état D', async () => {
    const { cli, cable } = await lab();
    cable.disconnect();

    const pid = bgPid(await cli.executeCommand('ls /mnt/data &'));

    expect(await stateOf(cli, pid)).toBe('D');
  });

  it('un chemin hors du montage n\'est pas affecté', async () => {
    const { cli, cable } = await lab();
    cable.disconnect();

    const pid = bgPid(await cli.executeCommand('ls /etc &'));

    // La panne doit être celle du montage, pas de la machine entière.
    expect(await stateOf(cli, pid)).not.toBe('D');
  });
});

describe('§F5.7 — `kill -9` réussit et ne tue rien', () => {
  it('le processus survit, et la commande ne dit rien', async () => {
    const { cli, cable } = await lab();
    cable.disconnect();
    const pid = bgPid(await cli.executeCommand('ls /mnt/data &'));

    // Aucun message d'erreur : c'est exactement ce qui égare l'opérateur.
    expect(await cli.executeCommand(`kill -9 ${pid}`)).toBe('');
    expect(await alive(cli, pid, '/mnt/data')).toBe(true);
    expect(await stateOf(cli, pid)).toBe('D');
  });

  it('SIGTERM et SIGSTOP restent sans effet eux aussi', async () => {
    const { cli, cable } = await lab();
    cable.disconnect();
    const pid = bgPid(await cli.executeCommand('ls /mnt/data &'));

    await cli.executeCommand(`kill -15 ${pid}`);
    await cli.executeCommand(`kill -STOP ${pid}`);

    // `T` (stoppé) serait déjà un signal reçu : rien ne passe en `D`.
    expect(await stateOf(cli, pid)).toBe('D');
  });
});

describe('§F5.7 — à la libération, les signaux en attente tombent', () => {
  it('`umount -l` libère, et le `kill -9` d\'avant tue enfin', async () => {
    const { cli, cable } = await lab();
    cable.disconnect();
    const pid = bgPid(await cli.executeCommand('ls /mnt/data &'));
    await cli.executeCommand(`kill -9 ${pid}`);
    expect(await alive(cli, pid, '/mnt/data')).toBe(true);

    await cli.executeCommand('umount -l /mnt/data');

    // Le signal était empilé, pas perdu : il s'applique maintenant.
    expect(await alive(cli, pid, '/mnt/data')).toBe(false);
  });

  it('sans signal en attente, la libération rend simplement le processus', async () => {
    const { cli, cable } = await lab();
    cable.disconnect();
    const pid = bgPid(await cli.executeCommand('ls /mnt/data &'));

    await cli.executeCommand('umount -l /mnt/data');

    // Personne ne l'a tué : il repart en sommeil interruptible.
    expect(await alive(cli, pid, '/mnt/data')).toBe(true);
    expect(await stateOf(cli, pid)).toBe('S');
  });

  it('le retour du serveur libère aussi — sans rien démonter', async () => {
    const { cli, srv, sw, cable } = await lab();
    cable.disconnect();
    const pid = bgPid(await cli.executeCommand('ls /mnt/data &'));
    await cli.executeCommand(`kill -9 ${pid}`);

    // On rebranche : la ressource est revenue.
    new Cable('c3').connect(srv.getPort('eth0')!, sw.getPorts()[2]);
    await cli.executeCommand('ls /mnt/data &'); // un accès qui, lui, passe

    // Le montage est toujours là — la réparation n'a rien coûté.
    expect(await cli.executeCommand('mount')).toContain('/mnt/data');
  });
});

describe('une machine intacte ne voit jamais rien de tout cela', () => {
  it('sans montage réseau, aucun processus ne part en D', async () => {
    const pc = new LinuxServer('linux-server', 'SEUL');
    pc.powerOn();

    const pid = bgPid(await pc.executeCommand('ls /etc &'));

    expect(await stateOf(pc, pid)).not.toBe('D');
    await pc.executeCommand(`kill -9 ${pid}`);
    expect(await alive(pc, pid, 'ls /etc')).toBe(false);
  });
});
