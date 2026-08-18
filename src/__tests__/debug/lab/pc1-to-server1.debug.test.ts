/**
 * Expérience n°1 du lab : PC1 (192.168.10.2) ne joint pas Server1
 * (192.168.40.11).
 *
 * La transcription déroule le chemin de bout en bout — ping, tracert,
 * table de routage de chaque routeur, voisinages et LSDB OSPF — et
 * répond à la question posée : oui, c'est normal, la maquette contient
 * une discordance d'area OSPF sur deux liens du coeur.
 *
 *   - 10.0.20.0/30 : Router2 la déclare en area 0, Router3 en area 1.
 *   - 10.0.30.0/30 : Router3 la déclare en area 1, Router4 en area 0.
 *
 * Sur un IOS réel, l'Area ID voyage dans l'en-tête de chaque paquet OSPF
 * et un paquet dont l'area ne correspond pas à celle de l'interface qui
 * le reçoit est jeté (RFC 2328 §8.2) : ni Router2↔Router3 ni
 * Router3↔Router4 ne s'appairent, Router4 reste hors du domaine, et
 * personne n'apprend 192.168.40.0/24.
 *
 * Le simulateur, lui, arrive au même verdict par un autre chemin : il
 * laisse les adjacences se former malgré la discordance, puis Router3 —
 * devenu ABR — annonce 192.168.40.0/24 en inter-area au reste du
 * domaine SANS l'installer dans sa propre table. Le trafic remonte donc
 * jusqu'à lui et y meurt. Cet écart est relevé dans la transcription ;
 * les assertions ci-dessous ne portent que sur ce qui est vrai des deux
 * côtés, pour qu'une correction du contrôle d'area ne les casse pas.
 */
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

  steps.push({ section: 'Les adjacences — ce qu\'IOS refuserait de former', on: 'Router1', cmd: 'show ip ospf neighbor' });
  for (const r of ROUTERS) {
    steps.push({ on: r, cmd: 'show ip ospf neighbor' });
  }

  steps.push({ section: 'La LSDB — qui annonce 192.168.40.0/24 ?', on: 'Router1', cmd: 'show ip ospf database' });
  steps.push({ on: 'Router3', cmd: 'show ip ospf database' });
  steps.push({ on: 'Router4', cmd: 'show ip ospf database' });

  steps.push({ section: 'Journal de Router1', on: 'Router1', cmd: 'show logging' });

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
      'question = pourquoi PC1 192.168.10.2 ne ping-t-il pas Server1 192.168.40.11 ?',
    );

    const exec = (name: string, cmd: string) =>
      (lab.devices[name] as unknown as { executeCommand(c: string): Promise<string> }).executeCommand(cmd);

    // Le lab est bien monté : les deux hôtes ont pris leur bail DHCP
    // auprès du routeur de leur LAN et joignent leur passerelle. Ni le
    // câblage, ni l'adressage, ni les commutateurs ne sont en cause.
    expect(await exec('PC1', 'ipconfig')).toContain(LAB.lan1.pc1);
    expect(await exec('Server1', 'ip addr show eth0')).toContain(`${LAB.lan2.server1}/24`);
    expect(await exec('PC1', `ping -n 1 ${LAB.lan1.gw}`)).toMatch(/TTL=/i);
    expect(await exec('Server1', `ping -c 1 ${LAB.lan2.gw}`)).toMatch(/bytes from/i);

    // Le symptôme rapporté, dans les deux sens.
    expect(await exec('PC1', `ping -n 1 ${LAB.lan2.server1}`)).not.toMatch(/TTL=/i);
    expect(await exec('Server1', `ping -c 1 ${LAB.lan1.pc1}`)).toMatch(/100% packet loss/);

    // La cause, dans la configuration : les deux bouts de 10.0.20.0/30 et
    // de 10.0.30.0/30 ne déclarent pas la même area.
    const r2ospf = await exec('Router2', 'show running-config | section router ospf');
    const r3ospf = await exec('Router3', 'show running-config | section router ospf');
    const r4ospf = await exec('Router4', 'show running-config | section router ospf');
    expect(r2ospf).toContain(`network ${LAB.wan.r2r3.net} 0.0.0.3 area 0`);
    expect(r3ospf).toContain(`network ${LAB.wan.r2r3.net} 0.0.0.3 area 1`);
    expect(r3ospf).toContain(`network ${LAB.wan.r3r4.net} 0.0.0.3 area 1`);
    expect(r4ospf).toContain(`network ${LAB.wan.r3r4.net} 0.0.0.3 area 0`);

    // La conséquence sur le plan de données : Router3 est le dernier
    // routeur que le paquet atteint, et il n'a aucune route vers le LAN
    // de Server1 — alors qu'il est physiquement collé à Router4.
    const r3routes = await exec('Router3', 'show ip route');
    expect(r3routes).toContain(`${LAB.wan.r3r4.net}/30 is directly connected`);
    expect(r3routes).not.toContain(LAB.lan2.net);
  }, 180000);
});
