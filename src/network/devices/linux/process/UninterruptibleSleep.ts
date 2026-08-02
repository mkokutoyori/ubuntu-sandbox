/**
 * UninterruptibleSleep — l'état `D` et ce qu'il fait aux signaux
 * (docs/PRD-Pannes.md §F5.7).
 *
 * Un processus bloqué dans un appel système ininterruptible n'est pas
 * seulement « lent » : il est hors de portée des signaux. `kill -9` sur un
 * processus en `D` ne fait rien, et c'est la panne la plus déroutante de la
 * famille F5, parce que **la commande réussit**. Le noyau accepte le
 * signal, `kill` sort avec 0, l'opérateur n'a aucun message d'erreur — et
 * le processus est toujours là.
 *
 * Le détail qui fait tout, et qu'une simulation paresseuse raterait : le
 * signal n'est pas PERDU, il est mis en attente. Linux l'empile dans la
 * table du processus et le délivre à l'instant précis où la tâche quitte
 * `D`. C'est ce qui rend la réparation spectaculaire — le processus meurt
 * d'un `kill -9` envoyé dix minutes plus tôt, dès que la ressource revient
 * ou qu'un `umount -l` détache le montage. Jeter le signal donnerait un
 * processus qui survit à sa libération, ce qui n'arrive jamais.
 *
 * Ce module ne connaît ni les montages ni le réseau : il tient la table
 * « qui dort sur quoi » et la file des signaux en attente. Qui décide
 * qu'une ressource est morte est la question de l'appelant.
 */

import type { Signal } from '../LinuxProcessManager';

/** Un processus endormi, et la ressource qui le retient. */
export interface UninterruptibleTask {
  readonly pid: number;
  /** La ressource attendue — un point de montage, tel que `ps` le dirait. */
  readonly resource: string;
}

export class UninterruptibleSleepTable {
  /** pid → ressource attendue. */
  private readonly blocked = new Map<number, string>();
  /** pid → signaux acceptés par le noyau mais pas encore délivrables. */
  private readonly pending = new Map<number, Signal[]>();

  /** Le processus entre en attente ininterruptible sur `resource`. */
  enter(pid: number, resource: string): void {
    this.blocked.set(pid, resource);
  }

  /** Ce processus est-il hors de portée des signaux ? */
  isBlocked(pid: number): boolean {
    return this.blocked.has(pid);
  }

  /** La ressource qui retient ce processus, si elle le retient. */
  resourceFor(pid: number): string | undefined {
    return this.blocked.get(pid);
  }

  /** Tout ce qui dort actuellement, pour un `ps`-like ou un diagnostic. */
  list(): UninterruptibleTask[] {
    return [...this.blocked].map(([pid, resource]) => ({ pid, resource }));
  }

  /**
   * Enregistrer un signal que le noyau a accepté mais ne peut pas encore
   * appliquer. L'ordre d'arrivée est conservé : à la sortie de `D`, Linux
   * les traite dans l'ordre, et le premier qui tue emporte le processus.
   */
  queue(pid: number, signal: Signal): void {
    const q = this.pending.get(pid);
    if (q) q.push(signal);
    else this.pending.set(pid, [signal]);
  }

  /** Les signaux en attente pour ce processus, sans le réveiller. */
  pendingFor(pid: number): readonly Signal[] {
    return this.pending.get(pid) ?? [];
  }

  /**
   * Le processus quitte `D`. Rend les signaux à délivrer, dans l'ordre
   * d'arrivée, et oublie le processus — c'est à l'appelant de les
   * appliquer, parce que lui seul sait tuer un processus.
   */
  wake(pid: number): Signal[] {
    this.blocked.delete(pid);
    const q = this.pending.get(pid) ?? [];
    this.pending.delete(pid);
    return q;
  }

  /**
   * Tous les processus retenus par cette ressource — ce qu'un `umount -l`
   * ou le retour du serveur libère d'un coup.
   */
  pidsBlockedOn(resource: string): number[] {
    return [...this.blocked]
      .filter(([, r]) => r === resource || r.startsWith(`${resource}/`))
      .map(([pid]) => pid);
  }

  /**
   * Le processus a disparu autrement (fin normale, machine éteinte) :
   * on oublie tout, signaux en attente compris. Sans ça, un pid réutilisé
   * hériterait du `SIGKILL` destiné à son prédécesseur.
   */
  forget(pid: number): void {
    this.blocked.delete(pid);
    this.pending.delete(pid);
  }

  /** Table vide — au redémarrage de la machine. */
  clear(): void {
    this.blocked.clear();
    this.pending.clear();
  }
}
