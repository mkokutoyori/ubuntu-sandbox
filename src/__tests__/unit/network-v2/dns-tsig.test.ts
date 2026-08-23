/**
 * RFC 8945 (ex-2845) — TSIG : la mise a jour dynamique est AUTHENTIFIEE.
 *
 * Le condense est le vrai HMAC de `src/crypto/mac/hmac.ts`, sur les
 * octets reellement emis : le message, prive de son propre
 * enregistrement TSIG, avec son compte d'additionnels decremente et son
 * identifiant d'origine remis en place, suivi des « variables TSIG » du
 * §5.3.2. La disposition est attestee contre `miekg/dns` (`tsig.go`),
 * une implementation deployee, `rfc-editor.org` et `datatracker.ietf.org`
 * etant EGRESS_BLOCKED depuis cette session.
 *
 * Tout est neuf ici, donc `git stash` ne discrimine rien : la sonde
 * n'oppose pas un avant et un apres mais une signature VALIDE a chacune
 * des facons dont elle peut etre fausse — mauvais secret, cle inconnue,
 * horloge hors tolerance, octet du corps modifie, enregistrement ajoute
 * apres coup, condense de demande substitue. Le cas « un message NON
 * signe » est le TEMOIN : il doit etre reconnu comme absent de
 * signature, et non comme un faux.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Zone } from '@/network/dns/zone/Zone';
import { makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import { PrimaryZoneAgent } from '@/network/dns/transfer/PrimaryZoneAgent';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { sendDynamicUpdate } from '@/network/dns/update/DynamicUpdateClient';
import { buildUpdateMessage, type DnsUpdateRequest } from '@/network/dns/update/DnsUpdate';
import type { UpdateSecurityPolicy } from '@/network/dns/update/UpdateResponder';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { makeARecord } from '@/network/dns/wire/ResourceRecord';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import {
  signDnsMessage, verifyDnsMessage, TsigAlgorithm, TsigErrorCode, TsigKeyring,
  type TsigKey,
} from '@/network/dns/tsig/Tsig';

const CLE: TsigKey = {
  name: 'cle-labo.', algorithm: TsigAlgorithm.HMAC_SHA256, secret: 'secret-partage',
};
const AUTRE: TsigKey = { ...CLE, secret: 'pas-le-meme' };
const MAINTENANT = 1_800_000_000;

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const ORIGIN = 'example.com';
const SERVEUR = new IPAddress('10.0.0.1');

async function laboZone(updatePolicy: UpdateSecurityPolicy = 'none') {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const hote = new LinuxServer('linux-server', 'ns1', 0, 0);
  const client = new LinuxPC('linux-pc', 'poste', 0, 0);
  const masque = new SubnetMask('255.255.255.0');
  [hote, client].forEach((d, i) => new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]));
  hote.getPorts()[0].configureIP(SERVEUR, masque);
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.100'), masque);

  const zone = new Zone(ORIGIN, makeSoaRecord(ORIGIN, 3600, {
    mname: `ns1.${ORIGIN}`, rname: `hostmaster.${ORIGIN}`,
    serial: 2026070100, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  const serveur = new PrimaryZoneAgent(hote, zone, { updatePolicy });
  serveur.start();
  return { client, serveur };
}

const demande = (): DnsUpdateRequest => ({
  zone: ORIGIN, zoneClass: DnsClass.IN, prerequisites: [],
  updates: [{ kind: 'add', record: makeARecord(`poste.${ORIGIN}`, 300, '10.0.0.100') }],
});

function messageNu(): DnsMessage {
  return {
    id: 0x1234,
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname: 'www.example.com', qtype: RRType.A, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

const lookup = (cle: TsigKey) => {
  const trousseau = new TsigKeyring();
  trousseau.add(cle);
  return trousseau.lookup;
};

describe('un message signe se verifie', () => {
  it('la signature porte un enregistrement TSIG en fin de section additionnelle', () => {
    const octets = signDnsMessage(messageNu(), { key: CLE, timeSigned: MAINTENANT });
    const relu = decodeDnsMessage(octets);
    const dernier = relu.additionals[relu.additionals.length - 1];
    expect(dernier.data.type).toBe(RRType.TSIG);
    expect(dernier.name).toBe('cle-labo');
    expect(dernier.rrClass).toBe(DnsClass.ANY);
  });

  it('la bonne cle verifie', () => {
    const octets = signDnsMessage(messageNu(), { key: CLE, timeSigned: MAINTENANT });
    expect(verifyDnsMessage(octets, { lookup: lookup(CLE), now: MAINTENANT }).status).toBe('ok');
  });

  it('TEMOIN — un message NON signe est reconnu comme tel, pas comme un faux', () => {
    const octets = encodeDnsMessage(messageNu());
    expect(verifyDnsMessage(octets, { lookup: lookup(CLE), now: MAINTENANT }).status).toBe('absent');
  });

  it('un secret different donne BADSIG', () => {
    const octets = signDnsMessage(messageNu(), { key: AUTRE, timeSigned: MAINTENANT });
    const verdict = verifyDnsMessage(octets, { lookup: lookup(CLE), now: MAINTENANT });
    expect(verdict.status).toBe('badsig');
  });

  it('un nom de cle inconnu donne BADKEY', () => {
    const octets = signDnsMessage(messageNu(), {
      key: { ...CLE, name: 'inconnue.' }, timeSigned: MAINTENANT,
    });
    expect(verifyDnsMessage(octets, { lookup: lookup(CLE), now: MAINTENANT }).status).toBe('badkey');
  });

  it('hors de la fenetre de tolerance, BADTIME', () => {
    const octets = signDnsMessage(messageNu(), { key: CLE, timeSigned: MAINTENANT });
    const verdict = verifyDnsMessage(octets, { lookup: lookup(CLE), now: MAINTENANT + 3600 });
    expect(verdict.status).toBe('badtime');
  });

  it('dans la fenetre, la meme signature passe', () => {
    const octets = signDnsMessage(messageNu(), { key: CLE, timeSigned: MAINTENANT });
    expect(verifyDnsMessage(octets, { lookup: lookup(CLE), now: MAINTENANT + 120 }).status).toBe('ok');
  });

  it('un octet change dans le CORPS du message invalide la signature', () => {
    const octets = signDnsMessage(messageNu(), { key: CLE, timeSigned: MAINTENANT });
    const falsifie = Uint8Array.from(octets);
    falsifie[13] ^= 0x01;
    expect(verifyDnsMessage(falsifie, { lookup: lookup(CLE), now: MAINTENANT }).status)
      .not.toBe('ok');
  });

  it('un TSIG dont les champs ne tiennent pas dans sa RDATA est REFUSE', () => {
    const octets = signDnsMessage(messageNu(), { key: CLE, timeSigned: MAINTENANT });
    const falsifie = Uint8Array.from(octets);
    falsifie[octets.length - 1] ^= 0xff;
    expect(verifyDnsMessage(falsifie, { lookup: lookup(CLE), now: MAINTENANT }).status)
      .toBe('malformed');
  });

  it('AJOUTER un enregistrement apres coup invalide la signature', () => {
    const octets = signDnsMessage(messageNu(), { key: CLE, timeSigned: MAINTENANT });
    const relu = decodeDnsMessage(octets);
    const tsig = relu.additionals[relu.additionals.length - 1];
    const gonfle = encodeDnsMessage({
      ...relu,
      answers: [makeARecord('www.example.com', 60, '10.0.0.66')],
      additionals: [tsig],
    });
    expect(verifyDnsMessage(gonfle, { lookup: lookup(CLE), now: MAINTENANT }).status)
      .toBe('badsig');
  });

  it('les trois algorithmes donnent trois condenses differents', () => {
    const macs = [TsigAlgorithm.HMAC_MD5, TsigAlgorithm.HMAC_SHA1, TsigAlgorithm.HMAC_SHA256]
      .map(algorithm => {
        const octets = signDnsMessage(messageNu(), {
          key: { ...CLE, algorithm }, timeSigned: MAINTENANT,
        });
        const relu = decodeDnsMessage(octets);
        const tsig = relu.additionals[relu.additionals.length - 1].data as { mac: Uint8Array };
        return [...tsig.mac].map(b => b.toString(16).padStart(2, '0')).join('');
      });
    expect(new Set(macs).size).toBe(3);
    expect(macs.map(m => m.length)).toEqual([32, 40, 64]);
  });

  it('la reponse est liee a la demande par le condense de celle-ci', () => {
    const demande = signDnsMessage(messageNu(), { key: CLE, timeSigned: MAINTENANT });
    const verdictDemande = verifyDnsMessage(demande, { lookup: lookup(CLE), now: MAINTENANT });
    expect(verdictDemande.status).toBe('ok');
    const macDemande = verdictDemande.status === 'ok' ? verdictDemande.mac : new Uint8Array(0);

    const reponse = signDnsMessage({ ...messageNu(), flags: { ...messageNu().flags, qr: true } }, {
      key: CLE, timeSigned: MAINTENANT, requestMac: macDemande,
    });

    expect(verifyDnsMessage(reponse, {
      lookup: lookup(CLE), now: MAINTENANT, requestMac: macDemande,
    }).status).toBe('ok');
    expect(verifyDnsMessage(reponse, {
      lookup: lookup(CLE), now: MAINTENANT, requestMac: new Uint8Array(32),
    }).status).toBe('badsig');
  });

  it('le code d erreur du TSIG est celui du registre', () => {
    expect(TsigErrorCode.BADSIG).toBe(16);
    expect(TsigErrorCode.BADKEY).toBe(17);
    expect(TsigErrorCode.BADTIME).toBe(18);
  });
});

describe('une zone en mise a jour SECURISEE refuse ce qui n est pas signe', () => {
  it('la politique par defaut accepte une mise a jour non signee', async () => {
    const { client, serveur } = await laboZone();
    const issue = await sendDynamicUpdate(client, SERVEUR, demande());
    expect(issue.rcode).toBe(DnsRcode.NOERROR);
    expect(serveur.zone.getRRSet(`poste.${ORIGIN}`, RRType.A)).toHaveLength(1);
  });

  it('en mode securise, la meme mise a jour non signee est REFUSEE', async () => {
    const { client, serveur } = await laboZone('secure');
    const issue = await sendDynamicUpdate(client, SERVEUR, demande());
    expect(issue.rcode).toBe(9);
    expect(serveur.zone.getRRSet(`poste.${ORIGIN}`, RRType.A)).toBeUndefined();
  });

  it('signee par une cle connue, elle passe', async () => {
    const { client, serveur } = await laboZone('secure');
    serveur.getTsigKeyring().add(CLE);

    const issue = await sendDynamicUpdate(client, SERVEUR, demande(), 2000, CLE);

    expect(issue.rcode).toBe(DnsRcode.NOERROR);
    expect(serveur.zone.getRRSet(`poste.${ORIGIN}`, RRType.A)).toHaveLength(1);
  });

  it('signee par un secret QUI NE CORRESPOND PAS, elle est refusee', async () => {
    const { client, serveur } = await laboZone('secure');
    serveur.getTsigKeyring().add(CLE);

    const issue = await sendDynamicUpdate(client, SERVEUR, demande(), 2000, AUTRE);

    expect(issue.rcode).toBe(9);
    expect(serveur.zone.getRRSet(`poste.${ORIGIN}`, RRType.A)).toBeUndefined();
  });

  it('la REPONSE du serveur est signee elle aussi', async () => {
    const { client, serveur } = await laboZone('secure');
    serveur.getTsigKeyring().add(CLE);

    const vues: DnsMessage[] = [];
    const espion = (m: DnsMessage) => {
      vues.push(m);
      return signDnsMessage(m, { key: CLE, timeSigned: Math.floor(Date.now() / 1000) });
    };
    await queryDnsOverUdp(client, SERVEUR, buildUpdateMessage(demande(), 77), undefined, 2000, espion)
      .then(reponse => {
        expect(reponse).not.toBeNull();
        const dernier = reponse!.additionals[reponse!.additionals.length - 1];
        expect(dernier?.data.type).toBe(RRType.TSIG);
      });
    expect(vues).toHaveLength(1);
  });
});
