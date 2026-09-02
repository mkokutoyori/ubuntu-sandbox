/**
 * CriticalFiles — a service's hard dependencies on files that must exist
 * (docs/PRD-Pannes.md §6.2, §13).
 *
 * The problem this fixes: every config reader in the codebase does
 * `vfs.readFile(path) ?? ''`, which makes "file deleted" indistinguishable
 * from "file empty". For most files that is harmless, but for a service's
 * own configuration it is the difference between the daemon refusing to
 * start and the daemon starting with defaults. Deleting
 * `/etc/ssh/sshd_config` used to have literally no effect.
 *
 * The distinction matters both ways round, and both are real behaviour:
 *
 *   - `rm /etc/ssh/sshd_config`  → sshd refuses to start.
 *   - `> /etc/ssh/sshd_config`   → sshd starts happily on defaults. An
 *     empty config is legal.
 *
 * so the check is existence, never emptiness.
 */

/** Outcome shaped like the service manager's own `OperationResult`. */
export interface ConfigCheckResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** Minimal surface needed — keeps this testable without a whole VFS. */
export interface FileProbe {
  exists(path: string): boolean;
  readFile(path: string): string | null;
}

export interface CriticalFile {
  readonly path: string;
  /**
   * Exact message the real daemon prints when the file is missing. Never
   * paraphrased: the learner has to recognise it on a real system
   * (docs/PRD-Pannes.md §5, principle P3).
   */
  readonly onMissing: string;
}

/**
 * A set of paths where ANY ONE satisfies the requirement — host keys, where
 * sshd needs at least one usable key and does not care which algorithm.
 */
export interface CriticalFileSet {
  readonly anyOf: readonly string[];
  readonly onAllMissing: string;
}

export type CriticalRequirement = CriticalFile | CriticalFileSet;

function isSet(req: CriticalRequirement): req is CriticalFileSet {
  return 'anyOf' in req;
}

/**
 * First unmet requirement, or null when they are all satisfied. Order is
 * significant: the daemon reports the first thing it trips over, so the
 * caller lists them in the order the real one checks them.
 */
export function firstMissingRequirement(
  probe: FileProbe,
  requirements: readonly CriticalRequirement[],
): string | null {
  for (const req of requirements) {
    if (isSet(req)) {
      if (!req.anyOf.some(p => probe.exists(p))) return req.onAllMissing;
    } else if (!probe.exists(req.path)) {
      return req.onMissing;
    }
  }
  return null;
}

// ─── sshd ────────────────────────────────────────────────────────

/**
 * OpenSSH's own start-up failures, in the order sshd hits them.
 *
 * The config is read first (it names the host keys), then the keys are
 * loaded; a missing config therefore always wins over missing keys.
 */
export const SSHD_CRITICAL_FILES: readonly CriticalRequirement[] = [
  {
    path: '/etc/ssh/sshd_config',
    onMissing: '/etc/ssh/sshd_config: No such file or directory',
  },
  {
    anyOf: [
      '/etc/ssh/ssh_host_ed25519_key',
      '/etc/ssh/ssh_host_rsa_key',
      '/etc/ssh/ssh_host_ecdsa_key',
    ],
    onAllMissing: 'sshd: no hostkeys available -- exiting.',
  },
];

/** Are sshd's own files all present? */
export function checkSshdCriticalFiles(probe: FileProbe): ConfigCheckResult {
  const missing = firstMissingRequirement(probe, SSHD_CRITICAL_FILES);
  return missing ? { ok: false, error: missing } : { ok: true };
}

// ─── nginx ───────────────────────────────────────────────────────

/**
 * nginx refuse de démarrer sans son fichier principal, et le dit avec
 * l'errno (docs/PRD-Nginx.md §P3).
 *
 * Un fichier ABSENT et un fichier VIDE sont deux pannes distinctes, et
 * c'est la distinction qui compte : l'absence est un `open()` qui échoue,
 * le vide est une configuration syntaxiquement valide à laquelle il manque
 * la section `events` — deux messages différents, deux diagnostics
 * différents. Ce tableau ne couvre que le premier ; le second est du
 * ressort de l'analyseur, qui seul peut lire le contenu.
 */
/**
 * rsyslog refuse de demarrer sans son fichier principal, et le message
 * est le sien : `rsyslogd: error ... could not open config file`. Un
 * `/etc/rsyslog.conf` VIDE, lui, est legal — le demon demarre sans
 * regle et n'ecrit nulle part, ce qui est une panne differente et bien
 * reelle (les logs disparaissent sans que rien n'echoue).
 */
export const RSYSLOG_CRITICAL_FILES: readonly CriticalRequirement[] = [
  {
    path: '/etc/rsyslog.conf',
    onMissing: "rsyslogd: error: could not open config file '/etc/rsyslog.conf': No such file or directory",
  },
];

export const NGINX_CRITICAL_FILES: readonly CriticalRequirement[] = [
  {
    path: '/etc/nginx/nginx.conf',
    onMissing: 'nginx: [emerg] open() "/etc/nginx/nginx.conf" failed (2: No such file or directory)',
  },
];

