/**
 * =====================================================================
 *  SOCLE CLI VENDEUR — point d'entrée public
 * =====================================================================
 *
 *  Couche AU-DESSUS de `command-kernel` pour les CLI vendeur (Cisco
 *  IOS, Huawei VRP, switches, firewalls). Voir `./types.ts` pour la
 *  documentation d'architecture complète.
 *
 *  Ce socle est utilisé par les ponts vendeur (`src/network/devices/
 *  <vendeur>/command-kernel/`) — jamais par les commandes elles-mêmes,
 *  qui ne voient que `CommandContext`/`MachineApi` comme n'importe
 *  quelle autre commande.
 */

export * from "./types";
export * from "./cli-tokenizer";
export * from "./prefix-match";
export * from "./mode-registry";
export * from "./cli-interpreter";
export * from "./cli-prompt-builder";
export * from "./cli-session";
export * from "./cli-machine-api";
export * from "./commands/mode-transition";
