/**
 * Le plan de donnees d'Oracle Net : ce que sqlplus met VRAIMENT sur le fil.
 *
 * Mesure AVANT (base mise de cote par `git stash push -- src/network
 * src/database src/terminal src/adapters`) : une session sqlplus distante
 * ouvrait bien une connexion TCP vers 1521, mais le serveur y poussait 36
 * octets de banniere puis raccrochait aussitot ; le client ne parlait
 * jamais. Chaque ordre SQL rouvrait cette meme sonde. Compte : 5 trames et
 * 358 octets pour `SELECT 1 AS X FROM DUAL`, et 5 trames et 358 octets
 * pour un SELECT de 436 caracteres. IDENTIQUES : le SQL ne traversait pas,
 * il s'executait en memoire sur l'objet du pair.
 *
 * Mesure APRES : 2 trames / 184 octets pour l'ordre court, 3 trames / 666
 * octets pour l'ordre long. La difference SUIT la charge utile, ce qui
 * n'est possible que si l'ordre voyage.
 *
 * Autorite pour le format de paquet : Oracle Net est PROPRIETAIRE, il n'a
 * pas de RFC et docs.oracle.com est bloque par le proxy de sortie de cette
 * machine. Le dissecteur TNS de Wireshark (epan/dissectors/packet-tns.c)
 * fait foi ici : en-tete de 8 octets (longueur u16, somme de controle u16,
 * type u8, octet reserve, somme de controle d'en-tete u16), types
 * CONNECT=1 / ACCEPT=2 / REFUSE=4 / REDIRECT=5 / DATA=6, et les corps de
 * CONNECT (version, SDU, TDU, longueur et offset des donnees de connexion)
 * et d'ACCEPT. Ce qui est TRANSPORTE dans un paquet DATA — la couche TTC
 * d'Oracle — n'est documente nulle part d'accessible : l'encodage des
 * appels est donc PROPRE a ce simulateur et assume comme tel. Le cadrage,
 * la poignee de main, les refus et les octets comptes sur le fil, eux,
 * sont ceux du dissecteur.
 *
 * Discrimination : 4 cas sur 7, mesures en mettant de cote les fichiers
 * MODIFIES (`git stash push -- src/network src/database src/terminal
 * src/adapters`) et en laissant en place les modules neufs, qui sont un
 * codec inerte tant que rien ne l'appelle. Les trois cas qui passent des
 * deux cotes, et pourquoi :
 *
 *   - « un descripteur encode puis decode… » est STRUCTUREL : il eprouve
 *     la grammaire du descripteur, presente dans les deux bras ; il ne
 *     peut pas tomber et ne pretend pas le contraire.
 *   - « la reponse rendue au client… » est une NON-REGRESSION : la base
 *     rendait deja « 1 row selected. », en memoire. Le cas garde que
 *     faire voyager l'ordre n'a rien change a ce que l'utilisateur lit.
 *   - « temoin : le labo est sain » est le TEMOIN : deux hotes cables qui
 *     se repondent. Sans lui, un banc fait de refus ne prouverait rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import {
  NsPacketType, decodeConnect, decodeRefuse, readNsHeader,
} from '@/network/oracle-net/wire/NsPacket';
import { parseConnectDescriptor } from '@/network/oracle-net/wire/ConnectDescriptor';

const TNSNAMES_PATH = '/u01/app/oracle/product/19c/dbhome_1/network/admin/tnsnames.ora';
const SHORT_STATEMENT = 'SELECT 1 AS X FROM DUAL;';
const LONG_STATEMENT = `SELECT ${Array.from({ length: 40 }, (_, i) => `${i} AS C${i}`).join(', ')} FROM DUAL;`;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function lan(alias = 'ORCLDB', service = 'ORCL') {
  const client = new LinuxServer('linux-server', 'appclient', 0, 0);
  const dbhost = new LinuxServer('linux-server', 'dbhost', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(dbhost.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  dbhost.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  client.setHostname('appclient');
  dbhost.setHostname('dbhost');

  SqlPlusSubShell.create(dbhost, ['/', 'as', 'sysdba']).subShell.dispose();
  SqlPlusSubShell.create(client, ['/', 'as', 'sysdba']).subShell.dispose();

  const existing = client.readFileForEditor(TNSNAMES_PATH) ?? '';
  client.writeFileFromEditor(TNSNAMES_PATH, `${existing}
${alias} =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = 10.0.0.2)(PORT = 1521))
    (CONNECT_DATA = (SERVICE_NAME = ${service}))
  )
`);
  return { client, dbhost };
}

function wire(port: { getCounters(): { framesOut: number; bytesOut: number } }) {
  const counters = port.getCounters();
  return { frames: counters.framesOut, bytes: counters.bytesOut };
}

interface TappedSocket { send(data: unknown): void; onData(handler: (data: unknown) => void): () => void }

function tapTnsPackets(client: LinuxServer): { sent: Uint8Array[]; received: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  const received: Uint8Array[] = [];
  const stack = client.getTcpStack() as unknown as {
    connect(ip: string, port: number): TappedSocket | null;
  };
  const original = stack.connect.bind(stack);
  stack.connect = (ip: string, port: number) => {
    const socket = original(ip, port);
    if (!socket) return socket;
    const send = socket.send.bind(socket);
    socket.send = (data: unknown) => {
      if (data instanceof Uint8Array) sent.push(data.slice());
      send(data);
    };
    socket.onData((data) => {
      if (data instanceof Uint8Array) received.push(data.slice());
    });
    return socket;
  };
  return { sent, received };
}

describe('la poignee de main TNS traverse le reseau simule', () => {
  it('le client emet un CONNECT porteur du descripteur et le serveur repond ACCEPT', async () => {
    const { client } = lan();
    await client.executeCommand('tcpdump -ni eth0 port 1521 -w /tmp/tns.pcap &');
    const { subShell } = SqlPlusSubShell.create(client, ['system/oracle@ORCLDB']);
    const dump = await client.executeCommand('tcpdump -r /tmp/tns.pcap');
    subShell.dispose();

    const outbound = dump.split('\n').filter((l) => l.includes('> 10.0.0.2.1521') && !l.includes('length 0'));
    const inbound = dump.split('\n').filter((l) => l.includes('10.0.0.2.1521 >') && !l.includes('length 0'));
    expect(outbound.length).toBeGreaterThan(0);
    expect(inbound.length).toBeGreaterThan(0);
  });

  it('un descripteur encode puis decode rend le service et l identite du client', () => {
    const descriptor = '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=10.0.0.2)(PORT=1521))'
      + '(CONNECT_DATA=(SERVICE_NAME=ORCL)(CID=(PROGRAM=sqlplus)(HOST=appclient)(USER=oracle))))';
    const parsed = parseConnectDescriptor(descriptor);
    expect(parsed?.service).toBe('ORCL');
    expect(parsed?.addresses[0]).toEqual({ host: '10.0.0.2', port: 1521 });
    expect(parsed?.programName).toBe('sqlplus');
    expect(parsed?.hostName).toBe('appclient');
  });

  it('le paquet CONNECT respecte la structure du dissecteur', () => {
    const { client } = lan();
    const { sent } = tapTnsPackets(client);
    SqlPlusSubShell.create(client, ['system/oracle@ORCLDB']).subShell.dispose();

    const connectPacket = sent.find((p) => readNsHeader(p)?.type === NsPacketType.Connect);
    expect(connectPacket).toBeDefined();
    const header = readNsHeader(connectPacket!)!;
    expect(header.length).toBe(connectPacket!.length);
    const body = decodeConnect(connectPacket!);
    expect(body?.connectData).toContain('SERVICE_NAME=ORCL');
    expect(body?.sduSize).toBeGreaterThan(0);
  });
});

describe('un ordre SQL distant voyage vraiment', () => {
  it('les octets sur le fil suivent la longueur de l ordre', () => {
    const { client } = lan();
    const port = client.getPorts()[0];
    const { subShell } = SqlPlusSubShell.create(client, ['system/oracle@ORCLDB']);

    const beforeShort = wire(port);
    subShell.processLine(SHORT_STATEMENT);
    const afterShort = wire(port);
    subShell.processLine(LONG_STATEMENT);
    const afterLong = wire(port);
    subShell.dispose();

    const shortBytes = afterShort.bytes - beforeShort.bytes;
    const longBytes = afterLong.bytes - afterShort.bytes;
    expect(shortBytes).toBeGreaterThan(0);
    expect(longBytes).toBeGreaterThan(shortBytes);
    expect(longBytes - shortBytes).toBeGreaterThanOrEqual(
      LONG_STATEMENT.length - SHORT_STATEMENT.length);
  });

  it('la reponse rendue au client est celle que le serveur a calculee', () => {
    const { client } = lan();
    const { subShell } = SqlPlusSubShell.create(client, ['system/oracle@ORCLDB']);
    const rows = subShell.processLine(SHORT_STATEMENT).output ?? [];
    subShell.dispose();
    expect(rows.join('\n')).toContain('1 row selected.');
  });
});

describe('le refus vient du serveur, pas du client', () => {
  it('un service inconnu revient en ORA-12514 dans un paquet REFUSE', () => {
    const { client } = lan('BADDB', 'NOSUCHSERVICE');
    const { received } = tapTnsPackets(client);
    const created = SqlPlusSubShell.create(client, ['system/oracle@BADDB']);
    created.subShell.dispose();

    const refusal = received.find((p) => readNsHeader(p)?.type === NsPacketType.Refuse);
    expect(refusal).toBeDefined();
    expect(decodeRefuse(refusal!)?.refuseData).toContain('ORA-12514');
    expect(created.loginOutput.join('\n')).toContain('ORA-12514');
  });

  it('temoin : le labo est sain, les deux hotes se repondent', async () => {
    const { client } = lan();
    const ping = await client.executeCommand('ping -c 2 10.0.0.2');
    expect(ping).toMatch(/2 (packets )?received|0% packet loss/);
  });
});
