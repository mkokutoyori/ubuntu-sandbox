/**
 * `TcpStateMachine` — ce qui distingue l'inspection a etats d'un suivi de
 * tuples.
 *
 * BRD-Firewall §10.4. C'est precisement ce que `LinuxIptablesManager` n'a
 * pas : sa table de suivi ne porte qu'un horodatage par tuple, donc elle
 * sait dire ESTABLISHED et rien d'autre.
 *
 * Le contre-test central du module (UC-1) est ici : `ACLEngine`'s
 * `tcpEstablished` regarde les DRAPEAUX du paquet courant, si bien qu'un
 * paquet force avec ACK positionne passe. C'est la faiblesse historique des
 * ACL reflexives, et c'est exactement ce que la machine a etats corrige —
 * un ACK sans session est refuse parce qu'il n'y a pas de session, pas
 * parce que ses drapeaux deplaisent.
 *
 * Les cinq controles du §10.4.2 ont chacun leur motif de rejet DISTINCT.
 * Les confondre serait perdre l'essentiel de la valeur pedagogique : « ce
 * n'est pas un SYN » et « ces drapeaux n'existent pas » envoient
 * l'apprenant a deux endroits differents.
 *
 * Les scans nmap classiques sont des cas a part entiere, parce qu'un
 * laboratoire de scan contre un pare-feu correctement configure est
 * l'exercice le plus parlant qui soit — et qu'il exige que NULL, FIN et
 * Xmas soient distingues du SYN.
 */

import { describe, it, expect } from 'vitest';
import {
  TcpStateMachine,
  tcpFlagsAreValid,
  type TcpSessionState,
} from '@/network/devices/firewall/session/TcpStateMachine';
import type { TCPFlags } from '@/network/core/types';

function flags(set: Partial<TCPFlags>): TCPFlags {
  return { syn: false, ack: false, fin: false, rst: false, psh: false, urg: false, ...set };
}

const SYN = flags({ syn: true });
const SYN_ACK = flags({ syn: true, ack: true });
const ACK = flags({ ack: true });
const FIN_ACK = flags({ fin: true, ack: true });
const RST = flags({ rst: true });

function machine(): TcpStateMachine {
  return new TcpStateMachine();
}

function established(): TcpStateMachine {
  const m = machine();
  m.onFirstPacket(SYN);
  m.onPacket(SYN_ACK, 's2c');
  m.onPacket(ACK, 'c2s');
  return m;
}

describe('TcpStateMachine — la poignee de main', () => {
  it('un SYN ouvre la session en syn-sent', () => {
    const m = machine();

    expect(m.onFirstPacket(SYN).accepted).toBe(true);
    expect(m.state).toBe<TcpSessionState>('syn-sent');
  });

  it('le SYN-ACK de retour fait passer en syn-received', () => {
    const m = machine();
    m.onFirstPacket(SYN);

    expect(m.onPacket(SYN_ACK, 's2c').accepted).toBe(true);
    expect(m.state).toBe<TcpSessionState>('syn-received');
  });

  it('l\'ACK final etablit la session', () => {
    const m = machine();
    m.onFirstPacket(SYN);
    m.onPacket(SYN_ACK, 's2c');

    expect(m.onPacket(ACK, 'c2s').accepted).toBe(true);
    expect(m.state).toBe<TcpSessionState>('established');
  });

  it('une session etablie accepte des paquets dans les deux sens', () => {
    const m = established();

    expect(m.onPacket(ACK, 'c2s').accepted).toBe(true);
    expect(m.onPacket(ACK, 's2c').accepted).toBe(true);
    expect(m.state).toBe<TcpSessionState>('established');
  });
});

describe('TcpStateMachine — UC-1, le premier paquet non-SYN', () => {
  it('refuse un ACK comme premier paquet, avec le motif no-session-non-syn', () => {
    const m = machine();

    const verdict = m.onFirstPacket(ACK);

    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toBe('no-session-non-syn');
  });

  it('refuse un FIN comme premier paquet', () => {
    expect(machine().onFirstPacket(FIN_ACK).accepted).toBe(false);
  });

  it('refuse un RST comme premier paquet', () => {
    expect(machine().onFirstPacket(RST).accepted).toBe(false);
  });

  it('le contre-test de l\'ACL reflexive : un ACK FORGE ne passe pas', () => {
    const m = machine();

    expect(m.onFirstPacket(flags({ ack: true, psh: true })).accepted).toBe(false);
  });

  it('accepte un premier paquet non-SYN quand le controle est desactive', () => {
    const m = new TcpStateMachine({ synCheck: false });

    const verdict = m.onFirstPacket(ACK);

    expect(verdict.accepted).toBe(true);
    expect(m.state).toBe<TcpSessionState>('established');
  });
});