/** Le fichier principal de nginx est-il là ? */
/** Le pendant rsyslog de `checkNginxCriticalFiles`. */
export function checkRsyslogCriticalFiles(probe: FileProbe): ConfigCheckResult {
  const missing = firstMissingRequirement(probe, RSYSLOG_CRITICAL_FILES);
  return missing ? { ok: false, error: missing } : { ok: true };
}

export function checkNginxCriticalFiles(probe: FileProbe): ConfigCheckResult {
  const missing = firstMissingRequirement(probe, NGINX_CRITICAL_FILES);
  return missing ? { ok: false, error: missing } : { ok: true };
}

export const DHCPD_CRITICAL_FILES: readonly CriticalRequirement[] = [
  {
    path: '/etc/dhcp/dhcpd.conf',
    onMissing: "Can't open /etc/dhcp/dhcpd.conf: No such file or directory",
  },
];

export function checkDhcpdCriticalFiles(probe: FileProbe): ConfigCheckResult {
  const missing = firstMissingRequirement(probe, DHCPD_CRITICAL_FILES);
  return missing ? { ok: false, error: missing } : { ok: true };
}

// ─── Command binaries ────────────────────────────────────────────

/**
 * Canonical on-disk location of each shipped command. A command not listed
 * falls back to `/usr/bin/<name>`, which is where most of them live.
 *
 * This table has two jobs, and they depend on each other: the paths are
 * SEEDED into the VFS at boot, and the dispatcher then treats a missing
 * path as a deletion. Without the seeding step the check would fire for
 * every command the fixture never provisioned; with it, absence can only
 * mean the user removed the file.
 */
export const STANDARD_BIN_PATHS: Readonly<Record<string, string>> = {
  bash: '/bin/bash', sh: '/bin/sh', echo: '/bin/echo', cat: '/bin/cat',
  ls: '/bin/ls', cp: '/bin/cp', mv: '/bin/mv', rm: '/bin/rm', touch: '/bin/touch',
  mkdir: '/bin/mkdir', rmdir: '/bin/rmdir', ln: '/bin/ln', chmod: '/bin/chmod',
  chown: '/bin/chown', chgrp: '/bin/chgrp', su: '/bin/su', sudo: '/usr/bin/sudo',
  chattr: '/usr/bin/chattr', lsattr: '/usr/bin/lsattr',
  whoami: '/usr/bin/whoami', head: '/usr/bin/head', tail: '/usr/bin/tail',
  grep: '/bin/grep', sed: '/bin/sed', awk: '/usr/bin/awk', sort: '/usr/bin/sort',
  uniq: '/usr/bin/uniq', wc: '/usr/bin/wc', cut: '/usr/bin/cut', tr: '/usr/bin/tr',
  date: '/bin/date', uname: '/bin/uname', hostname: '/bin/hostname',
  ps: '/bin/ps', kill: '/bin/kill', tee: '/usr/bin/tee', find: '/usr/bin/find',
  xargs: '/usr/bin/xargs', tar: '/bin/tar', gzip: '/bin/gzip', curl: '/usr/bin/curl',
  openssl: '/usr/bin/openssl',
  'update-ca-certificates': '/usr/sbin/update-ca-certificates',
  // Le temps (`docs/PRD-NTP-Tutoriel.md` §4). `chronyd` est un binaire a
  // part entiere plutot qu'un alias : c'est lui que l'unite lance, donc
  // c'est sa disparition qui empeche le service de demarrer.
  chronyc: '/usr/bin/chronyc',
  ntpq: '/usr/bin/ntpq', nsupdate: '/usr/bin/nsupdate', ipsec: '/usr/sbin/ipsec',
  chronyd: '/usr/sbin/chronyd',
  lldpd: '/usr/sbin/lldpd', lldpcli: '/usr/sbin/lldpcli',
  timedatectl: '/usr/bin/timedatectl',
  wget: '/usr/bin/wget', ping: '/bin/ping', ssh: '/usr/bin/ssh', scp: '/usr/bin/scp',
  sftp: '/usr/bin/sftp', ip: '/sbin/ip', ifconfig: '/sbin/ifconfig',
  netstat: '/bin/netstat', ss: '/usr/sbin/ss', iptables: '/usr/sbin/iptables',
  passwd: '/usr/bin/passwd', useradd: '/usr/sbin/useradd', userdel: '/usr/sbin/userdel',
  usermod: '/usr/sbin/usermod', groupadd: '/usr/sbin/groupadd',
  systemctl: '/bin/systemctl', service: '/usr/sbin/service',
  crontab: '/usr/bin/crontab', 'run-parts': '/bin/run-parts',
  auditctl: '/sbin/auditctl', ausearch: '/sbin/ausearch', aureport: '/sbin/aureport',
  reboot: '/sbin/reboot', shutdown: '/sbin/shutdown', logger: '/usr/bin/logger',
  journalctl: '/bin/journalctl', dmesg: '/bin/dmesg', logrotate: '/usr/sbin/logrotate',
  rsyslogd: '/usr/sbin/rsyslogd',
  // Les outils d'administration vivent dans `sbin` : `which lsmod`
  // doit répondre le même chemin que le `binaryPath` déclaré sur la
  // commande, sinon la machine se contredit sur l'emplacement.
  lsmod: '/usr/sbin/lsmod', modinfo: '/usr/sbin/modinfo',
  modprobe: '/usr/sbin/modprobe',
  swapon: '/usr/sbin/swapon', swapoff: '/usr/sbin/swapoff',
  lid: '/usr/sbin/lid', conntrack: '/usr/sbin/conntrack',
  // The two HTTP servers and their control tool. They are here for two
  // reasons that meet: their systemd units name these paths in
  // `ExecStart` (§F5.10 judges a service on the existence of its
  // executable), and their commands declare the same path as
  // `binaryPath` — without the seeding, `nginx -t` would fail on a file
  // nobody deleted. `apache2ctl` is the real file on Debian and
  // `apachectl` the link; both names exist, as on the machine.
  nginx: '/usr/sbin/nginx', apache2: '/usr/sbin/apache2',
  apachectl: '/usr/sbin/apachectl', apache2ctl: '/usr/sbin/apache2ctl',
  dhcpd: '/usr/sbin/dhcpd', 'dhcp-lease-list': '/usr/sbin/dhcp-lease-list',
  a2ensite: '/usr/sbin/a2ensite', a2dissite: '/usr/sbin/a2dissite',
  a2enmod: '/usr/sbin/a2enmod', a2dismod: '/usr/sbin/a2dismod',
};

