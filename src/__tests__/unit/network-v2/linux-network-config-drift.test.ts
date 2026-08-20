import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

async function buildPc(): Promise<LinuxPC> {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const pc = new LinuxPC('linux-pc', 'client', 0, 0);
  new Cable('a').connect(pc.getPorts()[0], sw.getPorts()[0]);
  await pc.executeCommand('sudo su -');
  return pc;
}

function writeNetplan(pc: LinuxPC, yaml: string): Promise<string> {
  return pc.executeCommand(`cat > /etc/netplan/01-netcfg.yaml <<'EOF'\n${yaml}\nEOF`);
}

function writeFile(pc: LinuxPC, path: string, content: string): Promise<string> {
  return pc.executeCommand(`cat > ${path} <<'EOF'\n${content}\nEOF`);
}

const STATIC_YAML = `network:
  version: 2
  renderer: networkd
  ethernets:
    eth0:
      dhcp4: false
      addresses:
        - 10.0.0.50/24
      gateway4: 10.0.0.1
      mtu: 1400
`;

const STATIC_YAML_V2 = `network:
  version: 2
  renderer: networkd
  ethernets:
    eth0:
      dhcp4: false
      addresses:
        - 10.0.0.77/24
      gateway4: 10.0.0.1
      mtu: 1400
`;

