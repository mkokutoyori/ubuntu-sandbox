import { describe, it, expect } from 'vitest';
import { loadLab, resetLab, dumpLab, unplug, replug, LAB, type Lab, type LabStepInput } from './_lab';

const ROUTERS = ['Router1', 'Router2', 'Router3', 'Router4', 'Router5', 'Router6'] as const;

const etat = (titre: string): LabStepInput[] => ([
  { section: titre, on: 'PC1', cmd: `ping -n 2 ${LAB.lan2.server1}` },
  { on: 'Server1', cmd: `ping -c 2 ${LAB.lan1.pc1}` },
  ...ROUTERS.map((r) => ({ on: r, cmd: 'show ip ospf neighbor' } as LabStepInput)),
  { on: 'Router1', cmd: 'show ip route ospf' },
  { on: 'Router4', cmd: 'show ip route ospf' },
  { on: 'Router1', cmd: 'show ip interface brief' },
  { on: 'Router3', cmd: 'show ip interface brief' },
]);

function buildSteps(lab: Lab): LabStepInput[] {
  const s: LabStepInput[] = [];

  s.push(...etat('A. État initial — tout converge'));
  for (const r of ROUTERS) {
    s.push({ on: r, cmd: 'show running-config | section router ospf' });
  }

  s.push({ section: 'B. On débranche le lien R2-R3', on: 'Router2', cmd: 'show ip ospf neighbor' });
  s.push({ on: 'PC1', cmd: `ping -n 1 ${LAB.lan2.server1}` });
  s.push({ cmd: '! --- cable r2-r3 unplugged ---' });
  s.push(...etat('C. Après le débranchement'));

  s.push({ cmd: '! --- cable r2-r3 replugged ---' });
  s.push(...etat('D. Après le rebranchement'));
  for (const r of ROUTERS) {
    s.push({ on: r, cmd: 'show running-config | section router ospf' });
  }

  s.push({ cmd: '! --- cable pc1-sw1 unplugged then replugged ---' });
  s.push(...etat('E. Après un flap du câble PC1-Switch1'));
  s.push({ on: 'PC1', cmd: 'ipconfig' });

  s.push({ cmd: '! --- cable sw2-srv1 unplugged then replugged ---' });
  s.push(...etat('F. Après un flap du câble Server1-Switch2'));
  s.push({ on: 'Server1', cmd: 'ip addr show eth0' });
  s.push({ on: 'Server1', cmd: 'ip route' });

  s.push({ cmd: '! --- cables r1-r5, r5-r6, r6-r3 unplugged then replugged ---' });
  s.push(...etat('G. Après un flap du chemin de secours entier'));

  s.push({ section: 'H. Journaux', on: 'Router2', cmd: 'show logging' });
  s.push({ on: 'Router3', cmd: 'show logging' });

  return s;
}

describe('lab « My Network » — expérience 3 : débrancher puis rebrancher les câbles', () => {
  it('vérifie que le lab revient à l\'état convergé après chaque flap', async () => {
    resetLab();
    const lab = await loadLab();

    const steps = buildSteps(lab);
    const marker = (cmd: string) => {
      if (cmd === '! --- cable r2-r3 unplugged ---') unplug(lab, 'r2-r3');
      else if (cmd === '! --- cable r2-r3 replugged ---') replug(lab, 'r2-r3');
      else if (cmd === '! --- cable pc1-sw1 unplugged then replugged ---') {
        unplug(lab, 'pc1-sw1'); replug(lab, 'pc1-sw1');
      } else if (cmd === '! --- cable sw2-srv1 unplugged then replugged ---') {
        unplug(lab, 'sw2-srv1'); replug(lab, 'sw2-srv1');
      } else if (cmd === '! --- cables r1-r5, r5-r6, r6-r3 unplugged then replugged ---') {
        for (const id of ['r1-r5', 'r5-r6', 'r6-r3']) unplug(lab, id);
        for (const id of ['r1-r5', 'r5-r6', 'r6-r3']) replug(lab, id);
      } else return false;
      return true;
    };

    await dumpLab('cable-flap', lab, steps, 'chaque marqueur `! --- … ---` est un geste de câblage.', marker);

    const exec = (name: string, cmd: string) =>
      (lab.devices[name] as unknown as { executeCommand(c: string): Promise<string> }).executeCommand(cmd);

    expect(await exec('PC1', `ping -n 2 ${LAB.lan2.server1}`)).toMatch(/TTL=/);
    expect(await exec('Server1', `ping -c 2 ${LAB.lan1.pc1}`)).toMatch(/0% packet loss/);
    expect(await exec('Router1', 'show ip route')).toMatch(/O IA\s+192\.168\.40\.0/);
    expect(await exec('Router4', 'show ip route')).toMatch(/O IA\s+192\.168\.10\.0/);
    for (const r of ROUTERS) {
      expect(await exec(r, 'show running-config | section router ospf')).not.toContain('area 2');
    }
  }, 180000);
});