export function resolveExePath(name: string): string {
  return STANDARD_BIN_PATHS[name] ?? `/usr/bin/${name}`;
}

/**
 * Merged-/usr aliases, resolved the way the filesystem itself resolves
 * them. The VFS ships the real Ubuntu layout — `/bin` is a symlink to
 * `usr/bin`, `/sbin` to `usr/sbin` (`VirtualFileSystem` bootstrap) — and
 * every binary physically lives under `/usr`.
 *
 * `resolveInode` follows a symlink in the LAST path component but not in an
 * intermediate one, so `exists('/bin/ls')` answers false for a file that is
 * genuinely there as `/usr/bin/ls`. Normalising here keeps this module
 * agreeing with the filesystem instead of second-guessing it, and has the
 * side benefit that `rm /bin/ls` and `rm /usr/bin/ls` are treated as what
 * they are: the same file.
 */
export function canonicalBinPath(path: string): string {
  if (path.startsWith('/bin/')) return `/usr${path}`;
  if (path.startsWith('/sbin/')) return `/usr${path}`;
  // `/lib` is the third merged-/usr symlink, and it is the one the systemd
  // helpers live behind (`/lib/systemd/systemd-resolved`). Leaving it out
  // made those paths answer "absent" while the file sat at
  // `/usr/lib/systemd/...`, which §F5.10's start-up check then read as a
  // deleted binary and refused to start the unit.
  if (path.startsWith('/lib/')) return `/usr${path}`;
  return path;
}

/**
 * Per-command file dependencies, for commands whose own module is not a
 * `LinuxCommand` object to hang a `criticalFiles` field off — the ~269
 * cases still living in `LinuxCommandExecutor`'s switch.
 *
 * Each message is the real tool's, verbatim.
 */
export const COMMAND_CRITICAL_FILES: Readonly<Record<string, readonly CriticalRequirement[]>> = {
  sudo: [{
    path: '/etc/sudoers',
    onMissing: 'sudo: /etc/sudoers is required',
  }],
};

/** What a shell prints when the executable itself is gone (exit 127). */
export function commandNotFoundMessage(name: string, path: string): string {
  return `bash: ${path}: No such file or directory`;
}

export interface MissingCommandDependency {
  readonly message: string;
  readonly exitCode: number;
}

/**
 * Can `name` run at all? Returns the failure a real shell would produce, or
 * null when nothing is missing.
 *
 * The two cases have different exit codes because they are different
 * failures: a missing binary is the shell failing to exec (127), a missing
 * data file is the program itself refusing to work (1).
 */
export function checkCommandDependencies(
  probe: FileProbe,
  name: string,
  extra?: readonly CriticalRequirement[],
): MissingCommandDependency | null {
  // The guard-rail that makes this safe to put on the hottest path in the
  // simulator: only a binary the image actually SHIPS — i.e. one this
  // table names, and which `seedSetuidBinaries` therefore laid down at
  // boot — can be judged missing. For anything else, absence proves
  // nothing (shell builtins live in the process, and a name the image
  // never provisioned was never on disk to begin with), so the check
  // stands aside and the existing dispatch decides.
  const path = STANDARD_BIN_PATHS[name];
  if (path && !probe.exists(canonicalBinPath(path))) {
    // The message names the path the operator knows (`/bin/ls`), while the
    // lookup used the physical one — same as a real merged-/usr system.
    return { message: commandNotFoundMessage(name, path), exitCode: 127 };
  }
  const requirements = extra ?? COMMAND_CRITICAL_FILES[name];
  if (requirements) {
    const missing = firstMissingRequirement(probe, requirements);
    if (missing) return { message: missing, exitCode: 1 };
  }
  return null;
}
