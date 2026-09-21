/*
 * Le port 0 veut dire « attribue-m'en un », pas « pose-toi sur zero ».
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 *     udpBind(0)  -> true
 *     listen(0)   -> localPort = 0
 *
 * Les deux points de liaison posaient un ecouteur sur le port 0
 * LITTERAL. `PortNumber.isValid(0)` est vrai — la RFC 6335 compte 0
 * dans la plage — donc rien ne s'y opposait. L'ecouteur obtenu n'etait
 * atteignable par aucune trame ordinaire, puisque rien n'adresse le
 * port 0 : une liaison qui reussit et ne sert a rien, sans un mot pour
 * le dire.
 *
 * ── L'autorite ──────────────────────────────────────────────────────
 *
 * POSIX, `bind()` : un port de 0 demande au systeme d'en ATTRIBUER un
 * dans la plage ephemere, que l'appelant relit ensuite par
 * `getsockname()`. La RFC 6335 §6 va dans le meme sens en reservant le
 * 0 : « Port number 0 is reserved and should not be used ». C'est le
 * seul des trois comportements envisageables qui enseigne ce qu'une
 * vraie machine fait — refuser s'ecarterait de la plage normalisee que
 * `PortNumber` encode, et laisser tel quel garde une liaison morte.
 *
 * ── Comment l'appelant relit le port, sans campagne de signatures ───
 *
 * Cote TCP, `listen()` rendait DEJA un `TcpListener` qui porte son
 * `localPort` : c'est le `getsockname()` du simulateur, et aucune
 * signature ne bouge.
 *
 * Cote UDP, `udpBind` rendait un booleen. Il rend desormais le port
 * LIE, ou `false` en cas d'echec. Un port est toujours >= 1 apres ce
 * changement, donc toujours vrai au sens booleen : les appelants qui
 * ecrivaient `if (udpBind(...))` gardent exactement leur comportement,
 * et seuls les quatre ports etroits qui ANNONCAIENT `boolean` ont du
 * etre elargis.
 *
 * L'allocation reutilise ce qui existait — `nextEphemeral` pour TCP,
 * qui tient deja compte des sockets ET des ecouteurs, et
 * `allocateEphemeralPort` pour UDP.
 *
 * ── Discrimination (`git stash`) ────────────────────────────────────
 *
 * TROIS cas sur cinq tombent : le port TCP attribue, le port UDP rendu,
 * et l'unicite de deux liaisons successives.
 *
 * Les DEUX autres sont des TEMOINS et passent des deux cotes : un port
 * EXPLICITE reste pose exactement la ou on le demande — sans lui, une
 * pile qui attribuerait au hasard pour TOUT LE MONDE passerait les
 * trois premiers — et un port impossible reste refuse.
 *
 * Le temoin du port explicite se lit sur l'EMPLACEMENT de la liaison et
 * non sur la valeur rendue : une seconde liaison du meme 5353 doit etre
 * refusee. Ecrit sur la valeur rendue, il aurait tombe des deux cotes
 * — il n'aurait alors rien temoigne, puisque c'est precisement cette
 * valeur que le changement modifie.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { MAX_PORT } from '@/network/core/ports/PortNumber';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function host(): LinuxPC {
  const pc = new LinuxPC('A');
  pc.powerOn();
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  return pc;
}

describe('binding port 0 asks for an ephemeral port (POSIX bind)', () => {
  it('gives a TCP listener a real port from the ephemeral range', () => {
    const listener = host().getTcpStack().listen(0, { onAccept: () => {} });

    const pc = host();
    const range = pc.getTcpStack().getEphemeralRange();
    const listener2 = pc.getTcpStack().listen(0, { onAccept: () => {} });

    expect(listener.localPort).not.toBe(0);
    expect(listener2.localPort).toBeGreaterThanOrEqual(range.min);
    expect(listener2.localPort).toBeLessThanOrEqual(Math.min(range.max, MAX_PORT));
  });

  it('hands the UDP caller back the port it was actually given', () => {
    const pc = host();
    const range = pc.getSocketTable().getEphemeralRange();
    const bound = pc.udpBind(0, () => {}, 'probe');

    expect(bound).not.toBe(false);
    expect(bound).not.toBe(0);
    expect(bound as number).toBeGreaterThanOrEqual(range.min);
    expect(bound as number).toBeLessThanOrEqual(range.max);
  });

  it('never hands the same port to two successive bindings', () => {
    const pc = host();

    const first = pc.getTcpStack().listen(0, { onAccept: () => {} });
    const second = pc.getTcpStack().listen(0, { onAccept: () => {} });
    const udpFirst = pc.udpBind(0, () => {}, 'one');
    const udpSecond = pc.udpBind(0, () => {}, 'two');

    expect(second.localPort).not.toBe(first.localPort);
    expect(udpSecond).not.toBe(udpFirst);
  });

  it('WITNESS: an explicit port is still bound exactly where asked', () => {
    const pc = host();

    const listener = pc.getTcpStack().listen(8080, { onAccept: () => {} });
    pc.udpBind(5353, () => {}, 'mdns');

    expect(listener.localPort).toBe(8080);
    expect(pc.udpBind(5353, () => {}, 'mdns-again')).toBe(false);
  });

  it('WITNESS: an impossible port is still refused', () => {
    const pc = host();

    expect(() => pc.getTcpStack().listen(65536, { onAccept: () => {} })).toThrow(/EINVAL/);
    expect(() => pc.getTcpStack().listen(-1, { onAccept: () => {} })).toThrow(/EINVAL/);
  });
});
