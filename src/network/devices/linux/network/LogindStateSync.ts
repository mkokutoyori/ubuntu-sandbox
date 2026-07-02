import type { VirtualFileSystem } from '../VirtualFileSystem';

export interface LogindSessionRecord {
  sid: string;
  uid: number;
  user: string;
  tty: string;
  leader: number;
  service: string;
  remote: boolean;
  remoteHost: string;
  scope: string;
  classOf: string;
  type: string;
  realtimeMicros: number;
  monotonicMicros: number;
}

const SESSIONS_DIR = '/run/systemd/sessions';
const USERS_DIR = '/run/systemd/users';
const RUNTIME_DIR_PARENT = '/run/user';

export class LogindStateSync {
  constructor(private readonly vfs: VirtualFileSystem) {}

  bootstrap(): void {
    this.vfs.mkdirp(SESSIONS_DIR, 0o755, 0, 0);
    this.vfs.mkdirp(USERS_DIR, 0o755, 0, 0);
    this.vfs.mkdirp(RUNTIME_DIR_PARENT, 0o755, 0, 0);
  }

  writeSession(rec: LogindSessionRecord, sessionsForUser: string[]): void {
    this.bootstrap();
    this.vfs.writeFile(
      `${SESSIONS_DIR}/${rec.sid}`,
      this.renderSession(rec),
      0, 0, 0o022, false,
    );
    this.vfs.writeFile(
      `${USERS_DIR}/${rec.uid}`,
      this.renderUser(rec, sessionsForUser),
      0, 0, 0o022, false,
    );
    const runtime = `${RUNTIME_DIR_PARENT}/${rec.uid}`;
    if (!this.vfs.exists(runtime)) {
      this.vfs.mkdir(runtime, 0o700, rec.uid, rec.uid);
    }
  }

  removeSession(sid: string, uid: number, remainingSessionsForUser: string[]): void {
    const path = `${SESSIONS_DIR}/${sid}`;
    if (this.vfs.exists(path)) this.vfs.deleteFile(path);
    if (remainingSessionsForUser.length === 0) {
      const userPath = `${USERS_DIR}/${uid}`;
      if (this.vfs.exists(userPath)) this.vfs.deleteFile(userPath);
    } else {
      const userPath = `${USERS_DIR}/${uid}`;
      const last = remainingSessionsForUser[remainingSessionsForUser.length - 1];
      this.vfs.writeFile(
        userPath,
        this.renderUser({
          sid: last, uid, user: '', tty: '', leader: 0, service: 'sshd',
          remote: false, remoteHost: '', scope: `session-${last}.scope`,
          classOf: 'user', type: 'tty', realtimeMicros: 0, monotonicMicros: 0,
        }, remainingSessionsForUser),
        0, 0, 0o022, false,
      );
    }
  }

  private renderSession(r: LogindSessionRecord): string {
    return [
      '# This is private data. Do not parse.',
      `UID=${r.uid}`,
      `USER=${r.user}`,
      `ACTIVE=1`,
      `STATE=active`,
      `SCOPE=${r.scope}`,
      `TTY=${r.tty}`,
      `SERVICE=${r.service}`,
      `REMOTE=${r.remote ? 1 : 0}`,
      `REMOTE_HOST=${r.remoteHost}`,
      `LEADER=${r.leader}`,
      `TYPE=${r.type}`,
      `CLASS=${r.classOf}`,
      `DESKTOP=`,
      `REALTIME=${r.realtimeMicros}`,
      `MONOTONIC=${r.monotonicMicros}`,
      '',
    ].join('\n');
  }

  private renderUser(r: LogindSessionRecord, sessions: string[]): string {
    return [
      '# This is private data. Do not parse.',
      `NAME=${r.user || `uid-${r.uid}`}`,
      `STATE=active`,
      `STOPPING=0`,
      `RUNTIME=/run/user/${r.uid}`,
      `SERVICE=user@${r.uid}.service`,
      `SLICE=user-${r.uid}.slice`,
      `DISPLAY=`,
      `SESSIONS=${sessions.join(' ')}`,
      '',
    ].join('\n');
  }
}
