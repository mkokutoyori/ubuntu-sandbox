/**
 * Table des signaux POSIX et analyse d'un argument de signal
 * (`-9`, `-KILL`, `-SIGKILL`, `-15`…) — utilitaire propre à la couche
 * command-kernel, partagé par `kill`/`pkill`/`killall`. Constantes POSIX
 * stables (pas de la logique de commande héritée).
 */
export const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
};

/**
 * Convertit un argument de signal (`-9`, `-KILL`, `-SIGTERM`, `-15`) en nom
 * canonique (`SIGKILL`…), ou `null` si non reconnu.
 */
export function parseSignalArg(token: string): string | null {
  const cleaned = token.replace(/^-/, '');
  if (/^\d+$/.test(cleaned)) {
    const num = Number.parseInt(cleaned, 10);
    for (const [name, n] of Object.entries(SIGNAL_NUMBERS)) {
      if (n === num) return name;
    }
    return null;
  }
  const upper = cleaned.toUpperCase();
  for (const candidate of [upper, `SIG${upper}`]) {
    if (SIGNAL_NUMBERS[candidate] !== undefined) return candidate;
  }
  return null;
}
