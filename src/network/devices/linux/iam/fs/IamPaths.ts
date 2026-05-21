/**
 * IamPaths — canonical filesystem locations the IAM layer keeps coherent.
 *
 * Every account-management file a real Debian/Ubuntu host maintains is named
 * here once, so no other module hard-codes a `/etc/...` string. Grouped by
 * role: the account database, its `useradd`/`passwd` backups, the policy /
 * defaults configuration, and the mail spool.
 */

export const IAM_PATHS = {
  // ── Account database ──────────────────────────────────────────────────
  passwd: '/etc/passwd',
  shadow: '/etc/shadow',
  group: '/etc/group',
  gshadow: '/etc/gshadow',
  subuid: '/etc/subuid',
  subgid: '/etc/subgid',

  // ── Backups (the `-` files written before each modification) ──────────
  passwdBackup: '/etc/passwd-',
  shadowBackup: '/etc/shadow-',
  groupBackup: '/etc/group-',
  gshadowBackup: '/etc/gshadow-',

  // ── Policy & defaults ─────────────────────────────────────────────────
  loginDefs: '/etc/login.defs',
  useraddDefaults: '/etc/default/useradd',
  adduserConf: '/etc/adduser.conf',
  defaultDir: '/etc/default',
  skel: '/etc/skel',

  // ── Per-user spool ────────────────────────────────────────────────────
  mailSpoolDir: '/var/mail',

  // ── Audit log ─────────────────────────────────────────────────────────
  authLog: '/var/log/auth.log',
} as const;

/** Pair an account-database file with the path of its `-` backup. */
export const ACCOUNT_DB_BACKUPS: ReadonlyArray<readonly [live: string, backup: string]> = [
  [IAM_PATHS.passwd, IAM_PATHS.passwdBackup],
  [IAM_PATHS.shadow, IAM_PATHS.shadowBackup],
  [IAM_PATHS.group, IAM_PATHS.groupBackup],
  [IAM_PATHS.gshadow, IAM_PATHS.gshadowBackup],
];
