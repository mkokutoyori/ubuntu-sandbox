import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

export interface Lab {
  readonly pc: LinuxPC;
  readonly srv: LinuxServer;
}

export async function buildLab(sshdDirectives: readonly string[] = []): Promise<Lab> {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  await srv.executeCommand('useradd -m -s /bin/bash alice');
  await srv.executeCommand("echo 'alice:admin' | chpasswd");
  await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -C ca@lab -f ~/ca");
  await pc.executeCommand("ssh-keygen -q -t ed25519 -N '' -C alice@lab -f ~/id");
  const caLine = (await pc.executeCommand('cat ~/ca.pub')).trim();
  await srv.executeCommand(`printf '%s\\n' '${caLine}' > /etc/ssh/ca.pub`);
  for (const directive of sshdDirectives) await srv.executeCommand(`printf '%s\\n' '${directive}' >> /etc/ssh/sshd_config`);
  await srv.executeCommand('systemctl restart ssh');
  return { pc, srv };
}

export const TRUST = 'TrustedUserCAKeys /etc/ssh/ca.pub';
export const SSH = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no -i ~/id alice@10.0.0.2';

export async function certify(lab: Lab, options: string): Promise<string> {
  return lab.pc.executeCommand(`ssh-keygen -s ~/ca -I alice-key -z 7 ${options} ~/id.pub`);
}

export async function authLog(lab: Lab): Promise<string> {
  return lab.srv.executeCommand('cat /var/log/auth.log');
}

