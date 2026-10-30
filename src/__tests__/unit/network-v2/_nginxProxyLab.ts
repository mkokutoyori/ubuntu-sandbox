import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import type { HttpMessage } from '@/network/http/semantics/types';

/**
 * `printf` passe par le shell, qui mange un `$` non protégé : sans
 * l'échappement, `proxy_set_header Host $host;` arrive dans le fichier
 * comme `proxy_set_header Host ;` et le cas ne mesure plus rien. C'est
 * arrivé, et le premier jet de ces tests concluait à tort que
 * `proxy_set_header` n'était pas appliqué.
 */
export function ecrireConf(texte: string): string {
  const echappe = texte
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$');
  return `sh -c 'printf "${echappe}" > /etc/nginx/sites-available/default'`;
}

export interface Labo {
  front: LinuxServer;
  back: LinuxServer;
  /** Ce que l'amont a REÇU — un miroir vaut mieux qu'une page fixe. */
  vu: HttpMessage[];
}

export function labo(): Labo {
  const front = new LinuxServer('linux-server', 'FRONT');
  const back = new LinuxServer('linux-server', 'BACK');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  front.powerOn();
  back.powerOn();
  new Cable('a').connect(front.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(back.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  front.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  back.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { front, back, vu: [] };
}

export async function demarrer(lab: Labo, conf: string): Promise<void> {
  await lab.front.executeCommand(ecrireConf(conf));
  await lab.front.executeCommand('systemctl restart nginx');
}
