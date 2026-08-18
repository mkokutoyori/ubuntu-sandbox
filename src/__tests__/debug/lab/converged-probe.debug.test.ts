import { describe, it, expect } from 'vitest';
import { loadLab, resetLab, dumpLab, LAB, type LabStepInput } from './_lab';

const ROUTERS = ['Router1', 'Router2', 'Router3', 'Router4', 'Router5', 'Router6'] as const;

function buildSteps(): LabStepInput[] {
  const s: LabStepInput[] = [];

  s.push({ section: 'A. Bout en bout', on: 'PC1', cmd: `ping -n 4 ${LAB.lan2.server1}` });
  s.push({ on: 'PC1', cmd: `tracert ${LAB.lan2.server1}` });
  s.push({ on: 'Server1', cmd: `ping -c 4 ${LAB.lan1.pc1}` });
  s.push({ on: 'Server1', cmd: `traceroute ${LAB.lan1.pc1}` });
  s.push({ on: 'PC1', cmd: `ping -n 1 -l 1472 ${LAB.lan2.server1}` });
  s.push({ on: 'PC1', cmd: `ping -n 1 -l 2000 ${LAB.lan2.server1}` });
  s.push({ on: 'PC1', cmd: `ping -n 1 -f -l 1500 ${LAB.lan2.server1}` });
  s.push({ on: 'PC1', cmd: 'arp -a' });
  s.push({ on: 'Server1', cmd: 'ip neigh' });
  s.push({ on: 'Switch1', cmd: 'show mac address-table' });
  s.push({ on: 'Switch2', cmd: 'show mac address-table' });

  s.push({ section: 'B. L\'ABR — routes inter-area', on: 'Router1', cmd: 'enable' });
  for (const r of ROUTERS) {
    s.push({ on: r, cmd: 'enable' });
    s.push({ on: r, cmd: 'show ip route ospf' });
  }
  s.push({ on: 'Router1', cmd: 'show ip ospf border-routers' });
  s.push({ on: 'Router1', cmd: 'show ip ospf database summary' });
  s.push({ on: 'Router1', cmd: 'show ip ospf database router' });
  s.push({ on: 'Router3', cmd: 'show ip ospf' });
  s.push({ on: 'Router3', cmd: 'show ip ospf database' });
  s.push({ on: 'Router3', cmd: 'show ip ospf interface brief' });
  s.push({ on: 'Router4', cmd: 'show ip ospf database' });
  s.push({ on: 'Router4', cmd: 'show ip ospf border-routers' });
  s.push({ on: 'Router4', cmd: `show ip route ${LAB.lan1.net}` });
  s.push({ on: 'Router1', cmd: `show ip route ${LAB.lan2.net}` });

  s.push({ section: 'C. Résumé d\'area sur l\'ABR', on: 'Router3', cmd: 'configure terminal' });
  s.push({ on: 'Router3', cmd: 'router ospf 1' });
  s.push({ on: 'Router3', cmd: 'area 1 range 192.168.40.0 255.255.255.0' });
  s.push({ on: 'Router3', cmd: 'end' });
  s.push({ on: 'Router3', cmd: 'show running-config | section router ospf' });
  s.push({ on: 'Router1', cmd: 'show ip route ospf' });
  s.push({ on: 'Router1', cmd: 'show ip ospf database summary' });

  s.push({ section: 'D. Area 1 en stub', on: 'Router3', cmd: 'configure terminal' });
  s.push({ on: 'Router3', cmd: 'router ospf 1' });
  s.push({ on: 'Router3', cmd: 'area 1 stub' });
  s.push({ on: 'Router3', cmd: 'end' });
  s.push({ on: 'Router4', cmd: 'configure terminal' });
  s.push({ on: 'Router4', cmd: 'router ospf 1' });
  s.push({ on: 'Router4', cmd: 'area 1 stub' });
  s.push({ on: 'Router4', cmd: 'end' });
  s.push({ on: 'Router4', cmd: 'show ip ospf' });
  s.push({ on: 'Router4', cmd: 'show ip route ospf' });
  s.push({ on: 'PC1', cmd: `ping -n 2 ${LAB.lan2.server1}` });
  s.push({ on: 'Router3', cmd: 'configure terminal' });
  s.push({ on: 'Router3', cmd: 'router ospf 1' });
  s.push({ on: 'Router3', cmd: 'no area 1 stub' });
  s.push({ on: 'Router3', cmd: 'no area 1 range 192.168.40.0 255.255.255.0' });
  s.push({ on: 'Router3', cmd: 'end' });
  s.push({ on: 'Router4', cmd: 'configure terminal' });
  s.push({ on: 'Router4', cmd: 'router ospf 1' });
  s.push({ on: 'Router4', cmd: 'no area 1 stub' });
  s.push({ on: 'Router4', cmd: 'end' });

  s.push({ section: 'E. Convergence sur panne du lien R2-R3', on: 'Router2', cmd: 'show ip route ospf' });
  s.push({ on: 'Router1', cmd: `show ip route ${LAB.lan2.net}` });
  s.push({ on: 'Router2', cmd: 'configure terminal' });
  s.push({ on: 'Router2', cmd: 'interface GigabitEthernet0/1' });
  s.push({ on: 'Router2', cmd: 'shutdown' });
  s.push({ on: 'Router2', cmd: 'end' });
  s.push({ on: 'Router1', cmd: 'show ip ospf neighbor' });
  s.push({ on: 'Router3', cmd: 'show ip ospf neighbor' });
  s.push({ on: 'Router1', cmd: `show ip route ${LAB.lan2.net}` });
  s.push({ on: 'Router1', cmd: 'show ip route ospf' });
  s.push({ on: 'PC1', cmd: `ping -n 2 ${LAB.lan2.server1}` });
  s.push({ on: 'PC1', cmd: `tracert ${LAB.lan2.server1}` });
  s.push({ on: 'Router2', cmd: 'configure terminal' });
  s.push({ on: 'Router2', cmd: 'interface GigabitEthernet0/1' });
  s.push({ on: 'Router2', cmd: 'no shutdown' });
  s.push({ on: 'Router2', cmd: 'end' });
  s.push({ on: 'PC1', cmd: `ping -n 2 ${LAB.lan2.server1}` });

  s.push({ section: 'F. DHCP', on: 'Router1', cmd: 'show ip dhcp binding' });
  s.push({ on: 'Router1', cmd: 'show ip dhcp pool' });
  s.push({ on: 'Router4', cmd: 'show ip dhcp binding' });
  s.push({ on: 'Router4', cmd: 'show ip dhcp pool' });
  s.push({ on: 'Router4', cmd: 'show ip dhcp conflict' });
  s.push({ on: 'Router1', cmd: 'show ip dhcp server statistics' });
  s.push({ on: 'PC1', cmd: 'ipconfig /release' });
  s.push({ on: 'PC1', cmd: 'ipconfig' });
  s.push({ on: 'PC1', cmd: 'ipconfig /renew' });
  s.push({ on: 'PC1', cmd: 'ipconfig /all' });
  s.push({ on: 'Server1', cmd: 'dhclient -r eth0' });
  s.push({ on: 'Server1', cmd: 'dhclient eth0' });
  s.push({ on: 'Server1', cmd: 'ip addr show eth0' });

  s.push({ section: 'G. Le segment resté vierge', on: 'Router6', cmd: 'configure terminal' });
  s.push({ on: 'Router6', cmd: 'interface GigabitEthernet0/2' });
  s.push({ on: 'Router6', cmd: 'ip address 192.168.60.1 255.255.255.0' });
  s.push({ on: 'Router6', cmd: 'no shutdown' });
  s.push({ on: 'Router6', cmd: 'exit' });
  s.push({ on: 'Router6', cmd: 'ip dhcp excluded-address 192.168.60.1 192.168.60.10' });
  s.push({ on: 'Router6', cmd: 'ip dhcp pool LAB3' });
  s.push({ on: 'Router6', cmd: 'network 192.168.60.0 255.255.255.0' });
  s.push({ on: 'Router6', cmd: 'default-router 192.168.60.1' });
  s.push({ on: 'Router6', cmd: 'exit' });
  s.push({ on: 'Router6', cmd: 'router ospf 1' });
  s.push({ on: 'Router6', cmd: 'network 192.168.60.0 0.0.0.255 area 0' });
  s.push({ on: 'Router6', cmd: 'end' });
  s.push({ on: 'PC2', cmd: 'ipconfig /renew' });
  s.push({ on: 'PC2', cmd: 'ipconfig' });
  s.push({ on: 'WinServer1', cmd: 'ipconfig /renew' });
  s.push({ on: 'WinServer1', cmd: 'ipconfig' });
  s.push({ on: 'Router6', cmd: 'show ip dhcp binding' });
  s.push({ on: 'PC2', cmd: `ping -n 2 ${LAB.lan2.server1}` });
  s.push({ on: 'PC2', cmd: `ping -n 2 ${LAB.lan1.pc1}` });
  s.push({ on: 'Router1', cmd: 'show ip route ospf' });

  s.push({ section: 'H. Services de bout en bout', on: 'PC1', cmd: `ssh alice@${LAB.lan2.server1}` });
  s.push({ on: 'Server1', cmd: 'ss -tlnp' });
  s.push({ on: 'Server1', cmd: 'systemctl start nginx' });
  s.push({ on: 'Server1', cmd: 'systemctl status nginx' });
  s.push({ on: 'PC1', cmd: `curl http://${LAB.lan2.server1}/` });
  s.push({ on: 'PC1', cmd: `Test-NetConnection ${LAB.lan2.server1} -Port 22` });

  s.push({ section: 'I. Vue générale', on: 'Router3', cmd: 'show ip protocols' });
  s.push({ on: 'Router3', cmd: 'show ip ospf statistics' });
  s.push({ on: 'Router1', cmd: 'show ip ospf traffic' });
  s.push({ on: 'Router1', cmd: 'show ip cef' });
  s.push({ on: 'Router1', cmd: 'show logging' });
  s.push({ on: 'Router4', cmd: 'show logging' });

  return s;
}

