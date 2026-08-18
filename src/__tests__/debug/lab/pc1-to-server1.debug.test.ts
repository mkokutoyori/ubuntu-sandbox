import { describe, it, expect } from 'vitest';
import { loadLab, resetLab, dumpLab, LAB, type LabStepInput } from './_lab';

const ROUTERS = ['Router1', 'Router2', 'Router3', 'Router4', 'Router5', 'Router6'] as const;

function buildSteps(): LabStepInput[] {
  const steps: LabStepInput[] = [];

  steps.push({ section: 'Le symptôme — PC1 vers Server1', on: 'PC1', cmd: `ping -n 2 ${LAB.lan2.server1}` });
  steps.push({ on: 'PC1', cmd: `tracert ${LAB.lan2.server1}` });
  steps.push({ on: 'PC1', cmd: 'ipconfig /all' });
  steps.push({ on: 'PC1', cmd: 'route print' });

  steps.push({ section: 'Le LAN de chaque côté est sain', on: 'PC1', cmd: `ping -n 1 ${LAB.lan1.gw}` });
  steps.push({ on: 'Server1', cmd: `ping -c 1 ${LAB.lan2.gw}` });
  steps.push({ on: 'Server1', cmd: 'ip addr show eth0' });
  steps.push({ on: 'Server1', cmd: 'ip route' });
  steps.push({ on: 'Router1', cmd: 'enable' });
  steps.push({ on: 'Router1', cmd: 'show ip dhcp binding' });
  steps.push({ on: 'Router4', cmd: 'enable' });
  steps.push({ on: 'Router4', cmd: 'show ip dhcp binding' });
  steps.push({ section: 'Le retour, vu de Server1', on: 'Server1', cmd: `ping -c 2 ${LAB.lan1.pc1}` });
  steps.push({ on: 'Server1', cmd: `traceroute ${LAB.lan1.pc1}` });

  steps.push({ section: 'Jusqu\'où le paquet passe-t-il ?', on: 'PC1', cmd: `ping -n 1 ${LAB.wan.r1r2.r2}` });
  steps.push({ on: 'PC1', cmd: `ping -n 1 ${LAB.wan.r2r3.r3}` });
  steps.push({ on: 'PC1', cmd: `ping -n 1 ${LAB.wan.r3r4.r4}` });
  steps.push({ on: 'PC1', cmd: `ping -n 1 ${LAB.lan2.gw}` });

  steps.push({ section: 'Les tables de routage, routeur par routeur', on: 'Router1', cmd: 'show ip route' });
  for (const r of ROUTERS) {
    steps.push({ on: r, cmd: 'enable' });
    steps.push({ on: r, cmd: 'show ip route' });
  }
  steps.push({ section: 'Le trou : Router3 n\'a pas de route vers le LAN2', on: 'Router3', cmd: `show ip route ${LAB.lan2.net}` });
  steps.push({ on: 'Router1', cmd: `show ip route ${LAB.lan2.net}` });
  steps.push({ on: 'Router2', cmd: `show ip route ${LAB.lan2.net}` });
  steps.push({ on: 'Router4', cmd: `show ip route ${LAB.lan1.net}` });

  steps.push({ section: 'Les areas déclarées de part et d\'autre des deux liens', on: 'Router2', cmd: 'show running-config | section router ospf' });
  steps.push({ on: 'Router3', cmd: 'show running-config | section router ospf' });
  steps.push({ on: 'Router4', cmd: 'show running-config | section router ospf' });
  for (const r of ROUTERS) {
    steps.push({ on: r, cmd: 'show ip protocols' });
    steps.push({ on: r, cmd: 'show ip ospf interface brief' });
  }

  steps.push({ section: 'Les adjacences — les deux liens en discordance ne s\'appairent pas', on: 'Router1', cmd: 'show ip ospf neighbor' });
  for (const r of ROUTERS) {
    steps.push({ on: r, cmd: 'show ip ospf neighbor' });
  }

  steps.push({ section: 'La LSDB — qui annonce 192.168.40.0/24 ?', on: 'Router1', cmd: 'show ip ospf database' });
  steps.push({ on: 'Router3', cmd: 'show ip ospf database' });
  steps.push({ on: 'Router4', cmd: 'show ip ospf database' });

  steps.push({ section: 'Les journaux — le rejet, nommé', on: 'Router1', cmd: 'show logging' });
  steps.push({ on: 'Router2', cmd: 'show logging' });
  steps.push({ on: 'Router3', cmd: 'show logging' });
  steps.push({ on: 'Router4', cmd: 'show logging' });

  return steps;
}

describe('lab « My Network » — expérience 1 : PC1 ne joint pas Server1', () => {
  it('reproduit la panne et la ramène à la discordance d\'area OSPF', async () => {
    resetLab();
    const lab = await loadLab();

    await dumpLab(
      'pc1-to-server1',
      lab,
      buildSteps(),
      'question = pourquoi PC1 192.168.10.2 ne ping-t-il pas Server1 192.168.40.11 ? '
      + 'verdict = discordance d\'area OSPF sur 10.0.20.0/30 et 10.0.30.0/30 ; les paquets sont '
      + 'rejetes (RFC 2328 §8.2), Router4 reste hors du domaine et personne n\'apprend 192.168.40.0/24.',
    );

    const exec = (name: string, cmd: string) =>
      (lab.devices[name] as unknown as { executeCommand(c: string): Promise<string> }).executeCommand(cmd);

    expect(await exec('PC1', 'ipconfig')).toContain(LAB.lan1.pc1);
    expect(await exec('Server1', 'ip addr show eth0')).toContain(`${LAB.lan2.server1}/24`);
    expect(await exec('PC1', `ping -n 1 ${LAB.lan1.gw}`)).toMatch(/TTL=/i);
    expect(await exec('Server1', `ping -c 1 ${LAB.lan2.gw}`)).toMatch(/bytes from/i);

    expect(await exec('PC1', `ping -n 1 ${LAB.lan2.server1}`)).not.toMatch(/TTL=/i);
    expect(await exec('Server1', `ping -c 1 ${LAB.lan1.pc1}`)).toMatch(/100% packet loss/);

    const r2ospf = await exec('Router2', 'show running-config | section router ospf');
    const r3ospf = await exec('Router3', 'show running-config | section router ospf');
    const r4ospf = await exec('Router4', 'show running-config | section router ospf');
    expect(r2ospf).toContain(`network ${LAB.wan.r2r3.net} 0.0.0.3 area 0`);
    expect(r3ospf).toContain(`network ${LAB.wan.r2r3.net} 0.0.0.3 area 1`);
    expect(r3ospf).toContain(`network ${LAB.wan.r3r4.net} 0.0.0.3 area 1`);
    expect(r4ospf).toContain(`network ${LAB.wan.r3r4.net} 0.0.0.3 area 0`);

    const r3routes = await exec('Router3', 'show ip route');
    expect(r3routes).toContain(`${LAB.wan.r3r4.net}/30 is directly connected`);
    expect(r3routes).not.toContain(LAB.lan2.net);
  }, 180000);
});
