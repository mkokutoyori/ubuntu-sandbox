import type { TcpStack } from '@/network/tcp/TcpStack';
import type { PortSpec } from '@/network/core/ports/PortNumber';
import type { ListenerIdentity } from '@/network/tcp/ListenerSocketSink';
import type { VirtualFileSystem } from '../VirtualFileSystem';
import type { ServiceSocketServer } from '../ports/ServiceSocketServer';
import { RpcService } from '@/network/nfs/RpcService';
import { NfsServer } from '@/network/nfs/NfsServer';
import { MountServer } from '@/network/nfs/MountServer';
import { PortmapServer } from '@/network/nfs/PortmapServer';
import { NfsFileHandleTable } from '@/network/nfs/NfsFileHandleTable';
import { VfsExportedFileSystem } from '@/network/nfs/VfsExportedFileSystem';
import { parseExportsFile, type ExportEntry } from '@/network/nfs/ExportTable';
import {
  MOUNT_PROGRAM, MOUNT_V3, NFS_PORT, NFS_PROGRAM, NFS_V3,
} from '@/network/nfs/wire/NfsConstants';
import { PORTMAP_PORT, RpcProtocol } from '@/network/nfs/wire/PortmapCodec';

export const EXPORTS_PATH = '/etc/exports';
export const MOUNTD_PORT = 20048;

export const MOUNT_STATUS_REASON: Readonly<Record<number, string>> = {
  1: 'Operation not permitted',
  2: 'No such file or directory',
  5: 'Input/output error',
  13: 'Permission denied',
  20: 'Not a directory',
  22: 'Invalid argument',
  63: 'File name too long',
  10004: 'Operation not supported',
  10006: 'Remote I/O error',
};

export const DEBIAN_EXPORTS_FILE = [
  '# /etc/exports: the access control list for filesystems which may be exported',
  '#		to NFS clients.  See exports(5).',
  '#',
  '# Example for NFSv2 and NFSv3:',
  '# /srv/homes       hostname1(rw,sync,no_subtree_check) hostname2(ro,sync,no_subtree_check)',
  '#',
  '# Example for NFSv4:',
  '# /srv/nfs4        gss/krb5i(rw,sync,fsid=0,crossmnt,no_subtree_check)',
  '# /srv/nfs4/homes  gss/krb5i(rw,sync,no_subtree_check)',
  '#',
  '',
].join('\n');

export interface NfsServiceHost {
  readonly vfs: VirtualFileSystem;
  tcpStack(): TcpStack;
  hostnameOf(ip: string): string | null;
}

export class LinuxNfsService implements ServiceSocketServer {
  private readonly handles = new NfsFileHandleTable();
  private readonly portmap = new PortmapServer();
  private readonly services = new Map<number, RpcService>();
  private published: ExportEntry[] = [];
  private readonly mountServer: MountServer;
  private readonly nfsServer: NfsServer;

  constructor(private readonly host: NfsServiceHost) {
    const fileSystem = new VfsExportedFileSystem(host.vfs);
    const serverHost = {
      exports: () => this.published,
      fileSystem: () => fileSystem,
      hostnameOf: (ip: string) => host.hostnameOf(ip),
      fsid: () => 0x4e465301,
    };
    this.mountServer = new MountServer(serverHost, this.handles);
    this.nfsServer = new NfsServer(serverHost, this.handles);
  }

  declaredExports(): readonly ExportEntry[] {
    return parseExportsFile(this.host.vfs.readFile(EXPORTS_PATH) ?? '');
  }

  publishedExports(): readonly ExportEntry[] {
    return this.published;
  }

  activeMounts(): ReturnType<MountServer['activeMounts']> {
    return this.mountServer.activeMounts();
  }

  reloadExports(): readonly ExportEntry[] {
    this.published = [...this.declaredExports()];
    return this.published;
  }

  unexport(path: string): boolean {
    const index = this.published.findIndex((entry) => entry.path === path);
    if (index < 0) return false;
    this.published.splice(index, 1);
    this.handles.forgetExport(path);
    return true;
  }

  unexportAll(): void {
    for (const entry of this.published) this.handles.forgetExport(entry.path);
    this.published = [];
  }

  open(spec: PortSpec, identity?: ListenerIdentity): boolean {
    if (spec.protocol !== 'tcp') return false;
    if (this.services.has(spec.port)) return true;
    const rpc = new RpcService(this.host.tcpStack(), spec.port);
    if (spec.port === PORTMAP_PORT) rpc.register(this.portmap);
    else if (spec.port === MOUNTD_PORT) rpc.register(this.mountServer);
    else if (spec.port === NFS_PORT) rpc.register(this.nfsServer);
    else return false;
    if (!rpc.start(identity)) return false;
    this.services.set(spec.port, rpc);
    if (spec.port !== PORTMAP_PORT) {
      this.portmap.set({
        program: spec.port === MOUNTD_PORT ? MOUNT_PROGRAM : NFS_PROGRAM,
        version: spec.port === MOUNTD_PORT ? MOUNT_V3 : NFS_V3,
        protocol: RpcProtocol.TCP,
        port: spec.port,
      });
    }
    if (spec.port === NFS_PORT) this.reloadExports();
    return true;
  }

  close(spec: PortSpec): void {
    const rpc = this.services.get(spec.port);
    if (!rpc) return;
    rpc.stop();
    this.services.delete(spec.port);
    if (spec.port === NFS_PORT) {
      this.portmap.unset(NFS_PROGRAM, NFS_V3);
      this.unexportAll();
    }
    if (spec.port === MOUNTD_PORT) this.portmap.unset(MOUNT_PROGRAM, MOUNT_V3);
  }

  isRunning(): boolean {
    return this.services.has(NFS_PORT);
  }
}
