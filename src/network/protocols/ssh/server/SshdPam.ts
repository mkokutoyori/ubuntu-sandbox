import type { LinuxPam, PamSyslogIdentity } from '@/network/devices/linux/pam/LinuxPam';
import type { PamTransaction } from '@/network/devices/linux/pam/PamTransaction';
import { PamServiceSession } from '@/network/devices/linux/pam/PamServiceSession';
import type { LinuxPamHost, PamProcessState } from '@/network/devices/linux/pam/PamLinuxHost';
import { PamReturn, pamStrError } from '@/network/devices/linux/pam/PamReturnCode';
import type { AccountLifecycleVerdict, KeyboardInteractiveChallenge, SshPeer } from '../auth/ISshAuthMethod';

const SSHD_SERVICE = 'sshd';
const SSHD_TTY = 'ssh';
const ROOT_CALLER = { uid: 0, euid: 0, loginName: '' };

export class SshdPam {
  private readonly connections = new Map<string, PamServiceSession>();

  constructor(
    private readonly pam: LinuxPam,
    private readonly identity: () => PamSyslogIdentity,
    private readonly permitEmptyPasswords: () => boolean,
    private readonly userExists: (user: string) => boolean,
    private readonly rootMayLogIn: () => boolean,
  ) {}

  private key(peer: SshPeer): string {
    return `${peer.ip}:${peer.port ?? 0}`;
  }

  private openConnection(user: string, ip: string): PamServiceSession {
    return new PamServiceSession(this.pam, SSHD_SERVICE, { caller: ROOT_CALLER, identity: this.identity() }, { user, rhost: ip, tty: SSHD_TTY });
  }

  private connectionFor(user: string, peer: SshPeer): PamServiceSession {
    const key = this.key(peer);
    let connection = this.connections.get(key);
    if (connection === undefined || connection.user !== user) {
      connection?.end();
      connection = this.openConnection(user, peer.ip);
      this.connections.set(key, connection);
    }
    return connection;
  }

  private authenticateAs(user: string, answers: () => string | null, peer: SshPeer | undefined): boolean {
    const effectivePeer: SshPeer = peer ?? { ip: '', port: undefined };
    const connection = peer === undefined
      ? this.openConnection(user, '')
      : this.connectionFor(user, effectivePeer);
    if (connection.maxTriesReached) return false;
    const valid = this.userExists(user);
    const fake = !valid || (user === 'root' && !this.rootMayLogIn());
    const code = connection.authenticate(fake ? () => `${answers() ?? ''}\u0000fake` : answers, this.permitEmptyPasswords());
    if (peer === undefined) connection.end();
    return code === PamReturn.SUCCESS && valid;
  }

  isPasswordAuthenticationOpen(peer: SshPeer | undefined): boolean {
    if (peer === undefined) return true;
    return !(this.connections.get(this.key(peer))?.maxTriesReached ?? false);
  }

  authenticatePassword(user: string, password: string, peer: SshPeer | undefined): boolean {
    return this.authenticateAs(user, () => password, peer);
  }

  rejectInvalidUser(user: string, password: string, peer: SshPeer | undefined): void {
    this.authenticateAs(user, () => password, peer);
  }

  challenge(peer: SshPeer | undefined, permitted: (user: string) => boolean): KeyboardInteractiveChallenge {
    return {
      device: 'pam',
      name: '',
      instruction: '',
      prompts: [{ prompt: 'Password: ', echo: false }],
      verify: (user, responses) => {
        if (!permitted(user)) return false;
        let index = 0;
        return this.authenticateAs(user, () => responses[index++] ?? '', peer);
      },
    };
  }

  account(user: string, peer: SshPeer | undefined): AccountLifecycleVerdict {
    const effectivePeer: SshPeer = peer ?? { ip: '', port: undefined };
    const connection = peer === undefined
      ? this.openConnection(user, '')
      : this.connectionFor(user, effectivePeer);
    const code = connection.account();
    const results = connection.transaction.handle.moduleResults;
    const messages = connection.takeLoginMessages();
    if (peer === undefined) connection.end();
    if (code === PamReturn.SUCCESS) return { ok: true, messages };
    if (code === PamReturn.NEW_AUTHTOK_REQD) return { ok: false, kind: 'password-expired', messages };
    const expired = results.some((result) => result.code === PamReturn.ACCT_EXPIRED);
    return { ok: false, kind: expired ? 'account-expired' : 'pam-denied', messages, detail: pamStrError(code) };
  }

  openSession(user: string, peer: SshPeer): PamProcessState {
    const connection = this.connectionFor(user, peer);
    connection.openSession();
    return connection.transaction.handle.host.process;
  }

  sessionMessages(peer: SshPeer): readonly string[] {
    return this.connections.get(this.key(peer))?.sessionMessages ?? [];
  }

  closeSession(peer: SshPeer): void {
    this.connections.get(this.key(peer))?.closeSession();
  }

  takeLoginMessages(peer: SshPeer): string[] {
    return this.connections.get(this.key(peer))?.takeLoginMessages() ?? [];
  }

  transactionFor(peer: SshPeer): PamTransaction<LinuxPamHost> | null {
    return this.connections.get(this.key(peer))?.transaction ?? null;
  }

  end(peer: SshPeer): void {
    const key = this.key(peer);
    this.connections.get(key)?.end();
    this.connections.delete(key);
  }
}

