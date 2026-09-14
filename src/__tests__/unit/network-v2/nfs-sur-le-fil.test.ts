/**
 * Banc — NFSv3 traverse vraiment le reseau simule.
 *
 * Le §4 est la regle cardinale de ce depot : ce que deux machines
 * echangent doit passer par Port / Cable / TcpStack et se compter sur le
 * fil. Un serveur NFS qui appellerait la methode du pair serait plus
 * court et faux ; ce banc mesure le contraire.
 *
 * Le laboratoire est celui du lot RMAN, et ce n'est pas un detail :
 *
 *   ORA-PROD ── R-CORE (routeur) ── FGT-DC (pare-feu) ── ORA-DR
 *   10.10.10.10                                         10.10.20.20
 *
 * Les octets d'une ecriture NFS traversent donc un routeur ET un
 * pare-feu. C'est ce qui rend le dernier cas opposable : quand la
 * politique du pare-feu tombe, le montage tombe avec elle. Un serveur
 * qu'on appellerait en memoire ne pourrait pas etre bloque.
 *
 * AUTORITE : voir l'en-tete de nfs-wire-rfc1813, qui nomme les sources
 * et dit pourquoi le texte des RFC est injoignable depuis cette machine.
 *
 * Ce n'est pas une sonde de correctif — NFS n'existait pas ici, il n'y a
 * pas d'avant a discriminer.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';
import { RpcService } from '@/network/nfs/RpcService';
import { NfsServer } from '@/network/nfs/NfsServer';
import { MountServer } from '@/network/nfs/MountServer';
import { PortmapServer } from '@/network/nfs/PortmapServer';
import { NfsFileHandleTable } from '@/network/nfs/NfsFileHandleTable';
import { VfsExportedFileSystem } from '@/network/nfs/VfsExportedFileSystem';
import { NfsClient, TcpRpcTransport } from '@/network/nfs/NfsClient';
import { parseExportsFile } from '@/network/nfs/ExportTable';
import {
  MOUNT_PROGRAM, MOUNT_V3, MountStatus, NFS_PORT, NFS_PROGRAM, NFS_V3, NfsStatus,
} from '@/network/nfs/wire/NfsConstants';
import { PORTMAP_PORT, RpcProtocol } from '@/network/nfs/wire/PortmapCodec';

const MOUNTD_PORT = 20048;
const EXPORT_PATH = '/srv/backup';
const EXPORTS_FILE = `${EXPORT_PATH} 10.10.10.0/24(rw,sync,no_root_squash,no_subtree_check)\n`;

let lab: RmanLab;
let client: NfsClient;
let rootHandle: Uint8Array;
let serverIp: IPAddress;
let nfsRpc: RpcService;

interface StackHolder { getTcpStack(): import('@/network/tcp/TcpStack').TcpStack }
interface VfsHolder { executor: { vfs: import('@/network/devices/linux/VirtualFileSystem').VirtualFileSystem } }

function serverVfs() {
  return (lab.dr as unknown as VfsHolder).executor.vfs;
}

function stackOf(device: unknown) {
  return (device as StackHolder).getTcpStack();
}

function startServer(exportsContent: string): { portmap: PortmapServer; mount: MountServer } {
  const vfs = serverVfs();
  vfs.mkdirp(EXPORT_PATH, 0o755, 0, 0);
  const fileSystem = new VfsExportedFileSystem(vfs);
  const handles = new NfsFileHandleTable();
  const entries = parseExportsFile(exportsContent);
  const host = {
    exports: () => entries,
    fileSystem: () => fileSystem,
    hostnameOf: () => null,
    fsid: () => 0x1234,
  };
  const portmap = new PortmapServer();
  const mount = new MountServer(host, handles);
  const nfs = new NfsServer(host, handles);

  const stack = stackOf(lab.dr);
  const portmapRpc = new RpcService(stack, PORTMAP_PORT);
  portmapRpc.register(portmap);
  portmapRpc.start();
  const mountRpc = new RpcService(stack, MOUNTD_PORT);
  mountRpc.register(mount);
  mountRpc.start();
  nfsRpc = new RpcService(stack, NFS_PORT);
  nfsRpc.register(nfs);
  nfsRpc.start();

  portmap.set({ program: NFS_PROGRAM, version: NFS_V3, protocol: RpcProtocol.TCP, port: NFS_PORT });
  portmap.set({ program: MOUNT_PROGRAM, version: MOUNT_V3, protocol: RpcProtocol.TCP, port: MOUNTD_PORT });
  return { portmap, mount };
}

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  resetAllOracleInstances();
  Logger.reset();
  lab = await buildRmanLab();
  serverIp = new IPAddress(lab.drIp);
  startServer(EXPORTS_FILE);
  client = new NfsClient(
    new TcpRpcTransport(stackOf(lab.prod)),
    { machineName: 'ORA-PROD', uid: 0, gid: 0, gids: [] },
  );
  const handle = client.mount(serverIp, EXPORT_PATH, MOUNTD_PORT);
  rootHandle = handle instanceof Uint8Array ? handle : new Uint8Array(0);
});

describe('le montage se negocie en trois echanges, chacun sur le fil', () => {
  it('le portmapper annonce le port de mountd et celui de nfsd', () => {
    expect(client.queryPort(serverIp, MOUNT_PROGRAM, MOUNT_V3)).toBe(MOUNTD_PORT);
    expect(client.queryPort(serverIp, NFS_PROGRAM, NFS_V3)).toBe(NFS_PORT);
  });

  it('un programme jamais enregistre repond zero, pas une invention', () => {
    expect(client.queryPort(serverIp, 100024, 1)).toBe(0);
  });

  it('MNT rend une poignee de systeme de fichiers utilisable', () => {
    expect(rootHandle.length).toBeGreaterThan(0);
    const attributes = client.getAttr(serverIp, rootHandle);
    expect(attributes).not.toBeNull();
    expect(attributes?.type).toBe(2);
  });

  it('un export qui n existe pas est refuse par son code de montage', () => {
    expect(client.mount(serverIp, '/srv/absent', MOUNTD_PORT)).toBe(MountStatus.MNT3ERR_NOENT);
  });

  it('EXPORT liste ce que le serveur publie, avec ses groupes', () => {
    const exported = client.listExports(serverIp, MOUNTD_PORT);
    expect(exported.map((e) => e.directory)).toEqual([EXPORT_PATH]);
    expect(exported[0].groups).toEqual(['10.10.10.0/24']);
  });
});

describe('les octets d un fichier traversent vraiment le routeur et le pare-feu', () => {
  it('une piece ecrite par le client est lisible sur le serveur, par le serveur', () => {
    const created = client.create(serverIp, rootHandle, 'piece.bkp', 0o640);
    expect(created).toBeInstanceOf(Uint8Array);
    const payload = new TextEncoder().encode('[ORACLE RMAN BACKUP PIECE - 4096 bytes]');
    expect(client.write(serverIp, created as Uint8Array, payload)).toBe(NfsStatus.NFS3_OK);

    const onServer = lab.sh(lab.dr, `cat ${EXPORT_PATH}/piece.bkp`);
    expect(onServer).toContain('ORACLE RMAN BACKUP PIECE');
  });

  it('un fichier ecrit sur le serveur se relit octet pour octet par le client', () => {
    lab.sh(lab.dr, `sh -c "echo -n CARGO > ${EXPORT_PATH}/probe.txt"`);
    const handle = client.lookup(serverIp, rootHandle, 'probe.txt');
    expect(handle).toBeInstanceOf(Uint8Array);
    const attributes = client.getAttr(serverIp, handle as Uint8Array);
    const data = client.read(serverIp, handle as Uint8Array, Number(attributes?.size ?? 0));
    expect(data).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(data as Uint8Array)).toContain('CARGO');
  });

  it('une ecriture binaire ne passe pas par une traduction de texte', () => {
    const created = client.create(serverIp, rootHandle, 'bin.dat', 0o644);
    const payload = Uint8Array.from([0, 1, 127, 128, 200, 255, 0, 42]);
    expect(client.write(serverIp, created as Uint8Array, payload)).toBe(NfsStatus.NFS3_OK);
    const readBack = client.read(serverIp, created as Uint8Array, payload.length);
    expect(Array.from(readBack as Uint8Array)).toEqual([0, 1, 127, 128, 200, 255, 0, 42]);
  });

  it('READDIR voit ce que le serveur a sur son disque', () => {
    lab.sh(lab.dr, `touch ${EXPORT_PATH}/un.bkp ${EXPORT_PATH}/deux.bkp`);
    const entries = client.readDir(serverIp, rootHandle);
    expect(Array.isArray(entries)).toBe(true);
    const names = Array.isArray(entries) ? entries.map((e) => e.name) : [];
    expect(names).toContain('un.bkp');
    expect(names).toContain('deux.bkp');
  });

  it('mkdir, rename et remove agissent sur le disque du serveur', () => {
    expect(client.mkdir(serverIp, rootHandle, 'jour1', 0o755)).toBeInstanceOf(Uint8Array);
    expect(lab.sh(lab.dr, `test -d ${EXPORT_PATH}/jour1 && echo OUI`)).toContain('OUI');

    client.create(serverIp, rootHandle, 'avant.bkp', 0o644);
    expect(client.rename(serverIp, rootHandle, 'avant.bkp', rootHandle, 'apres.bkp'))
      .toBe(NfsStatus.NFS3_OK);
    expect(lab.sh(lab.dr, `test -f ${EXPORT_PATH}/apres.bkp && echo OUI`)).toContain('OUI');

    expect(client.remove(serverIp, rootHandle, 'apres.bkp')).toBe(NfsStatus.NFS3_OK);
    expect(lab.sh(lab.dr, `test -f ${EXPORT_PATH}/apres.bkp && echo OUI`)).not.toContain('OUI');
  });

  it('FSSTAT rend la place du disque du SERVEUR, pas celle du client', () => {
    const stat = client.fsStat(serverIp, rootHandle);
    expect(stat?.status).toBe(NfsStatus.NFS3_OK);
    const total = stat?.status === NfsStatus.NFS3_OK ? stat.totalBytes : 0n;
    expect(total).toBeGreaterThan(0n);
    expect(total).toBe(BigInt(serverVfs().getCapacityBytes()));
  });
});

describe('les regles d export sont evaluees, pas seulement rangees', () => {
  it('un export en lecture seule refuse l ecriture par ROFS', async () => {
    lab = await buildRmanLab();
    serverIp = new IPAddress(lab.drIp);
    startServer(`${EXPORT_PATH} 10.10.10.0/24(ro,sync,no_root_squash)\n`);
    client = new NfsClient(
      new TcpRpcTransport(stackOf(lab.prod)),
      { machineName: 'ORA-PROD', uid: 0, gid: 0, gids: [] },
    );
    const handle = client.mount(serverIp, EXPORT_PATH, MOUNTD_PORT);
    expect(handle).toBeInstanceOf(Uint8Array);
    expect(client.create(serverIp, handle as Uint8Array, 'x.bkp', 0o644))
      .toBe(NfsStatus.NFS3ERR_ROFS);
  });

  it('un client hors du reseau autorise est refuse au montage', async () => {
    lab = await buildRmanLab();
    serverIp = new IPAddress(lab.drIp);
    startServer(`${EXPORT_PATH} 192.168.99.0/24(rw,sync)\n`);
    client = new NfsClient(
      new TcpRpcTransport(stackOf(lab.prod)),
      { machineName: 'ORA-PROD', uid: 0, gid: 0, gids: [] },
    );
    expect(client.mount(serverIp, EXPORT_PATH, MOUNTD_PORT)).toBe(MountStatus.MNT3ERR_ACCES);
  });

  it('TEMOIN — le pare-feu ferme, rien ne traverse : c est bien du reseau', async () => {
    await lab.firewall.executeCommand('config firewall policy');
    await lab.firewall.executeCommand('edit 1');
    await lab.firewall.executeCommand('set action deny');
    await lab.firewall.executeCommand('next');
    await lab.firewall.executeCommand('end');

    expect(client.getAttr(serverIp, rootHandle)).toBeNull();
  });
});
