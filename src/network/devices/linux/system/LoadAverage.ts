import type { LinuxProcessManager } from '../LinuxProcessManager';

/**
 * La charge d'une machine, ecrite UNE fois.
 *
 * Elle l'etait quatre fois : une constante `0.00, 0.01, 0.05` dans
 * l'en-tete d'`uptime`, un `0.08, 0.03, 0.01` dans un rendu de `top`, un
 * `0.00, 0.00, 0.00` dans la vue `w` d'une session SSH, et un compte de
 * processus executables reformate en trois decimales. `uptime` et `top`
 * annoncaient donc deux charges differentes pour la meme machine au meme
 * instant.
 *
 * Ce que le simulateur peut honnetement dire : RIEN n'y brule de temps
 * processeur, donc la moyenne de charge est nulle — ce que confirment
 * deja le `%Cpu(s): 100.0 id` de `top` et le `id 100` de `vmstat`. Les
 * trois autres champs de `/proc/loadavg`, eux, sont des faits que la
 * table des processus detient : combien tournent, combien il y en a, et
 * quel PID a ete alloue en dernier.
 */
export interface LoadSnapshot {
  readonly one: number;
  readonly five: number;
  readonly fifteen: number;
  readonly running: number;
  readonly total: number;
  readonly lastPid: number;
}

export const IDLE_LOAD = { one: 0, five: 0, fifteen: 0 } as const;

export function loadSnapshot(pm: LinuxProcessManager): LoadSnapshot {
  const all = pm.list();
  const running = all.filter((p) => p.state === 'R').length;
  return {
    ...IDLE_LOAD,
    running: Math.max(1, running),
    total: all.length,
    lastPid: all.reduce((max, p) => Math.max(max, p.pid), 1),
  };
}

/** `0.00, 0.00, 0.00` — la forme que `uptime`, `w` et `top` impriment. */
export function formatLoadAverage(
  load: { one: number; five: number; fifteen: number },
): string {
  return [load.one, load.five, load.fifteen].map((v) => v.toFixed(2)).join(', ');
}

/**
 * La charge que toutes les vues d'en-tete impriment. Elles n'ont pas
 * besoin de la table des processus : seuls `/proc/loadavg` et
 * `/proc/stat` lisent les compteurs de processus.
 */
export const IDLE_LOAD_AVERAGE = formatLoadAverage(IDLE_LOAD);

/**
 * La ligne `%Cpu(s)` de `top`. Elle etait derivee du nombre de processus
 * EXECUTABLES (`running * 100`), si bien qu'un seul processus dans l'etat
 * R faisait annoncer 100 % d'occupation a une machine dont `/proc/stat`
 * et `vmstat` disent qu'elle n'a rien brule. Un processus executable
 * n'est pas du temps processeur consomme.
 */
export const CPU_IDLE_LINE =
  '0.0 us,  0.0 sy,  0.0 ni,100.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st';

/** `0.00 0.00 0.00 1/40 41` — la forme du fichier du noyau. */
export function renderProcLoadavg(load: LoadSnapshot): string {
  return `${[load.one, load.five, load.fifteen].map((v) => v.toFixed(2)).join(' ')}`
    + ` ${load.running}/${load.total} ${load.lastPid}\n`;
}

/** Un tick d'horloge du noyau : `USER_HZ` vaut 100 sur toutes les architectures usuelles. */
const USER_HZ = 100;

/**
 * `/proc/stat`. Les compteurs de temps processeur decrivent une machine
 * qui n'a JAMAIS rien execute : tout son temps est passe en `idle`, ce
 * qui est litteralement vrai ici et ce que `top` et `vmstat` affichent
 * deja. Les compteurs de processus, eux, sont lus dans la table.
 */
export function renderProcStat(
  pm: LinuxProcessManager, cores: number, uptimeSeconds: number, bootTime: Date,
): string {
  const load = loadSnapshot(pm);
  const idle = Math.floor(uptimeSeconds * USER_HZ);
  const cpuLine = (label: string, ticks: number): string =>
    `${label} 0 0 0 ${ticks} 0 0 0 0 0 0`;
  const lines = [cpuLine('cpu ', idle * cores)];
  for (let i = 0; i < cores; i++) lines.push(cpuLine(`cpu${i}`, idle));
  lines.push(
    'intr 0',
    'ctxt 0',
    `btime ${Math.floor(bootTime.getTime() / 1000)}`,
    `processes ${load.lastPid}`,
    `procs_running ${load.running}`,
    'procs_blocked 0',
    'softirq 0',
  );
  return `${lines.join('\n')}\n`;
}
