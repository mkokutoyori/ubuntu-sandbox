/**
 * RuntimeArtifacts — the files a daemon creates while it runs, and who
 * cleans them up (docs/PRD-Pannes.md §F5.2).
 *
 * This is the mirror of {@link ./CriticalFiles}: that module declares the
 * files a service cannot work WITHOUT, this one declares the files a
 * service leaves BEHIND. Both exist so the fact lives in one place rather
 * than at each call site.
 *
 * The panne is the one `kill -9` causes and `systemctl stop` does not: a
 * killed process runs no cleanup, so whatever it wrote in `/run` outlives
 * it. Nothing modelled that — `/run` held no pid file at all, so
 * `ls /run/*.pid` showed the same nothing before and after a kill, and the
 * §F5.2 lab had no residue to find.
 *
 * ── Ce que ce module refuse de simuler, et pourquoi ────────────────────
 *
 * Le PRD annonce qu'après un `kill -9` « la relance doit échouer tant
 * qu'on ne nettoie pas ». Sur une machine systemd moderne, c'est un mythe,
 * et le simuler apprendrait le contraire de la réalité :
 *
 *   - le **port** est libéré par le noyau à la mort du processus (vérifié
 *     sur cette plateforme : le 22 disparaît de `ss -ltn` puis revient),
 *     donc pas d'`address already in use` ;
 *   - un **verrou `flock()`** — cron, atd — meurt avec son détenteur, donc
 *     un fichier PID périmé n'empêche rien : c'est une trace trompeuse,
 *     pas un obstacle, et le lire donne le pid d'un processus disparu ;
 *   - une **`RuntimeDirectory=`** est effacée par systemd dès que l'unité
 *     quitte l'état actif, échec compris (`RuntimeDirectoryPreserve=no`,
 *     le défaut), donc ce qu'un démon range là ne survit pas non plus.
 *
 * Le résidu est donc réel, visible, et trompeur — mais il ne bloque rien.
 * C'est précisément la leçon : l'opérateur qui accuse le fichier PID
 * périmé se trompe de coupable.
 */

/** What the file is, which decides what it holds and how it reads. */
export type ArtifactKind = 'pidfile' | 'socket';

export interface RuntimeArtifact {
  readonly path: string;
  readonly kind: ArtifactKind;
}

/**
 * Per-service runtime files, keyed by unit name.
 *
 * These are the paths the DAEMON writes, which is not the same list as the
 * `PIDFile=` lines in Debian's unit files — systemd only needs telling
 * where the pid is when it cannot follow the fork itself, while cron and
 * atd write theirs whether or not anybody asked. `at`'s own daemon-down
 * message already named atd's pid file long before this module
 * existed; the path here is that one, so the message stops being a
 * plausible string and starts describing a file that is really there.
 */
export const SERVICE_RUNTIME_ARTIFACTS: Readonly<Record<string, readonly RuntimeArtifact[]>> = {
  ssh: [{ path: '/run/sshd.pid', kind: 'pidfile' }],
  cron: [{ path: '/run/crond.pid', kind: 'pidfile' }],
  atd: [{ path: '/run/atd.pid', kind: 'pidfile' }],
  rsyslog: [{ path: '/run/rsyslogd.pid', kind: 'pidfile' }],
  fail2ban: [
    { path: '/run/fail2ban/fail2ban.pid', kind: 'pidfile' },
    { path: '/run/fail2ban/fail2ban.sock', kind: 'socket' },
  ],
};

/** The runtime files this unit creates. Empty for a unit that creates none. */
export function runtimeArtifactsFor(unit: string): readonly RuntimeArtifact[] {
  return SERVICE_RUNTIME_ARTIFACTS[unit] ?? [];
}

/**
 * `RuntimeDirectory=` as Debian writes it — the directory systemd creates
 * under `/run` at start and **removes when the unit leaves the active
 * state, failure included**, since `RuntimeDirectoryPreserve=` defaults to
 * `no`.
 *
 * This is the whole reason two daemons on the same machine behave
 * differently after the same `kill -9`: sshd writes straight into `/run`
 * and its pid file survives, fail2ban writes into a directory systemd
 * owns and nothing of its survives. Without the directive modelled, the
 * two look identical and the lab teaches the wrong rule.
 */
export const UNIT_RUNTIME_DIRECTORY: Readonly<Record<string, string>> = {
  fail2ban: 'fail2ban',
};

/** Absolute path of a unit's `RuntimeDirectory=`, or null when it has none. */
export function runtimeDirectoryFor(unit: string): string | null {
  const name = UNIT_RUNTIME_DIRECTORY[unit];
  return name ? `/run/${name}` : null;
}

/**
 * `PIDFile=` as Debian really writes it, for the units that carry the
 * directive. Only these two do: systemd is told where the pid lives when
 * it cannot follow the fork itself, and a `Type=simple` unit like cron
 * never needs to say, even though cron does write one.
 */
export const UNIT_PIDFILE_DIRECTIVE: Readonly<Record<string, string>> = {
  ssh: '/run/sshd.pid',
  fail2ban: '/run/fail2ban/fail2ban.pid',
};
