/**
 * Une ecoute TCP garde le nombre que le programme a passe a `listen()`, borne par
 * `net.core.somaxconn`, et c'est lui que `ss -l` montre dans Send-Q.
 *
 * Mesure de depart (commit precedent), un hote LINUX : `TcpStack.listen` n'avait aucun
 * parametre de file d'attente ; `ss -ltn` imprimait `128` pour TOUTE ecoute, un nombre
 * ecrit en dur dans l'afficheur ; `sysctl net.core.somaxconn` repondait `cannot stat
 * /proc/sys/net/core/somaxconn` (aucun reglage `net.core` n'existait) ; la file des
 * connexions pretes a etre acceptees n'etait nulle part comptee.
 *
 * Autorite : noyau 5.15, lu. `__sys_listen` (`net/socket.c`) : « if ((unsigned int)backlog
 * > somaxconn) backlog = somaxconn » ; `inet_listen` (`net/ipv4/af_inet.c`) : `sk_max_ack_backlog
 * = backlog` a l'appel, jamais reborne ensuite ; `include/linux/socket.h` : `SOMAXCONN` vaut 4096 ;
 * `net/core/sysctl_net_core.c` : somaxconn est un entier non negatif ; `tcp_get_info` et
 * `inet_sk_diag_fill` : pour une ecoute, Recv-Q est `sk_ack_backlog` (les connexions pretes que
 * `accept()` n'a pas encore prises) et Send-Q est `sk_max_ack_backlog`.
 *
 * Ce qui est construit : `TcpListenOptions.backlog`, borne a l'ecoute par `TcpHost.listenBacklogLimit`
 * (somaxconn sur une machine Linux, 4096 ailleurs), `TcpListener.backlog`, `TcpStack.listenerQueuesOf`
 * (la file d'acceptation et la longueur maximale), le reglage `net.core.somaxconn` (lisible et
 * modifiable par `/proc/sys` et `sysctl`, 4096 par defaut) et `KernelKnobStore`, le magasin de reglages
 * que `LinuxIpv4Settings` et `LinuxCoreSettings` partagent.
 *
 * Ce qui n'est PAS construit : la file d'acceptation ne se remplit jamais, car chaque service ecrit son
 * `onAccept` et l'appelle des l'etablissement ; elle vaut donc 0 et la limite ne peut pas deborder
 * (aucun `ListenOverflows`). Une ecoute dont l'application ne prend pas les connexions demande un
 * `accept()` differe, qui n'existe pas encore.
 *
 * Discrimination (fichier copie sur origin/mandeng 75c5280d8) : NEUF cas sur dix tombent. Le dixieme
 * passe des deux cotes : c'est le TEMOIN (une ecoute sans parametre accepte toujours la connexion), qui
 * prouve que le banc ouvre une vraie connexion que les neuf autres interrogent.
 */
import { describe, it, expect } from 'vitest';
import { scriptedPeer, openPassive, PEER_ISN } from '../../support/tcpScriptedPeer';

describe('a listener keeps the backlog its program passed, capped by net.core.somaxconn', () => {
  it('the backlog given to listen() is the one reported', () => {
    const peer = scriptedPeer();
    const stack = peer.dut.getTcpStack();
    const listener = stack.listen(8080, { onAccept: () => {}, backlog: 128 });
    expect(stack.listenerQueuesOf(listener)).toEqual({ accept: 0, backlog: 128 });
  });

  it('a listener that passes nothing gets the kernel limit, 4096 on a 5.15 kernel', () => {
    const peer = scriptedPeer();
    const stack = peer.dut.getTcpStack();
    const listener = stack.listen(8080, { onAccept: () => {} });
    expect(stack.listenerQueuesOf(listener).backlog).toBe(4096);
  });

  it('a backlog above somaxconn is cut to it', () => {
    const peer = scriptedPeer();
    const stack = peer.dut.getTcpStack();
    const listener = stack.listen(8080, { onAccept: () => {}, backlog: 100_000 });
    expect(stack.listenerQueuesOf(listener).backlog).toBe(4096);
  });

  it('a backlog of zero is legal and kept', () => {
    const peer = scriptedPeer();
    const stack = peer.dut.getTcpStack();
    const listener = stack.listen(8080, { onAccept: () => {}, backlog: 0 });
    expect(stack.listenerQueuesOf(listener).backlog).toBe(0);
  });

  it('a backlog outside the integers is refused like the other listener parameters', () => {
    const peer = scriptedPeer();
    const stack = peer.dut.getTcpStack();
    expect(() => stack.listen(8080, { onAccept: () => {}, backlog: -1 })).toThrow(/backlog out of range.*EINVAL/);
    expect(() => stack.listen(8081, { onAccept: () => {}, backlog: 1.5 })).toThrow(/EINVAL/);
  });

  it('the accept queue holds nothing while the service accepts as the connection is established', () => {
    const peer = scriptedPeer();
    const stack = peer.dut.getTcpStack();
    const connection = openPassive(peer, [], PEER_ISN, 65535, { backlog: 5 });
    expect(connection.socket.state).toBe('established');
    const listener = stack.listListeners().find((candidate) => candidate.localPort === peer.ports.dut)!;
    expect(stack.listenerQueuesOf(listener)).toEqual({ accept: 0, backlog: 5 });
  });

  it('a listener that passes no backlog still accepts the connection', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    expect(connection.socket.state).toBe('established');
  });
});

describe('net.core.somaxconn is a real setting of the machine', () => {
  it('reads 4096 through /proc/sys and sysctl', async () => {
    const peer = scriptedPeer();
    expect((await peer.dut.executeCommand('cat /proc/sys/net/core/somaxconn')).trim()).toBe('4096');
    expect((await peer.dut.executeCommand('sysctl net.core.somaxconn')).trim()).toBe('net.core.somaxconn = 4096');
  });

  it('a listener opened after the change is cut to the new value, one opened before keeps its own', async () => {
    const peer = scriptedPeer();
    const stack = peer.dut.getTcpStack();
    const before = stack.listen(8080, { onAccept: () => {}, backlog: 3000 });
    await peer.dut.executeCommand('sudo sysctl -w net.core.somaxconn=100');
    const after = stack.listen(8081, { onAccept: () => {}, backlog: 3000 });
    expect(stack.listenerQueuesOf(before).backlog).toBe(3000);
    expect(stack.listenerQueuesOf(after).backlog).toBe(100);
    const unspecified = stack.listen(8082, { onAccept: () => {} });
    expect(stack.listenerQueuesOf(unspecified).backlog).toBe(100);
  });

  it('a negative or non-numeric value is refused and the setting is left alone', async () => {
    const peer = scriptedPeer();
    await peer.dut.executeCommand('sudo sysctl -w net.core.somaxconn=-5');
    await peer.dut.executeCommand('sudo sysctl -w net.core.somaxconn=many');
    expect((await peer.dut.executeCommand('cat /proc/sys/net/core/somaxconn')).trim()).toBe('4096');
  });
});
