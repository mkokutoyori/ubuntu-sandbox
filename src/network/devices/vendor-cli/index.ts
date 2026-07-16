/**
 * Commandes CLI vendeur PARTAGÉES entre les différents types
 * d'équipement d'un même vendeur (routeur/switch/firewall) :
 *
 *   - `cisco/*`  : Enable, Disable, ConfigureTerminal, Show (racine)
 *   - `huawei/*` : SystemView, Display (racine)
 *
 *  Les sous-commandes qui varient PAR équipement (show version routeur
 *  vs switch, show ip route routeur-only, show vlan switch-only…)
 *  vivent dans `src/network/devices/<router|switch|firewall>/
 *  command-kernel/commands/`.
 *
 *  Aucune règle métier device-spécifique ici : ces commandes ne
 *  connaissent que le socle CLI (mode transitions, prompt) et
 *  fonctionnent identiquement sur tout équipement d'un même vendeur.
 */

export * from './cisco/Enable';
export * from './cisco/Disable';
export * from './cisco/ConfigureTerminal';
export * from './cisco/Show';
export * from './huawei/SystemView';
export * from './huawei/Display';
export * from './huawei/DisplayClock';
export * from './huawei/Save';
