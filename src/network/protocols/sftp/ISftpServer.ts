/**
 * ISftpServer — minimal interface a device must expose so that an
 * SftpSession (the client side) can authenticate and access files.
 *
 * Decoupled from any concrete filesystem or user-manager class so that
 * both Linux and Windows devices can be SFTP servers.
 *
 * Standards:
 *   - draft-ietf-secsh-filexfer (SSH File Transfer Protocol)
 *   - Authentication piggybacks on SSH (RFC 4252).
 */

import type { ISftpFileSystem, ISftpUserAuth } from './ISftpFileSystem';
import type { SocketTable } from '@/network/core/SocketTable';

export type { ISftpFileSystem, ISftpUserAuth };

/** Server-side resources an SFTP client session needs. */
export interface ISftpServer {
  /** Remote filesystem (Linux or Windows adapter). */
  readonly vfs: ISftpFileSystem;
  /** User/password database for authentication. */
  readonly userMgr: ISftpUserAuth;
  /** Hostname reported to the client (informational). */
  readonly hostname: string;
  /** Server-side socket table (for registering the ESTABLISHED connection). */
  readonly socketTable: SocketTable;
}

/**
 * Resolver: given a remote IP address, return the ISftpServer that
 * responds on that IP, or null if no reachable device exists.
 *
 * The production implementation walks Equipment.getAllEquipment() and
 * duck-types each device.  Tests supply a simple closure.
 */
export type SftpServerResolver = (ip: string) => ISftpServer | null;
