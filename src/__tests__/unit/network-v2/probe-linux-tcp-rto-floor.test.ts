/**
 * Sur une machine Linux, le temporisateur de retransmission part de 200 ms comme
 * celui du noyau 5.15 : le plancher porte sur le terme de variance
 * (RTO = SRTT + max(200 ms, 4 x RTTVAR)), pas sur le RTO entier, et les vues qui
 * annoncent ces valeurs disent celles que la pile applique.
 *
 * Mesure de depart (commit precedent), pair SCRIPTE muet :
 *
 *   - un segment sans reponse repartait 1 s apres la poignee de main (arrondi a
 *     une seconde de la RFC 6298 §2.4), puis 3, 7 et 15 s ; le noyau repart a
 *     200 ms, puis 600, 1400 et 3000 ms. La poignee de main mesure un RTT de
 *     0 ms (livraison synchrone) : RTO = 0 + max(200 ms, 0) ;
 *   - un ACK qui tarde 40 ms donne SRTT 5 et RTTVAR 10, soit 5 + 200 = 205 ms
 *     (le plancher est sur le terme de variance) ; la pile aurait donne 1000 ;
 *   - la sonde de fenetre nulle partait a 1 s ; le noyau l'arme au RTO
 *     (`tcp_probe0_base`), soit 200 ms ;
 *   - tcp_retries2 se mesurait deja sur le modele du noyau (RTO de base de
 *     200 ms) alors que les RTO reels partaient de 1 s, et la pile tuait la
 *     connexion A la limite du modele, au milieu d'une attente, alors que le
 *     noyau ne l'evalue qu'a l'echeance du temporisateur (« TCP will effectively
 *     time out at the first RTO which exceeds the hypothetical timeout ») ; avec
 *     tcp_retries2 = 0 elle renoncait a la premiere echeance, le noyau retransmet
 *     une fois (`retransmits_timed_out` rend faux tant que `icsk_retransmits`
 *     vaut 0) ;
 *   - `/proc/net/snmp` imprimait `Ip: 1 64` et `Tcp: 1 200 120000` en dur : ni
 *     `ip_forward` ni `ip_default_ttl` ne s'y voyaient, et `netstat -s` disait
 *     `Forwarding: 2` quand `/proc/net/snmp` disait 1 : deux vues du meme fait,
 *     sur la meme machine, qui se contredisaient.
 *
 * Autorite (noyau 5.15, lus) : `net/ipv4/tcp_input.c` (`tcp_rtt_estimator` : la
 * premiere mesure pose `rttvar = max(mdev, tcp_rto_min_us)` ; `tcp_set_rto` :
 * « clamping at TCP_RTO_MIN is not required, current algo guarantees that rto is
 * higher »), `include/net/tcp.h` (`__tcp_set_rto` = srtt + rttvar ; TCP_RTO_MIN =
 * HZ/5, TCP_RTO_MAX = 120 s ; `tcp_probe0_base` = max(icsk_rto, TCP_RTO_MIN) ;
 * `tcp_mib_init` : RtoMin et RtoMax en ms), `net/ipv4/tcp_timer.c`
 * (`tcp_write_timeout`, `retransmits_timed_out`, `tcp_clamp_rto_to_user_timeout` :
 * seul le delai de l'utilisateur raccourcit le temporisateur),
 * `net/ipv4/tcp_metrics.c` (`tcp_init_metrics` : RTO ramene a 3 s quand la poignee
 * de main n'a rien mesure, RFC 6298 §5.7), `net/ipv4/proc.c`
 * (`snmp_seq_show_ipstats` : `FORWARDING ? 1 : 2` et `sysctl_ip_default_ttl`),
 * `Documentation/networking/ip-sysctl.rst`. RFC 6298 §4 : RTO = SRTT + max(G, K x
 * RTTVAR) ; l'arrondi a une seconde du §2.4 est un SHOULD que le noyau ne suit
 * pas, il prend G = 200 ms.
 *
 * Ce qui est construit : `RtoFloor` (granularite G et arrondi minimal) dans
 * `RttEstimator`, la RFC gardant G = 1 ms et l'arrondi a 1 s ; `TcpRetryPolicy.rtoFloor`,
 * que `LinuxIpv4Settings` remplit avec G = 200 ms et aucun arrondi ; la minuterie de
 * persistance qui part du RTO courant ; `TcpGiveUp.atExpiry` (la limite en temps
 * n'est evaluee qu'a l'echeance, jamais en raccourcissant le temporisateur, et la
 * premiere echeance retransmet toujours) pour les limites de Linux, le delai de
 * l'utilisateur gardant son raccourcissement ; `KernelIpFacts`
 * (transmission, TTL par defaut, RtoMin, RtoMax) rendu par `LinuxMachine` et lu par
 * `/proc/net/snmp` et `netstat -s`.
 *
 * Ce qui n'est PAS construit : la fenetre `mdev_max` du noyau (la variance retenue
 * est le maximum sur un RTT ; la pile garde l'estimateur de la RFC 6298, identique
 * tant que 4 x RTTVAR reste sous 200 ms), l'arrondi au jiffy (4 ms a HZ = 250, d'ou
 * les `rto:204` de `ss -i`), la sonde de queue TLP (`tcp_early_retrans` = 3 par
 * defaut ; sur une connexion SACK en etat Open le noyau envoie la premiere
 * retransmission a 2 x SRTT + 200 ms, un seul paquet en vol : meme instant que le
 * RTO ici, la suite differe ; les cas ci-dessous n'ont pas negocie SACK, ou le
 * noyau n'arme pas de sonde), les sondes de fenetre nulle du noyau (zero octet a
 * SND.UNA - 1, attente en `base << backoff`) : la pile envoie toujours un octet
 * de donnee et la laisse a la minuterie de retransmission, seule la premiere sonde
 * est donc mesuree ici.
 *
 * Discrimination (fichier copie sur le commit precedent) : QUINZE cas sur
 * dix-neuf tombent. Les quatre autres passent des deux cotes et sont des
 * TEMOINS : un hote sans profil garde l'arrondi a une seconde de la RFC 6298
 * §2.4, une machine Windows garde une seconde sur le fil, le delai de
 * l'utilisateur termine toujours la connexion pile a son echeance, la premiere
 * donnee qui suit un SYN retransmis attend toujours 3 s. Deux des quinze ne
 * tiennent que par `atExpiry` (tcp_retries2 = 8 et tcp_retries2 = 0), verifie en
 * retirant le drapeau ; les treize autres tiennent par le plancher et par les vues.
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, openActive, openPassive, PEER_ISN, type ScriptedPeer, type OpenConnection,
} from '../../support/tcpScriptedPeer';
import { RttEstimator } from '@/network/tcp/RttEstimator';
import { LinuxPC } from '@/network/devices/LinuxPC';

const SEGMENT_SIZE = 1460;

function dataSegments(peer: ScriptedPeer) {
  return peer.take().filter((segment) => String(segment.payload ?? '').length > 0);
}

function retransmissionTimes(peer: ScriptedPeer, untilMs: number, stepMs: number): number[] {
  const times: number[] = [];
  for (let elapsed = stepMs; elapsed <= untilMs; elapsed += stepMs) {
    peer.advance(stepMs);
    if (dataSegments(peer).length > 0) times.push(elapsed);
  }
  return times;
}

function sendOneSegment(peer: ScriptedPeer, connection: OpenConnection, text = 'x'): void {
  connection.socket.setNoDelay(true);
  peer.clear();
  connection.socket.send(text);
  expect(dataSegments(peer)).toHaveLength(1);
}

function acknowledgeAfter(peer: ScriptedPeer, connection: OpenConnection, delayMs: number, bytes: number): void {
  peer.advance(delayMs);
  peer.send({
    flags: 'A', sequence: connection.peerIsn + 1, acknowledgement: (connection.dutIsn + 1 + bytes) >>> 0,
  });
  peer.clear();
}

async function tcpLineOfSnmp(peer: ScriptedPeer): Promise<string[]> {
  const snmp = await peer.dut.executeCommand('cat /proc/net/snmp');
  return snmp.split('\n').filter((line) => line.startsWith('Tcp:'))[1].split(' ');
}

describe('a Linux machine retransmits 200 ms after a handshake that measured nothing (tcp_rtt_estimator, TCP_RTO_MIN)', () => {
  it('active open: an unacknowledged segment leaves again at 200 ms, not at one second', () => {
    const peer = scriptedPeer();
    const connection = openActive(peer);
    sendOneSegment(peer, connection);
    peer.advance(199);
    expect(dataSegments(peer)).toEqual([]);
    peer.advance(1);
    expect(dataSegments(peer)).toHaveLength(1);
  });

  it('passive open: the same 200 ms', () => {
    const peer = scriptedPeer();
    const connection = openPassive(peer);
    sendOneSegment(peer, connection);
    peer.advance(199);
    expect(dataSegments(peer)).toEqual([]);
    peer.advance(1);
    expect(dataSegments(peer)).toHaveLength(1);
  });

  it('the wait doubles at each timeout: 200, 600, 1400, 3000 and 6200 ms after the first transmission', () => {
    const peer = scriptedPeer();
    const connection = openActive(peer);
    sendOneSegment(peer, connection);
    expect(retransmissionTimes(peer, 6_300, 10)).toEqual([200, 600, 1_400, 3_000, 6_200]);
  });

  it('the wait stops doubling at the RtoMax that /proc/net/snmp prints: 120 s', async () => {
    const peer = scriptedPeer();
    const [, , rtoMin, rtoMax] = await tcpLineOfSnmp(peer);
    expect([rtoMin, rtoMax]).toEqual(['200', '120000']);
    const connection = openActive(peer);
    sendOneSegment(peer, connection);
    const times = retransmissionTimes(peer, 450_000, 100);
    expect(times.slice(8, 12)).toEqual([102_200, 204_600, 324_600, 444_600]);
    expect(times[10] - times[9]).toBe(Number(rtoMax));
  });

  it('the first retransmission leaves after the RtoMin that /proc/net/snmp prints', async () => {
    const peer = scriptedPeer();
    const rtoMin = Number((await tcpLineOfSnmp(peer))[2]);
    const connection = openActive(peer);
    sendOneSegment(peer, connection);
    peer.advance(rtoMin - 1);
    expect(dataSegments(peer)).toEqual([]);
    peer.advance(1);
    expect(dataSegments(peer)).toHaveLength(1);
  });
});

describe('the floor is on the variance term: RTO = SRTT + max(200 ms, 4 x RTTVAR), as the kernel computes it', () => {
  it('a peer that acknowledges after 40 ms leaves an RTO of 205 ms: SRTT 5, variance floored at 200', () => {
    const peer = scriptedPeer();
    const connection = openActive(peer);
    sendOneSegment(peer, connection, 'a');
    acknowledgeAfter(peer, connection, 40, 1);
    sendOneSegment(peer, connection, 'b');
    peer.advance(204);
    expect(dataSegments(peer)).toEqual([]);
    peer.advance(1);
    expect(dataSegments(peer)).toHaveLength(1);
  });

  it('the estimator alone: one 40 ms sample after the first gives 205, not the 200 a floor on the whole would give', () => {
    const estimator = new RttEstimator(1_000, 120_000, { granularityMs: 200, minRtoMs: 0 });
    estimator.sample(0);
    expect(estimator.currentRto()).toBe(200);
    estimator.sample(40);
    expect(estimator.currentRto()).toBe(205);
  });

  it('the first sample sets RTTVAR to half of it: a 150 ms first sample gives 150 + 300 = 450', () => {
    const estimator = new RttEstimator(1_000, 120_000, { granularityMs: 200, minRtoMs: 0 });
    estimator.sample(150);
    expect(estimator.currentRto()).toBe(450);
  });

  it('WITNESS: a host with no profile of its own keeps the RFC 6298 §2.4 round-up to one second', () => {
    const estimator = new RttEstimator();
    estimator.sample(0);
    expect(estimator.currentRto()).toBe(1_000);
    estimator.sample(40);
    expect(estimator.currentRto()).toBe(1_000);
  });

  it('WITNESS: a Windows machine keeps one second after the handshake, on the wire as well', () => {
    const peer = scriptedPeer('windows');
    const connection = openActive(peer);
    sendOneSegment(peer, connection);
    peer.advance(999);
    expect(dataSegments(peer)).toEqual([]);
    peer.advance(1);
    expect(dataSegments(peer)).toHaveLength(1);
  });
});

describe('a zero window is first probed one RTO after the refusal (tcp_probe0_base)', () => {
  function refused(): ScriptedPeer {
    const peer = scriptedPeer();
    const connection = openPassive(peer, [{ kind: 'mss', value: SEGMENT_SIZE }], PEER_ISN, 0);
    connection.socket.setNoDelay(true);
    peer.clear();
    connection.socket.send('hello');
    expect(dataSegments(peer)).toEqual([]);
    return peer;
  }

  it('the first probe leaves at 200 ms, not at one second', () => {
    const peer = refused();
    peer.advance(199);
    expect(dataSegments(peer)).toEqual([]);
    peer.advance(1);
    expect(dataSegments(peer)).toHaveLength(1);
  });
});

describe('the data timeout is read at the timer, as tcp_write_timeout reads it: the first timeout beyond the model kills the connection', () => {
  async function silentPeerAfterOneSample(
    retries2: number, retries1 = 3,
  ): Promise<{ peer: ScriptedPeer; connection: OpenConnection }> {
    const peer = scriptedPeer();
    await peer.dut.executeCommand(`sudo sysctl -w net.ipv4.tcp_retries2=${retries2}`);
    await peer.dut.executeCommand(`sudo sysctl -w net.ipv4.tcp_retries1=${retries1}`);
    const connection = openActive(peer);
    sendOneSegment(peer, connection, 'a');
    acknowledgeAfter(peer, connection, 40, 1);
    sendOneSegment(peer, connection, 'b');
    return { peer, connection };
  }

  it('tcp_retries2=8 gives a model of 102.2 s; with an RTO of 205 ms the timeouts fall at 52.2 s and 104.7 s, and the connection dies at the second', async () => {
    const { peer, connection } = await silentPeerAfterOneSample(8);
    peer.advance(102_300);
    expect(connection.socket.closed).toBe(false);
    peer.advance(2_500);
    expect(connection.socket.closed).toBe(true);
    expect(connection.socket.closeReason).toBe('timeout');
  });

  it('tcp_retries1=5 (model 12.6 s) is reported at the first timeout beyond it: 12.915 s when the RTO is 205 ms', async () => {
    const { peer, connection } = await silentPeerAfterOneSample(15, 5);
    const reported: number[] = [];
    connection.socket.onErrorReport((report) => { if (report.source === 'retransmission') reported.push(report.attempts); });
    peer.advance(12_900);
    expect(reported).toEqual([]);
    peer.advance(30);
    expect(reported).toHaveLength(1);
  });

  it('tcp_retries2=0: the first timeout still retransmits, the second kills the connection', async () => {
    const peer = scriptedPeer();
    await peer.dut.executeCommand('sudo sysctl -w net.ipv4.tcp_retries2=0');
    const connection = openActive(peer);
    sendOneSegment(peer, connection);
    peer.advance(200);
    expect(dataSegments(peer)).toHaveLength(1);
    expect(connection.socket.closed).toBe(false);
    peer.advance(399);
    expect(connection.socket.closed).toBe(false);
    peer.advance(1);
    expect(connection.socket.closed).toBe(true);
  });

  it('default tcp_retries2=15: fifteen retransmissions, the sixteenth timeout at 924.6 s kills the connection', () => {
    const peer = scriptedPeer();
    const connection = openActive(peer);
    sendOneSegment(peer, connection);
    const times = retransmissionTimes(peer, 924_500, 100);
    expect(times).toHaveLength(15);
    expect(connection.socket.closed).toBe(false);
    peer.advance(100);
    expect(connection.socket.closed).toBe(true);
  });

  it('WITNESS: a user timeout still shortens the timer so the connection ends exactly on it', () => {
    const peer = scriptedPeer();
    const connection = openActive(peer);
    connection.socket.setUserTimeout(1_000);
    sendOneSegment(peer, connection);
    peer.advance(999);
    expect(connection.socket.closed).toBe(false);
    peer.advance(1);
    expect(connection.socket.closed).toBe(true);
  });
});

describe('the first data after a SYN that had to be retransmitted waits 3 s (RFC 6298 §5.7, tcp_init_metrics)', () => {
  it('WITNESS: the floor does not shorten it', () => {
    const peer = scriptedPeer();
    const socket = peer.dut.getTcpStack().connect(peer.addresses.peer, peer.ports.peer)!;
    const syn = peer.last()!;
    peer.ports.dut = syn.sourcePort;
    peer.advance(1_000);
    peer.send({ flags: 'SA', sequence: PEER_ISN, acknowledgement: syn.sequence + 1 });
    peer.clear();
    socket.setNoDelay(true);
    socket.send('x');
    expect(dataSegments(peer)).toHaveLength(1);
    peer.advance(2_999);
    expect(dataSegments(peer)).toEqual([]);
    peer.advance(1);
    expect(dataSegments(peer)).toHaveLength(1);
  });
});

describe('/proc/net/snmp and netstat -s read the same facts as the sysctl that sets them', () => {
  const ipLine = async (pc: LinuxPC): Promise<string[]> => {
    const snmp = await pc.executeCommand('cat /proc/net/snmp');
    return snmp.split('\n').filter((line) => line.startsWith('Ip:'))[1].split(' ');
  };

  it('Forwarding is 2 until ip_forward is 1, then 1, in both views', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect((await ipLine(pc)).slice(1, 3)).toEqual(['2', '64']);
    expect(await pc.executeCommand('netstat -s')).toContain('Forwarding: 2');
    await pc.executeCommand('sudo sysctl -w net.ipv4.ip_forward=1');
    expect((await ipLine(pc)).slice(1, 3)).toEqual(['1', '64']);
    expect(await pc.executeCommand('netstat -s')).toContain('Forwarding: 1');
  });

  it('DefaultTTL follows ip_default_ttl', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('sudo sysctl -w net.ipv4.ip_default_ttl=100');
    expect((await ipLine(pc)).slice(1, 3)).toEqual(['2', '100']);
  });
});
