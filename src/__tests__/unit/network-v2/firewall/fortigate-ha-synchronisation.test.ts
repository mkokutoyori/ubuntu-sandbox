import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Membre { fw: FortiGate; sh: FortiShell }

function run(sh: FortiShell, ...lines: string[]): string {
  let out = '';
  for (const line of lines) out = sh.execute(line);
  return out;
}

function membre(nom: string, lan: string): Membre {
  const fw = new FortiGate('firewall-fortinet', nom, 0, 0);
  const sh = new FortiShell(fw);
  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    `set ip ${lan} 255.255.255.0`, 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'next', 'end');
  return { fw, sh };
}

function grappe(m: Membre, priorite: number): string {
  return run(m.sh,
    'config system ha',
    'set group-name "cluster-paris"', 'set group-id 10', 'set mode a-p',
    'set password "SecretHA"', 'set hbdev "port7" 50',
    `set priority ${priorite}`, 'set monitor "port1" "port2"', 'end');
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

function laboratoire() {
  const a = membre('FGT-A', '192.168.1.1');
  const b = membre('FGT-B', '192.168.1.2');
  const temoins = [0, 1, 2, 3].map(i => new LinuxPC('linux-pc', `T${i}`, 0, 0));

  new Cable('hb').connect(a.fw.getPort('port7')!, b.fw.getPort('port7')!);
  new Cable('lan-a').connect(a.fw.getPort('port1')!, temoins[0].getPort('eth0')!);
  new Cable('wan-a').connect(a.fw.getPort('port2')!, temoins[1].getPort('eth0')!);
  new Cable('lan-b').connect(b.fw.getPort('port1')!, temoins[2].getPort('eth0')!);
  new Cable('wan-b').connect(b.fw.getPort('port2')!, temoins[3].getPort('eth0')!);

  grappe(a, 200);
  grappe(b, 128);
  return { a, b };
}

function battre(a: Membre, b: Membre, tours = 3): void {
  for (let tour = 0; tour < tours; tour += 1) {
    a.fw.getHa().tick();
    b.fw.getHa().tick();
  }
}

describe('`execute ha synchronize start` TIRE la configuration depuis un secondaire', () => {
  it('le laboratoire designe bien un primaire et un secondaire', () => {
    const { a, b } = laboratoire();
    battre(a, b);

    expect(a.fw.getHa().role()).toBe('master');
    expect(b.fw.getHa().role()).toBe('slave');
  });

  it('une modification du primaire NON battue n\'a pas encore atteint le secondaire', () => {
    const { a, b } = laboratoire();
    battre(a, b);
    run(a.sh, 'config firewall address', 'edit "NET-NOUVEAU"',
      'set subnet 10.99.0.0 255.255.0.0', 'next', 'end');

    expect(b.sh.execute('show firewall address')).not.toContain('NET-NOUVEAU');
  });

  it('la commande tapee sur le SECONDAIRE tire la configuration du primaire', () => {
    const { a, b } = laboratoire();
    battre(a, b);
    run(a.sh, 'config firewall address', 'edit "NET-NOUVEAU"',
      'set subnet 10.99.0.0 255.255.0.0', 'next', 'end');

    b.sh.execute('execute ha synchronize start');

    expect(b.sh.execute('show firewall address')).toContain('NET-NOUVEAU');
  });

  it('la commande tapee sur le PRIMAIRE pousse toujours, elle ne tire pas', () => {
    const { a, b } = laboratoire();
    battre(a, b);
    run(a.sh, 'config firewall address', 'edit "NET-POUSSE"',
      'set subnet 10.98.0.0 255.255.0.0', 'next', 'end');

    a.sh.execute('execute ha synchronize start');

    expect(b.sh.execute('show firewall address')).toContain('NET-POUSSE');
  });

  it('l\'echange est BORNE : demande, reponse, battement — et rien de plus', () => {
    const { a, b } = laboratoire();
    battre(a, b);

    const cable = a.fw.getPort('port7')!.getCable();
    const avant = cable?.getStats().framesTransmitted ?? 0;
    b.sh.execute('execute ha synchronize start');
    const trames = (cable?.getStats().framesTransmitted ?? 0) - avant;

    expect(trames).toBe(3);
  });

  it('le primaire repond SANS attendre son prochain battement', () => {
    const { a, b } = laboratoire();
    battre(a, b);
    run(a.sh, 'config firewall address', 'edit "NET-IMMEDIAT"',
      'set subnet 10.97.0.0 255.255.0.0', 'next', 'end');

    b.sh.execute('execute ha synchronize start');

    expect(b.sh.execute('show firewall address')).toContain('NET-IMMEDIAT');
    expect(a.fw.getHa().role()).toBe('master');
  });

  it('hors grappe, la commande est REFUSEE en nommant la raison', () => {
    const seul = membre('FGT-SEUL', '192.168.9.1');

    const refus = seul.sh.execute('execute ha synchronize start');

    expect(refus).toMatch(/Command fail/i);
    expect(refus).toContain('not part of a cluster');
  });
});
