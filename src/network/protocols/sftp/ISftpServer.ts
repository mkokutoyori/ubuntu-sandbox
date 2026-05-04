/**
 * ISftpServer — minimal interface a Linux device must expose so that
 * an SftpSession (the client side) can authenticate and access files.
 *
 * This keeps the sftp client fully decoupled from LinuxMachine; tests
 * can supply a plain mock object without needing a real device.
 *
 * Standards:
 *   - draft-ietf-secsh-filexfer (SSH File Transfer Protocol)
 *   - Authentication piggybacks on SSH (RFC 4252) — simulated here via
 *     the UserManager password store.
 */

import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import type { LinuxUserManager } from '@/network/devices/linux/LinuxUserManager';
import type { SocketTable } from '@/network/core/SocketTable';

/** Server-side resources an SFTP client session needs. */
export interface ISftpServer {
  /** Remote filesystem — all file operations run against this VFS. */
  readonly vfs: VirtualFileSystem;
  /** User/password database for authentication. */
  readonly userMgr: LinuxUserManager;
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
