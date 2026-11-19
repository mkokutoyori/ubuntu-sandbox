export type DirectoryGroupScope = 'Local' | 'Global' | 'Universal';

export interface DirectoryAuditPort {
  actor(): string;
  accountCreated(account: string, actor: string): void;
  accountEnabled(account: string, actor: string): void;
  accountDisabled(account: string, actor: string): void;
  accountChanged(account: string, actor: string): void;
  accountDeleted(account: string, actor: string): void;
  accountUnlocked(account: string, actor: string): void;
  passwordReset(account: string, actor: string): void;
  groupCreated(group: string, scope: DirectoryGroupScope, actor: string): void;
  groupDeleted(group: string, scope: DirectoryGroupScope, actor: string): void;
  groupChanged(group: string, scope: DirectoryGroupScope, actor: string): void;
  groupMemberAdded(group: string, member: string, scope: DirectoryGroupScope, actor: string): void;
  groupMemberRemoved(group: string, member: string, scope: DirectoryGroupScope, actor: string): void;
}