describe('TcpStateMachine — drapeaux invalides et scans', () => {
  it('refuse un segment SANS aucun drapeau — le NULL scan', () => {
    const verdict = machine().onFirstPacket(flags({}));

    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toBe('invalid-tcp-flags');
  });

  it('refuse SYN+FIN — combinaison qui n\'existe pas', () => {
    const verdict = machine().onFirstPacket(flags({ syn: true, fin: true }));

    expect(verdict.reason).toBe('invalid-tcp-flags');
  });

  it('refuse FIN+PSH+URG — le Xmas scan', () => {
    const verdict = machine().onFirstPacket(flags({ fin: true, psh: true, urg: true }));

    expect(verdict.reason).toBe('invalid-tcp-flags');
  });

  it('refuse SYN+RST', () => {
    expect(machine().onFirstPacket(flags({ syn: true, rst: true })).reason).toBe('invalid-tcp-flags');
  });

  it('refuse FIN seul sans ACK — le FIN scan', () => {
    const verdict = machine().onFirstPacket(flags({ fin: true }));

    expect(verdict.accepted).toBe(false);
  });

  it('distingue « drapeaux invalides » de « pas un SYN » — deux motifs, deux diagnostics', () => {
    const invalide = machine().onFirstPacket(flags({ syn: true, fin: true }));
    const pasSyn = machine().onFirstPacket(ACK);

    expect(invalide.reason).toBe('invalid-tcp-flags');
    expect(pasSyn.reason).toBe('no-session-non-syn');
    expect(invalide.reason).not.toBe(pasSyn.reason);
  });

  it('tcpFlagsAreValid accepte les combinaisons legitimes', () => {
    for (const f of [SYN, SYN_ACK, ACK, FIN_ACK, RST, flags({ ack: true, psh: true })]) {
      expect(tcpFlagsAreValid(f)).toBe(true);
    }
  });

  it('tcpFlagsAreValid refuse les combinaisons illegitimes', () => {
    for (const f of [
      flags({}),
      flags({ syn: true, fin: true }),
      flags({ syn: true, rst: true }),
      flags({ fin: true, psh: true, urg: true }),
    ]) {
      expect(tcpFlagsAreValid(f)).toBe(false);
    }
  });
});

describe('TcpStateMachine — transitions interdites', () => {
  it('refuse un FIN avant l\'etablissement, avec le motif tcp-state-violation', () => {
    const m = machine();
    m.onFirstPacket(SYN);

    const verdict = m.onPacket(FIN_ACK, 's2c');

    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toBe('tcp-state-violation');
  });

  it('refuse un SYN-ACK venant du CLIENT', () => {
    const m = machine();
    m.onFirstPacket(SYN);

    expect(m.onPacket(SYN_ACK, 'c2s').accepted).toBe(false);
  });

  it('accepte la retransmission du SYN initial', () => {
    const m = machine();
    m.onFirstPacket(SYN);

    expect(m.onPacket(SYN, 'c2s').accepted).toBe(true);
    expect(m.state).toBe<TcpSessionState>('syn-sent');
  });
});

describe('TcpStateMachine — fermeture', () => {
  it('un FIN fait passer en fin-wait-1', () => {
    const m = established();

    expect(m.onPacket(FIN_ACK, 'c2s').accepted).toBe(true);
    expect(m.state).toBe<TcpSessionState>('fin-wait-1');
  });

  it('deroule la fermeture complete jusqu\'a time-wait', () => {
    const m = established();
    m.onPacket(FIN_ACK, 'c2s');
    m.onPacket(ACK, 's2c');
    expect(m.state).toBe<TcpSessionState>('fin-wait-2');

    m.onPacket(FIN_ACK, 's2c');
    expect(m.state).toBe<TcpSessionState>('last-ack');

    m.onPacket(ACK, 'c2s');
    expect(m.state).toBe<TcpSessionState>('time-wait');
  });

  it('un RST ferme immediatement depuis established', () => {
    const m = established();

    expect(m.onPacket(RST, 's2c').accepted).toBe(true);
    expect(m.state).toBe<TcpSessionState>('closed');
  });

  it('un RST ferme immediatement depuis syn-sent — le refus de connexion', () => {
    const m = machine();
    m.onFirstPacket(SYN);

    m.onPacket(RST, 's2c');

    expect(m.state).toBe<TcpSessionState>('closed');
  });

  it('accepte encore des donnees en fin-wait-1 — la fermeture est a demi', () => {
    const m = established();
    m.onPacket(FIN_ACK, 'c2s');

    expect(m.onPacket(ACK, 's2c').accepted).toBe(true);
  });
});

describe('TcpStateMachine — delais par etat', () => {
  it('la poignee de main a un delai court', () => {
    const m = machine();
    m.onFirstPacket(SYN);

    expect(m.timeoutSec).toBe(30);
  });

  it('une session etablie a un delai long', () => {
    expect(established().timeoutSec).toBe(3600);
  });

  it('time-wait a un delai court', () => {
    const m = established();
    m.onPacket(FIN_ACK, 'c2s');
    m.onPacket(ACK, 's2c');
    m.onPacket(FIN_ACK, 's2c');
    m.onPacket(ACK, 'c2s');

    expect(m.timeoutSec).toBe(30);
  });

  it('honore les delais fournis par le profil', () => {
    const m = new TcpStateMachine({ timeouts: { established: 1800, handshake: 20, timeWait: 15, closing: 10 } });
    m.onFirstPacket(SYN);
    expect(m.timeoutSec).toBe(20);

    m.onPacket(SYN_ACK, 's2c');
    m.onPacket(ACK, 'c2s');
    expect(m.timeoutSec).toBe(1800);
  });
});

describe('TcpStateMachine — rafraichissement', () => {
  it('un paquet ACCEPTE demande le rafraichissement de la session', () => {
    const m = established();

    expect(m.onPacket(ACK, 'c2s').refreshes).toBe(true);
  });

  it('un paquet REFUSE ne rafraichit PAS — sinon un attaquant maintiendrait la session', () => {
    const m = established();

    const verdict = m.onPacket(flags({ syn: true, fin: true }), 'c2s');

    expect(verdict.accepted).toBe(false);
    expect(verdict.refreshes).toBe(false);
  });
});
