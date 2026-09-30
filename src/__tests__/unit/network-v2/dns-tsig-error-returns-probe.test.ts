/**
 * Sonde des réponses d'erreur TSIG (RFC 2845 §4.3, §4.5).
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 6 cas sur 8 tombent.
 *   - aucune réponse d'erreur ne portait d'enregistrement TSIG, alors que le
 *     §4.5 l'exige dès qu'une requête en portait un (l'erreur était calculée
 *     puis jetée) : BADKEY, BADSIG et BADTIME
 *   - l'ordre des contrôles était MAC puis temps ; le §4.5 impose clé, temps,
 *     MAC : une requête au secret faux ET à l'horloge périmée reçoit BADTIME
 *   - un message dont le temps signé recule par rapport au précédent message
 *     accepté pour la même clé n'était pas rejeté (§4.5.2, SHOULD)
 * Passent avant et après (témoins) : la requête valide reçoit une réponse
 * signée ; une requête non signée en politique sécurisée reçoit NOTAUTH sans
 * TSIG (rien à refléter).
 * Limite : RFC 8945, qui remplace la RFC 2845, n'est pas joignable depuis cet
 * environnement ; l'ordre des contrôles suit la RFC 2845 fournie dans docs/rfc/dns.
 */
import { describe, it, expect } from 'vitest';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { makeARecord } from '@/network/dns/wire/ResourceRecord';
import type { TsigRecordData } from '@/network/dns/wire/ResourceRecord';
import { buildUpdateMessage } from '@/network/dns/update/DnsUpdate';
import {
  authorizeUpdate, signIfKeyed, updateResponse, DnsUpdateRcode,
} from '@/network/dns/update/UpdateResponder';
import {
  signDnsMessage, TsigAlgorithm, TsigErrorCode, TsigKeyring, verifyDnsMessage, type TsigKey,
} from '@/network/dns/tsig/Tsig';
import { decodeDnsMessage, encodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';

const KEY: TsigKey = { name: 'lab-key.', algorithm: TsigAlgorithm.HMAC_SHA256, secret: 'shared' };
const NOW = 1_800_000_000;

function keyring(): TsigKeyring {
  const ring = new TsigKeyring();
  ring.add(KEY);
  return ring;
}

function request(key: TsigKey, at: number): { raw: Uint8Array; id: number } {
  const message = buildUpdateMessage({
    zone: 'example.com', zoneClass: DnsClass.IN, prerequisites: [],
    updates: [{ kind: 'add', record: makeARecord('h.example.com', 300, '192.0.2.9') }],
  }, 0x4242);
  return { raw: signDnsMessage(message, { key, timeSigned: at }), id: 0x4242 };
}

function answer(raw: Uint8Array, ring: TsigKeyring, now = NOW) {
  const auth = authorizeUpdate(raw, 'secure', ring, now);
  const query = decodeDnsMessage(raw);
  const response = signIfKeyed(updateResponse(query, auth.rcode), auth, now);
  const tsig = response.additionals.find((rr) => rr.data.type === RRType.TSIG);
  return { auth, response, tsig: tsig?.data as TsigRecordData | undefined, tsigName: tsig?.name };
}

describe('réponses d’erreur TSIG (RFC 2845 §4.3, §4.5)', () => {
  it('témoin : une requête valide reçoit NOERROR et une réponse signée', () => {
    const { auth, tsig } = answer(request(KEY, NOW).raw, keyring());
    expect(auth.rcode).toBe(0);
    expect(tsig?.error).toBe(0);
    expect(tsig?.mac.length).toBeGreaterThan(0);
  });

  it('témoin : une requête non signée en politique sécurisée reçoit NOTAUTH sans TSIG', () => {
    const message = buildUpdateMessage({
      zone: 'example.com', zoneClass: DnsClass.IN, prerequisites: [], updates: [],
    }, 7);
    const auth = authorizeUpdate(undefined, 'secure', keyring(), NOW);
    const response = signIfKeyed(updateResponse(message, auth.rcode), auth, NOW);
    expect(auth.rcode).toBe(DnsUpdateRcode.NOTAUTH);
    expect(response.additionals.some((rr) => rr.data.type === RRType.TSIG)).toBe(false);
  });

  it('clé inconnue : NOTAUTH avec un TSIG d’erreur BADKEY, MAC vide', () => {
    const { auth, tsig, tsigName } = answer(
      request({ ...KEY, name: 'other-key.' }, NOW).raw, keyring());
    expect(auth.rcode).toBe(DnsUpdateRcode.NOTAUTH);
    expect(tsig?.error).toBe(TsigErrorCode.BADKEY);
    expect(tsig?.mac.length).toBe(0);
    expect(tsigName).toBe('other-key');
    expect(tsig?.originalId).toBe(0x4242);
  });

  it('secret faux : NOTAUTH avec un TSIG d’erreur BADSIG, MAC vide', () => {
    const { tsig } = answer(request({ ...KEY, secret: 'wrong' }, NOW).raw, keyring());
    expect(tsig?.error).toBe(TsigErrorCode.BADSIG);
    expect(tsig?.mac.length).toBe(0);
  });

  it('horloge périmée : BADTIME signé, temps du client, heure serveur sur 6 octets', () => {
    const stale = NOW - 3600;
    const { tsig, response } = answer(request(KEY, stale).raw, keyring());
    expect(tsig?.error).toBe(TsigErrorCode.BADTIME);
    expect(tsig?.timeSigned).toBe(stale);
    expect(tsig?.otherData.length).toBe(6);
    expect(tsig?.otherData[5]).toBe(NOW & 0xff);
    expect(tsig?.mac.length).toBeGreaterThan(0);
    void response;
  });

  it('secret faux ET horloge périmée : BADTIME, le temps se contrôle avant le MAC', () => {
    const { tsig } = answer(request({ ...KEY, secret: 'wrong' }, NOW - 3600).raw, keyring());
    expect(tsig?.error).toBe(TsigErrorCode.BADTIME);
  });

  it('un temps signé antérieur à celui déjà accepté pour la clé est rejeté en BADTIME', () => {
    const ring = keyring();
    expect(answer(request(KEY, NOW).raw, ring).tsig?.error).toBe(0);
    const replay = answer(request(KEY, NOW - 10).raw, ring);
    expect(replay.tsig?.error).toBe(TsigErrorCode.BADTIME);
  });

  it('la réponse BADTIME se vérifie côté client : signée, liée au MAC de la requête', () => {
    const stale = NOW - 3600;
    const sent = request(KEY, stale);
    const { response } = answer(sent.raw, keyring());
    const requestMac = (verifyDnsMessage(sent.raw, { lookup: keyring().lookup, now: stale }) as {
      mac: Uint8Array;
    }).mac;
    const verdict = verifyDnsMessage(encodeDnsMessage(response), {
      lookup: keyring().lookup, now: stale, requestMac,
    });
    expect(verdict.status).toBe('ok');
  });
});
