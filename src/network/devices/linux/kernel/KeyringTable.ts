export type KeyringKind = 'user' | 'user-session' | 'session';

export interface Keyring {
  readonly id: number;
  readonly uid: number;
  readonly gid: number;
  readonly kind: KeyringKind;
  readonly description: string;
  readonly links: number[];
  revoked: boolean;
}

const ID_MULTIPLIER = 2_654_435_761;

export class KeyringTable {
  private readonly keyrings = new Map<number, Keyring>();
  private counter = 0;

  private allocate(uid: number, gid: number, kind: KeyringKind, description: string): Keyring {
    this.counter += 1;
    const id = Math.imul(this.counter, ID_MULTIPLIER) >>> 1;
    const keyring: Keyring = { id, uid, gid, kind, description, links: [], revoked: false };
    this.keyrings.set(id, keyring);
    return keyring;
  }

  userKeyring(uid: number): Keyring {
    const existing = this.find(uid, 'user');
    return existing ?? this.allocate(uid, 65534, 'user', `_uid.${uid}`);
  }

  userSessionKeyring(uid: number): Keyring {
    const existing = this.find(uid, 'user-session');
    return existing ?? this.allocate(uid, 65534, 'user-session', `_uid_ses.${uid}`);
  }

  joinAnonymousSession(uid: number, gid: number): Keyring {
    return this.allocate(uid, gid, 'session', '_ses');
  }

  link(source: number, destination: number): boolean {
    const target = this.keyrings.get(destination);
    if (target === undefined || target.revoked || !this.keyrings.has(source)) return false;
    if (!target.links.includes(source)) target.links.push(source);
    return true;
  }

  revoke(id: number, asUid: number): boolean {
    const keyring = this.keyrings.get(id);
    if (keyring === undefined || (keyring.uid !== asUid && asUid !== 0)) return false;
    keyring.revoked = true;
    return true;
  }

  get(id: number): Keyring | undefined {
    return this.keyrings.get(id);
  }

  list(): readonly Keyring[] {
    return [...this.keyrings.values()];
  }

  private find(uid: number, kind: KeyringKind): Keyring | undefined {
    return [...this.keyrings.values()].find((keyring) => keyring.uid === uid && keyring.kind === kind);
  }

  renderProcKeys(): string {
    const lines: string[] = [];
    for (const keyring of this.keyrings.values()) {
      const flags = `I${keyring.revoked ? 'R' : '-'}-Q---`;
      const summary = keyring.links.length === 0 ? 'empty' : String(keyring.links.length);
      lines.push([
        keyring.id.toString(16).padStart(8, '0'),
        flags,
        String(1 + keyring.links.length).padStart(5),
        'perm',
        '3f030000',
        String(keyring.uid).padStart(5),
        String(keyring.gid).padStart(5),
        'keyring  ',
        `${keyring.description}: ${summary}`,
      ].join(' '));
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }
}
