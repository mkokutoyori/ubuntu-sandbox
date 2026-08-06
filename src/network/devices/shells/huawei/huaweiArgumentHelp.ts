import type { CommandTrie, ParamSpec } from '../CommandTrie';

const IP = (name: string, description: string): ParamSpec =>
  ({ name, type: 'IP_ADDR', description });
const MASK = (description: string): ParamSpec =>
  ({ name: 'mask', type: 'SUBNET_MASK', description });
const INT = (
  name: string, range: readonly [number, number], description: string,
): ParamSpec => ({ name, type: 'INT', description, range });
const WORD = (name: string, description: string): ParamSpec =>
  ({ name, type: 'WORD', description });
const LINE = (name: string, description: string): ParamSpec =>
  ({ name, type: 'STRING', description });

export interface HuaweiArgumentHelpTries {
  system: CommandTrie;
  iface: CommandTrie;
  ospf: CommandTrie;
  vty: CommandTrie;
}

/**
 * Ce que l'aide de VRP DIT derrière un argument déjà saisi.
 *
 * La couche B existait pour le routeur puis le switch Cisco et
 * s'arrêtait là : `HuaweiVRPShell` ne déclarait aucun argument, si bien
 * qu'un `?` derrière une valeur ne pouvait rien annoncer. Chaque plage
 * écrite ici a été éprouvée aux quatre bords contre le gestionnaire qui
 * l'applique — une plage annoncée que la commande n'applique pas est le
 * défaut que ce mécanisme est censé corriger, pas un progrès.
 */
export function describeHuaweiArguments(tries: HuaweiArgumentHelpTries): void {
  tries.iface.describeArgs('ip address', [
    IP('address', 'IP address'),
    { ...MASK('Mask or mask-length'), optional: true },
  ]);
  tries.iface.describeArgs('description', [
    LINE('text', 'Interface description'),
  ]);

  tries.system.describeArgs('sysname', [
    WORD('name', 'Host name of the device'),
  ]);
  tries.system.describeArgs('ip route-static', [
    IP('prefix', 'Destination IP address'),
    { ...MASK('Mask or mask-length'), optional: true },
  ]);
  // `ospf` seul entre dans le processus 1 sur VRP : l'identifiant est
  // donc OPTIONNEL, et le déclarer obligatoire refusait la forme nue.
  tries.system.describeArgs('ospf', [
    { ...INT('process-id', [1, 65535], 'Process ID'), optional: true },
  ]);

  tries.ospf.describeArgs('router-id', [
    IP('router-id', 'Router ID in IP address format'),
  ]);

  tries.vty.describeArgs('idle-timeout', [
    INT('minutes', [0, 35791], 'Idle timeout in minutes'),
    { name: 'seconds', type: 'INT', description: 'Idle timeout in seconds',
      optional: true, range: [0, 59] },
  ]);
}