describe('Scénario 1 — Cohérence /etc/netplan vs état réel des interfaces', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  it('netplan apply pousse adresse, passerelle et MTU déclarés vers l\'état réel', async () => {
    const pc = await buildPc();
    await writeNetplan(pc, STATIC_YAML);
    await pc.executeCommand('netplan apply');

    const addr = await pc.executeCommand('ip addr show eth0');
    expect(addr).toMatch(/10\.0\.0\.50\/24/);

    const link = await pc.executeCommand('ip link show eth0');
    expect(link).toMatch(/mtu 1400/);

    const route = await pc.executeCommand('ip route show');
    expect(route).toMatch(/default via 10\.0\.0\.1/);
  });

  it('modifier le fichier sans "netplan apply" laisse ip addr show inchangé (dérive mesurable)', async () => {
    const pc = await buildPc();
    await writeNetplan(pc, STATIC_YAML);
    await pc.executeCommand('netplan apply');

    await writeNetplan(pc, STATIC_YAML_V2);
    const addr = await pc.executeCommand('ip addr show eth0');
    expect(addr).not.toMatch(/10\.0\.0\.77/);
    expect(addr).toMatch(/10\.0\.0\.50\/24/);

    const fileContent = await pc.executeCommand('cat /etc/netplan/01-netcfg.yaml');
    expect(fileContent).toMatch(/10\.0\.0\.77/);
  });

  it('"netplan try" affiche le changement à venir sans l\'appliquer', async () => {
    const pc = await buildPc();
    await writeNetplan(pc, STATIC_YAML);
    await pc.executeCommand('netplan apply');
    await writeNetplan(pc, STATIC_YAML_V2);

    const tryOut = await pc.executeCommand('netplan try');
    expect(tryOut).toMatch(/10\.0\.0\.77/);
    expect(tryOut).toMatch(/not applied|dry-run/i);

    const addr = await pc.executeCommand('ip addr show eth0');
    expect(addr).toMatch(/10\.0\.0\.50\/24/);
    expect(addr).not.toMatch(/10\.0\.0\.77/);
  });

  it('"systemctl restart systemd-networkd" applique la dérive en attente et le journalise', async () => {
    const pc = await buildPc();
    await writeNetplan(pc, STATIC_YAML);
    await pc.executeCommand('netplan apply');
    await writeNetplan(pc, STATIC_YAML_V2);

    await pc.executeCommand('systemctl restart systemd-networkd');

    const addr = await pc.executeCommand('ip addr show eth0');
    expect(addr).toMatch(/10\.0\.0\.77\/24/);
    expect(addr).not.toMatch(/10\.0\.0\.50/);

    const journal = await pc.executeCommand('journalctl -u systemd-networkd');
    expect(journal).toMatch(/eth0.*10\.0\.0\.77/);
  });

  it('modification manuelle "ip addr add" ne touche pas le fichier netplan (dérive inverse)', async () => {
    const pc = await buildPc();
    await writeNetplan(pc, STATIC_YAML);
    await pc.executeCommand('netplan apply');

    await pc.executeCommand('ip addr add 10.0.0.99/24 dev eth0');
    const addr = await pc.executeCommand('ip addr show eth0');
    expect(addr).toMatch(/10\.0\.0\.99\/24/);

    const fileContent = await pc.executeCommand('cat /etc/netplan/01-netcfg.yaml');
    expect(fileContent).not.toMatch(/10\.0\.0\.99/);
    expect(fileContent).toMatch(/10\.0\.0\.50/);
  });

  it('"networkctl status eth0" révèle la source de configuration (statique, networkd) et aucun conflit par défaut', async () => {
    const pc = await buildPc();
    await writeNetplan(pc, STATIC_YAML);
    await pc.executeCommand('netplan apply');

    const status = await pc.executeCommand('networkctl status eth0');
    expect(status).toMatch(/State:\s+routable \(configured\)/);
    expect(status).toMatch(/Address Source:\s+static/);
    expect(status).not.toMatch(/also managed by NetworkManager/);
  });

  it('"nmcli device status" affiche l\'interface comme unmanaged par défaut (NetworkManager.conf managed=false)', async () => {
    const pc = await buildPc();
    await writeNetplan(pc, STATIC_YAML);
    await pc.executeCommand('netplan apply');

    const status = await pc.executeCommand('nmcli device status');
    expect(status).toMatch(/eth0\s+ethernet\s+unmanaged/);
  });

  it('conflit NetworkManager: céder la gestion sans le déclarer produit un avertissement journalisé', async () => {
    const pc = await buildPc();
    await writeNetplan(pc, STATIC_YAML);
    await pc.executeCommand('netplan apply');

    await writeFile(pc, '/etc/NetworkManager/NetworkManager.conf', '[main]\nplugins=ifupdown,keyfile\n');

    const status = await pc.executeCommand('nmcli device status');
    expect(status).toMatch(/eth0\s+ethernet\s+connected/);

    await pc.executeCommand('netplan apply');
    const syslog = await pc.executeCommand('cat /var/log/syslog');
    expect(syslog).toMatch(/also managed by NetworkManager/);

    const netStatus = await pc.executeCommand('networkctl status eth0');
    expect(netStatus).toMatch(/also managed by NetworkManager/);
  });

  it('résolution du conflit: restaurer managed=false rend l\'interface de nouveau unmanaged et arrête les avertissements', async () => {
    const pc = await buildPc();
    await writeNetplan(pc, STATIC_YAML);
    await pc.executeCommand('netplan apply');
    await writeFile(pc, '/etc/NetworkManager/NetworkManager.conf', '[main]\nplugins=ifupdown,keyfile\n');
    await pc.executeCommand('netplan apply');

    await writeFile(
      pc,
      '/etc/NetworkManager/NetworkManager.conf',
      '[main]\nplugins=ifupdown,keyfile\n\n[ifupdown]\nmanaged=false\n',
    );

    const status = await pc.executeCommand('nmcli device status');
    expect(status).toMatch(/eth0\s+ethernet\s+unmanaged/);

    const beforeApply = await pc.executeCommand('cat /var/log/syslog');
    const warningsBefore = (beforeApply.match(/also managed by NetworkManager/g) ?? []).length;
    await pc.executeCommand('netplan apply');
    const afterApply = await pc.executeCommand('cat /var/log/syslog');
    const warningsAfter = (afterApply.match(/also managed by NetworkManager/g) ?? []).length;
    expect(warningsAfter).toBe(warningsBefore);
  });

  it('après résolution complète, ip addr show et le fichier sont strictement cohérents (aucune adresse résiduelle)', async () => {
    const pc = await buildPc();
    await writeNetplan(pc, STATIC_YAML);
    await pc.executeCommand('netplan apply');
    await writeNetplan(pc, STATIC_YAML_V2);
    await pc.executeCommand('netplan apply');

    const addr = await pc.executeCommand('ip addr show eth0');
    expect(addr).toMatch(/10\.0\.0\.77\/24/);
    expect(addr).not.toMatch(/10\.0\.0\.50/);
  });

  it('"ifup"/"ifdown" appliquent /etc/network/interfaces indépendamment de netplan', async () => {
    const pc = await buildPc();
    await writeFile(
      pc,
      '/etc/network/interfaces',
      'auto eth0\niface eth0 inet static\n    address 192.168.50.5\n    netmask 255.255.255.0\n    gateway 192.168.50.1\n',
    );

    await pc.executeCommand('ifup eth0');
    const addrUp = await pc.executeCommand('ip addr show eth0');
    expect(addrUp).toMatch(/192\.168\.50\.5\/24/);

    await pc.executeCommand('ifdown eth0');
    const addrDown = await pc.executeCommand('ip addr show eth0');
    expect(addrDown).not.toMatch(/192\.168\.50\.5/);
    expect(addrDown).toMatch(/state DOWN|DOWN/);
  });
});
