import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';

export async function buildLab() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');
  new Cable('wan').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);
  return { r1, r2, pc1, pc2 };
}

export async function configureBase(
  router: CiscoRouter,
  wanIp: string, peerWan: string, lanIp: string,
  localSubnet: string, remoteSubnet: string,
): Promise<void> {
  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', `ip address ${wanIp} 255.255.255.252`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/0', `ip address ${lanIp} 255.255.255.0`, 'no shutdown', 'exit',
    'crypto ikev2 proposal PROP', 'encryption aes-cbc-256', 'integrity sha256', 'group 14', 'exit',
    'crypto ikev2 policy POL', 'proposal PROP', 'exit',
    'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
    'ip access-list extended VPN_ACL',
    `permit ip ${localSubnet} 0.0.0.255 ${remoteSubnet} 0.0.0.255`, 'exit',
    `ip route ${remoteSubnet} 255.255.255.0 ${peerWan}`,
    'end',
  ]) await router.executeCommand(cmd);
}

export async function buildCa(name: string, legs: ReadonlyArray<{ peer: CiscoRouter; caIp: string; peerIp: string; caPort: string }>): Promise<CiscoRouter> {
  const ca = new CiscoRouter(name);
  let index = 0;
  for (const leg of legs) {
    new Cable(`${name}-${index++}`).connect(ca.getPort(leg.caPort)!, leg.peer.getPort('GigabitEthernet0/2')!);
    for (const cmd of ['enable', 'configure terminal', `interface ${leg.caPort}`, `ip address ${leg.caIp} 255.255.255.252`, 'no shutdown', 'exit', 'end']) {
      await ca.executeCommand(cmd);
    }
    for (const cmd of ['enable', 'configure terminal', 'interface GigabitEthernet0/2', `ip address ${leg.peerIp} 255.255.255.252`, 'no shutdown', 'exit', 'end']) {
      await leg.peer.executeCommand(cmd);
    }
  }
  for (const cmd of [
    'enable', 'configure terminal', 'ip http server',
    'crypto pki server CS', `issuer-name CN=${name}-CA`, 'grant auto', 'no shutdown', 'end',
  ]) await ca.executeCommand(cmd);
  return ca;
}

export async function enrollTrustpoint(router: CiscoRouter, caUrl: string, subject: string, revocation = 'none'): Promise<string[]> {
  const out: string[] = [];
  for (const cmd of [
    'enable', 'configure terminal',
    'crypto pki trustpoint TP',
    `enrollment url ${caUrl}`,
    `subject-name ${subject}`,
    `revocation-check ${revocation}`,
    'exit',
    'crypto pki authenticate TP',
    'crypto pki enroll TP',
    'end',
  ]) out.push(await router.executeCommand(cmd));
  return out;
}

export async function configureX509Profile(router: CiscoRouter, peerWan: string): Promise<void> {
  for (const cmd of [
    'enable', 'configure terminal',
    'crypto ikev2 profile PROF',
    `match identity remote address ${peerWan} 255.255.255.255`,
    'authentication remote rsa-sig', 'authentication local rsa-sig', 'exit',
    'crypto map CMAP 10 ipsec-isakmp',
    `set peer ${peerWan}`, 'set ikev2-profile PROF',
    'set transform-set TSET', 'match address VPN_ACL', 'exit',
    'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit', 'end',
  ]) await router.executeCommand(cmd);
}

export async function seedPcs(pc1: LinuxPC, pc2: LinuxPC): Promise<void> {
  await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
  await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 192.168.2.1');
}

