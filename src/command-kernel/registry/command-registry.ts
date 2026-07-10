import { CommandDescriptor, ICommand } from "../command/types";

export type CommandFactory = () => ICommand;

export interface RegistryEventListener {
  onRegistered?(descriptor: CommandDescriptor): void;
  onUnregistered?(name: string): void;
}

/**
 * Annuaire central : une commande développée à part s'enregistre ici
 * et devient immédiatement résoluble par l'interpréteur, alias compris.
 * Les factories garantissent une instance fraîche par exécution
 * (pas d'état partagé accidentel entre deux invocations).
 */
export class CommandRegistry {
  private readonly factories = new Map<string, CommandFactory>();
  private readonly aliasIndex = new Map<string, string>();
  private readonly listeners: RegistryEventListener[] = [];

  register(factory: CommandFactory, opts?: { override?: boolean }): void {
    const descriptor = factory().descriptor;
    if (this.factories.has(descriptor.name) && !opts?.override) {
      throw new Error(`commande déjà enregistrée : ${descriptor.name}`);
    }
    this.factories.set(descriptor.name, factory);
    for (const alias of descriptor.aliases ?? []) {
      this.aliasIndex.set(alias, descriptor.name);
    }
    this.listeners.forEach((l) => l.onRegistered?.(descriptor));
  }

  unregister(name: string): boolean {
    const removed = this.factories.delete(name);
    if (removed) {
      for (const [alias, target] of this.aliasIndex) {
        if (target === name) this.aliasIndex.delete(alias);
      }
      this.listeners.forEach((l) => l.onUnregistered?.(name));
    }
    return removed;
  }

  /** Résolution nom OU alias -> instance neuve de la commande. */
  resolve(nameOrAlias: string): ICommand | undefined {
    const canonical = this.aliasIndex.get(nameOrAlias) ?? nameOrAlias;
    return this.factories.get(canonical)?.();
  }

  has(nameOrAlias: string): boolean {
    return this.factories.has(nameOrAlias) || this.aliasIndex.has(nameOrAlias);
  }

  /** Pour générer `help` : liste de tous les descripteurs. */
  list(): CommandDescriptor[] {
    return [...this.factories.values()].map((f) => f().descriptor);
  }

  subscribe(listener: RegistryEventListener): void {
    this.listeners.push(listener);
  }
}
