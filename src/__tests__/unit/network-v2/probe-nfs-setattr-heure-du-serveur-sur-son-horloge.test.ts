/**
 * RFC 1813 §3.3.2 : un SETATTR dont `mtime` vaut SET_TO_SERVER_TIME pose l'heure du SERVEUR. Mesure de depart : le
 * serveur la prenait sur l'heure globale du simulateur (`simulationDate()` dans sattrToChanges), si bien qu'un
 * serveur dont on avait regle l'horloge (`date -s`) posait pourtant l'heure d'origine. NfsServerHost porte maintenant
 * `now()`, que LinuxNfsService branche sur l'horloge de la machine.
 *
 * Discrimine par `git stash` sur src/network : 1 des 2 cas tombe avant (l'heure posee apres `date -s`). Le TEMOIN
 * (SET_TO_CLIENT_TIME pose l'instant fourni, l'horloge du serveur n'y entre pas) passe des deux cotes.
 * Aucun client de ce simulateur n'emet SET_TO_SERVER_TIME (un `touch` monte passe par un autre chemin) : la sonde
 * parle donc en RPC directement au serveur, comme le ferait un client tiers.
 */
import { describe, it, expect } from 'vitest';
import { NfsServer } from '@/network/nfs/NfsServer';
import { NfsFileHandleTable } from '@/network/nfs/NfsFileHandleTable';
import { VfsExportedFileSystem } from '@/network/nfs/VfsExportedFileSystem';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { parseExportsFile } from '@/network/nfs/ExportTable';
import { encodeSetAttrArgs } from '@/network/nfs/wire/NfsCodec';
import { NFS_PROGRAM, NFS_V3, NfsProcedure, TimeHow } from '@/network/nfs/wire/NfsConstants';
import { AUTH_NONE, RpcAuthFlavor, encodeAuthSys } from '@/network/nfs/wire/RpcMessage';
import type { Sattr3 } from '@/network/nfs/wire/NfsTypes';

const SERVER_NOW = new Date(Date.UTC(2027, 2, 15, 9, 30, 0));

function lab(): { setattr(attributes: Sattr3): void; mtimeOf(): number } {
  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/export', 0o755, 0, 0);
  vfs.writeFile('/export/f', 'x', 0, 0, 0o022, true);
  const handles = new NfsFileHandleTable();
  const entries = parseExportsFile('/export *(rw,no_root_squash)\n');
  const server = new NfsServer({
    exports: () => entries,
    fileSystem: () => new VfsExportedFileSystem(vfs),
    hostnameOf: () => null,
    fsid: () => 1,
    now: () => SERVER_NOW,
  }, handles);
  const handle = handles.handleFor({ exportPath: '/export', path: '/export/f' });
  const credential = encodeAuthSys({ stamp: 0, machineName: 'client', uid: 0, gid: 0, gids: [] });
  return {
    setattr: (attributes) => {
      server.invoke({
        peerIp: '10.0.0.1',
        peerPort: 1023,
        call: {
          xid: 1, rpcVersion: 2, program: NFS_PROGRAM, programVersion: NFS_V3,
          procedure: NfsProcedure.SETATTR,
          credential: credential.flavor === RpcAuthFlavor.AUTH_SYS ? credential : AUTH_NONE,
          verifier: AUTH_NONE,
          payload: encodeSetAttrArgs({ object: handle, newAttributes: attributes, guardCtime: null }),
        },
      });
    },
    mtimeOf: () => (vfs as unknown as { resolveInode(p: string): { mtime: number } }).resolveInode('/export/f').mtime,
  };
}

describe('SETATTR et l horloge du serveur NFS', () => {
  it('TEMOIN — SET_TO_CLIENT_TIME pose l instant fourni par le client', () => {
    const { setattr, mtimeOf } = lab();
    const instant = Date.UTC(2030, 5, 1, 12, 0, 0);
    setattr({ mtime: { how: TimeHow.SET_TO_CLIENT_TIME, time: { seconds: instant / 1000, nseconds: 0 } } });
    expect(mtimeOf()).toBe(instant);
  });

  it('SET_TO_SERVER_TIME pose l heure de la machine serveur', () => {
    const { setattr, mtimeOf } = lab();
    setattr({ mtime: { how: TimeHow.SET_TO_SERVER_TIME } });
    expect(mtimeOf()).toBe(SERVER_NOW.getTime());
  });
});