describe('lab « My Network » — expérience 2 : le lab convergé, et ce qu\'il révèle', () => {
  it('converge de bout en bout et sonde le reste du simulateur', async () => {
    resetLab();
    const lab = await loadLab();

    await dumpLab(
      'converged-probe',
      lab,
      buildSteps(),
      'areas corrigées : area 0 = R1/R2/R5/R6 + le coeur, area 1 = R3-R4 + LAN2, Router3 en ABR.',
    );

    const exec = (name: string, cmd: string) =>
      (lab.devices[name] as unknown as { executeCommand(c: string): Promise<string> }).executeCommand(cmd);

    expect(await exec('Router3', 'show ip ospf neighbor')).toContain('10.0.20.1');
    expect(await exec('Router3', 'show ip ospf neighbor')).toContain('192.168.40.1');
    expect(await exec('Router4', 'show ip ospf neighbor')).toContain('10.0.30.1');
    expect(await exec('Router1', 'show ip route')).toMatch(/O IA\s+192\.168\.40\.0/);
    expect(await exec('Router4', 'show ip route')).toMatch(/O IA\s+192\.168\.10\.0/);
    expect(await exec('PC1', `ping -n 2 ${LAB.lan2.server1}`)).toMatch(/TTL=/);
    expect(await exec('Server1', `ping -c 2 ${LAB.lan1.pc1}`)).toMatch(/0% packet loss/);
  }, 180000);
});
