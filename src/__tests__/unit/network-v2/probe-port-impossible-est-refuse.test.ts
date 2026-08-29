/**
 * Un port qu'aucun paquet ne peut porter ne se lie pas (audit de la pile
 * TCP/IP, lot 14).
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * `udpBind` et `TcpStack.listen` acceptaient TOUT :
 *
 *     port=99999  udpBind=true  tcpListen=accepte
 *     port=-1     udpBind=true  tcpListen=accepte
 *     port=65536  udpBind=true  tcpListen=accepte
 *     port=1.5    udpBind=true  tcpListen=accepte
 *     port=NaN    udpBind=true  tcpListen=accepte
 *
 * Le champ de port fait SEIZE BITS sur le fil : aucun paquet ne peut en
 * porter un seul de ces cinq. Ce qu'on obtenait donc etait un ecouteur
 * MUET — lie, visible dans la table, et hors d'atteinte de toute trame.
 * Une faute de frappe dans un laboratoire donnait un serveur qui ne
 * repond jamais, sans un mot d'erreur pour le dire ; et `NaN` se lie
 * meme proprement, `Map` acceptant `NaN` comme cle.
 *
 * ── Le correctif LIT ce que le depot avait deja ─────────────────────
 *
 * `core/ports/PortNumber.ts` porte la regle depuis longtemps —
 * « Construction fails fast on an out-of-range value, so an invalid port
 * can never propagate » — et `PortNumber.isValid` est exactement
 * `Number.isInteger(value) && value >= 0 && value <= 65535`, c'est-a-dire
 * la RFC 6335. Les deux points de liaison la lisent desormais au lieu de
 * n'en rien faire. C'est la regle du depot appliquee a la lettre : un
 * port de transport est un TYPE, et on analyse A LA FRONTIERE.
 *
 * Chaque plateforme refuse dans ses mots : `udpBind` rend `false`, comme
 * pour un port deja pris ; `listen` LEVE, comme il le fait deja pour
 * EADDRINUSE.
 *
 * ── Le port 0 reste accepte, et c'est deliberer ─────────────────────
 *
 * `MIN_PORT` vaut 0 : la RFC 6335 le compte dans la plage, et
 * `PortNumber.isValid(0)` est donc VRAI. Sur une vraie machine `bind(0)`
 * a un sens PARTICULIER — « attribue-m'en un ephemere » — que cette pile
 * n'implante pas. Le refuser serait s'ecarter de la plage normalisee ;
 * l'honorer serait une autre fonction. Il est donc laisse tel quel et
 * inscrit au `TODO.md`, plutot que tranche en passant.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * DEUX cas sur trois tombent — l'un par famille. Le TEMOIN est un port
 * ORDINAIRE, qui doit continuer a se lier des deux cotes : sans lui, une
 * garde qui refuserait TOUT passerait cette sonde.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const IMPOSSIBLES = [99999, -1, 65536, 1.5, NaN];

describe('un port impossible ne se lie pas', () => {
  it('udpBind les refuse tous', () => {
    const endpoint = new CiscoRouter('R').getUdpEndpoint();
    for (const port of IMPOSSIBLES) {
      expect(endpoint.udpBind(port, () => undefined, 'sonde'), `port ${port}`).toBe(false);
    }
  });

  it('TcpStack.listen les refuse tous, et le dit', () => {
    const stack = new LinuxPC('PC').getTcpStack();
    for (const port of IMPOSSIBLES) {
      expect(() => stack.listen(port, { onAccept: () => undefined }), `port ${port}`)
        .toThrow(/out of range/);
    }
  });

  it('TEMOIN : un port ordinaire se lie toujours, des deux cotes', () => {
    const endpoint = new CiscoRouter('R2').getUdpEndpoint();
    expect(endpoint.udpBind(1234, () => undefined, 'sonde')).toBe(true);
    const stack = new LinuxPC('PC2').getTcpStack();
    expect(() => stack.listen(8080, { onAccept: () => undefined })).not.toThrow();
  });
});
