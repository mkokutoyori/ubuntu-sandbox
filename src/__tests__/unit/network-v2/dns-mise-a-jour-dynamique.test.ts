/**
 * RFC 2136 — une mise a jour dynamique traverse le fil.
 *
 * `PrimaryZoneAgent.applyUpdate` existait et n'etait joignable que par
 * appel de methode : le serveur refusait toute demande dont le code
 * d'operation n'etait pas QUERY, donc aucun client ne pouvait rien
 * enregistrer. Le laboratoire est un vrai reseau — commutateur, cables,
 * datagrammes UDP encodes puis decodes — et non un appel direct.
 *
 * Discrimine par `git stash` de `PrimaryZoneAgent.ts` — le fichier ou
 * vivait le refus — : 9 des 14 cas tombent. Les 5 qui passent des deux
 * cotes sont nommes ici plutot que laisses a decouvrir : les 2 cas
 * d'aller-retour sur le fil et le cas du SOA protege portent sur les
 * modules NEUFS, que ce `stash` ne retire pas ; le TEMOIN a pour objet
 * de passer des deux cotes ; et « une requete ordinaire passe toujours »
 * est le cas de non-regression.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { Zone } from '@/network/dns/zone/Zone';
import { makeARecord, makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import { PrimaryZoneAgent } from '@/network/dns/transfer/PrimaryZoneAgent';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { sendDynamicUpdate } from '@/network/dns/update/DynamicUpdateClient';
import { DnsUpdateRcode } from '@/network/dns/update/UpdateResponder';
import { buildUpdateMessage, readUpdateMessage } from '@/network/dns/update/DnsUpdate';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsUpdateRequest } from '@/network/dns/update/DnsUpdate';

const ORIGIN = 'example.com';
const SERVEUR = new IPAddress('10.0.0.1');

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

function zone(): Zone {
  const z = new Zone(ORIGIN, makeSoaRecord(ORIGIN, 3600, {
    mname: `ns1.${ORIGIN}`, rname: `hostmaster.${ORIGIN}`,
    serial: 2026070100, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  z.addRecord(makeARecord(`ns1.${ORIGIN}`, 3600, '10.0.0.1'));
  z.addRecord(makeARecord(`www.${ORIGIN}`, 3600, '192.0.2.10'));
  return z;
}

interface Labo { client: LinuxPC; serveur: PrimaryZoneAgent; }

function labo(): Labo {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const hoteServeur = new LinuxServer('linux-server', 'ns1', 0, 0);
  const client = new LinuxPC('linux-pc', 'poste', 0, 0);
  const masque = new SubnetMask('255.255.255.0');
  [hoteServeur, client].forEach((d, i) => new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]));
  hoteServeur.getPorts()[0].configureIP(SERVEUR, masque);
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.100'), masque);
  const serveur = new PrimaryZoneAgent(hoteServeur, zone());
  serveur.start();
  return { client, serveur };
}

async function resoudre(client: LinuxPC, nom: string): Promise<string[]> {
  const reponse = await queryDnsOverUdp(client, SERVEUR, {
    id: 42,
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname: nom, qtype: RRType.A, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  });
  return (reponse?.answers ?? [])
    .filter(rr => rr.data.type === RRType.A)
    .map(rr => (rr.data as { address: IPAddress }).address.toString());
}

const demande = (parts: Partial<DnsUpdateRequest>): DnsUpdateRequest => ({
  zone: ORIGIN, zoneClass: DnsClass.IN, prerequisites: [], updates: [], ...parts,
});

describe('le message de mise a jour se code et se relit', () => {
  it('les quatre formes de mise a jour survivent a l aller-retour sur le fil', () => {
    const message = buildUpdateMessage(demande({
      updates: [
        { kind: 'add', record: makeARecord(`a.${ORIGIN}`, 300, '10.0.0.7') },
        { kind: 'delete-rrset', name: `b.${ORIGIN}`, type: RRType.A },
        { kind: 'delete-name', name: `c.${ORIGIN}` },
        { kind: 'delete-record', record: makeARecord(`d.${ORIGIN}`, 0, '10.0.0.8') },
      ],
    }), 9);

    const relu = readUpdateMessage(decodeDnsMessage(encodeDnsMessage(message)));
    expect(relu.updates.map(u => u.kind))
      .toEqual(['add', 'delete-rrset', 'delete-name', 'delete-record']);
  });

  it('les cinq formes de prerequis survivent aussi', () => {
    const message = buildUpdateMessage(demande({
      prerequisites: [
        { kind: 'rrset-exists', name: `a.${ORIGIN}`, type: RRType.A },
        { kind: 'rrset-exists-value', record: makeARecord(`b.${ORIGIN}`, 0, '10.0.0.9') },
        { kind: 'rrset-absent', name: `c.${ORIGIN}`, type: RRType.A },
        { kind: 'name-in-use', name: `d.${ORIGIN}` },
        { kind: 'name-not-in-use', name: `e.${ORIGIN}` },
      ],
    }), 10);

    const relu = readUpdateMessage(decodeDnsMessage(encodeDnsMessage(message)));
    expect(relu.prerequisites.map(p => p.kind)).toEqual([
      'rrset-exists', 'rrset-exists-value', 'rrset-absent', 'name-in-use', 'name-not-in-use',
    ]);
  });
});

describe('un client enregistre son nom par le fil', () => {
  it('TEMOIN — le nom n existe pas avant la mise a jour', async () => {
    const { client } = labo();
    expect(await resoudre(client, `poste.${ORIGIN}`)).toEqual([]);
  });

  it('une addition acceptee rend le nom resoluble par une VRAIE requete', async () => {
    const { client } = labo();
    const issue = await sendDynamicUpdate(client, SERVEUR, demande({
      updates: [{ kind: 'add', record: makeARecord(`poste.${ORIGIN}`, 300, '10.0.0.100') }],
    }));

    expect(issue).toEqual({ answered: true, rcode: DnsRcode.NOERROR });
    expect(await resoudre(client, `poste.${ORIGIN}`)).toEqual(['10.0.0.100']);
  });

  it('la suppression de la famille retire le nom', async () => {
    const { client } = labo();
    expect(await resoudre(client, `www.${ORIGIN}`)).toEqual(['192.0.2.10']);

    const issue = await sendDynamicUpdate(client, SERVEUR, demande({
      updates: [{ kind: 'delete-rrset', name: `www.${ORIGIN}`, type: RRType.A }],
    }));

    expect(issue.rcode).toBe(DnsRcode.NOERROR);
    expect(await resoudre(client, `www.${ORIGIN}`)).toEqual([]);
  });

  it('remplacer une adresse est une suppression suivie d une addition, dans UN message', async () => {
    const { client } = labo();
    const issue = await sendDynamicUpdate(client, SERVEUR, demande({
      updates: [
        { kind: 'delete-rrset', name: `www.${ORIGIN}`, type: RRType.A },
        { kind: 'add', record: makeARecord(`www.${ORIGIN}`, 300, '192.0.2.99') },
      ],
    }));

    expect(issue.rcode).toBe(DnsRcode.NOERROR);
    expect(await resoudre(client, `www.${ORIGIN}`)).toEqual(['192.0.2.99']);
  });

  it('le numero de serie de la zone AVANCE, donc les secondaires apprendront', async () => {
    const { client, serveur } = labo();
    const avant = serveur.zone.soa.data.serial;
    await sendDynamicUpdate(client, SERVEUR, demande({
      updates: [{ kind: 'add', record: makeARecord(`poste.${ORIGIN}`, 300, '10.0.0.100') }],
    }));
    expect(serveur.zone.soa.data.serial).toBeGreaterThan(avant);
  });
});

describe('les prerequis decident, et chaque refus a son code', () => {
  it('un nom deja pris refuse la mise a jour par YXDOMAIN', async () => {
    const { client } = labo();
    const issue = await sendDynamicUpdate(client, SERVEUR, demande({
      prerequisites: [{ kind: 'name-not-in-use', name: `www.${ORIGIN}` }],
      updates: [{ kind: 'add', record: makeARecord(`www.${ORIGIN}`, 300, '10.0.0.100') }],
    }));

    expect(issue.rcode).toBe(DnsUpdateRcode.YXDOMAIN);
    expect(await resoudre(client, `www.${ORIGIN}`)).toEqual(['192.0.2.10']);
  });

  it('une famille absente refuse par NXRRSET, et rien n est ecrit', async () => {
    const { client } = labo();
    const issue = await sendDynamicUpdate(client, SERVEUR, demande({
      prerequisites: [{ kind: 'rrset-exists', name: `absent.${ORIGIN}`, type: RRType.A }],
      updates: [{ kind: 'add', record: makeARecord(`poste.${ORIGIN}`, 300, '10.0.0.100') }],
    }));

    expect(issue.rcode).toBe(DnsUpdateRcode.NXRRSET);
    expect(await resoudre(client, `poste.${ORIGIN}`)).toEqual([]);
  });

  it('un prerequis satisfait laisse passer', async () => {
    const { client } = labo();
    const issue = await sendDynamicUpdate(client, SERVEUR, demande({
      prerequisites: [{ kind: 'name-not-in-use', name: `poste.${ORIGIN}` }],
      updates: [{ kind: 'add', record: makeARecord(`poste.${ORIGIN}`, 300, '10.0.0.100') }],
    }));
    expect(issue.rcode).toBe(DnsRcode.NOERROR);
  });

  it('une zone dont le serveur n est pas maitre repond NOTAUTH', async () => {
    const { client } = labo();
    const issue = await sendDynamicUpdate(client, SERVEUR, demande({
      zone: 'ailleurs.test',
      updates: [{ kind: 'add', record: makeARecord('a.ailleurs.test', 300, '10.0.0.100') }],
    }));
    expect(issue.rcode).toBe(DnsUpdateRcode.NOTAUTH);
  });

  it('un nom hors de la zone repond NOTZONE', async () => {
    const { client } = labo();
    const issue = await sendDynamicUpdate(client, SERVEUR, demande({
      updates: [{ kind: 'add', record: makeARecord('a.autre.test', 300, '10.0.0.100') }],
    }));
    expect(issue.rcode).toBe(DnsUpdateRcode.NOTZONE);
  });
});

describe('ce qu une mise a jour ne peut pas faire', () => {
  it('le SOA de la zone ne peut pas etre supprime', async () => {
    const { client, serveur } = labo();
    await sendDynamicUpdate(client, SERVEUR, demande({
      updates: [{ kind: 'delete-rrset', name: ORIGIN, type: RRType.SOA }],
    }));
    expect(serveur.zone.getRRSet(ORIGIN, RRType.SOA)).toHaveLength(1);
  });

  it('une requete ordinaire passe toujours par le meme port', async () => {
    const { client } = labo();
    expect(await resoudre(client, `ns1.${ORIGIN}`)).toEqual(['10.0.0.1']);
  });
});
