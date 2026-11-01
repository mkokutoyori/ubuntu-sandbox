/*
 * Un lab FortiGate sauvegarde puis rouvert doit laisser les MEMES acces : les comptes
 * administrateur se connectent avec leur mot de passe, `trusthost` filtre la source,
 * `allowaccess` ouvre ou ferme le service par interface, et les secrets de la
 * configuration (utilisateurs locaux, LDAP, RADIUS, PSK IPsec) restent ceux qu'on a poses.
 *
 * Mesure de depart : l'export ecrivait `set password ENC <blob>` -- comme un vrai FortiGate,
 * dont `show` rend les secrets sous cette forme -- mais le rejeu de cette meme ligne etait
 * refuse (« 1 value(s) for `password`, 2 given is missing ») : `ENC` et le blob etaient lus
 * comme deux valeurs. Le compte revenait SANS mot de passe : apres l'import,
 * `authenticateAdmin("ops", ...)` repondait faux, un `ssh` avec le bon mot de passe etait
 * refuse, et l'utilisateur local, l'annuaire LDAP, le serveur RADIUS et la cle pre-partagee
 * revenaient vides. Le rejeu ne montrait rien : `replayConfig` jette la reponse de chaque ligne.
 *
 * Correctif : un attribut secret accepte la forme `ENC <blob>` que `show` imprime, la decode, et
 * n'y applique ni la validation de valeur ni la politique de mot de passe (le blob n'est pas un
 * mot de passe qu'on tape).
 *
 * Discrimine avec `git stash push -- src/network src/store` : 4 des 9 cas tombent avant (mot de passe, mauvais mot de passe, SSH, secrets) ; les
 * TEMOINS (le lab avant sauvegarde, `trusthost` et `allowaccess`, qui sont des lignes en clair)
 * passent des deux cotes et prouvent que le lab est sain.
 *
 * Second lot : `replayConfig` renvoie desormais les lignes refusees, `importTopology` les rend dans
 * `ImportResult.warnings` (« FGT: <ligne> -> <reponse> ») et la fenetre d'import les affiche ; avant,
 * la reponse de chaque ligne rejouee etait jetee. Les 2 derniers cas (lab sain sans avertissement,
 * ligne cassee rapportee) tombent avant ce lot.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { buildConnection } from '@/store/networkStore';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import type { Equipment } from '@/network/equipment/Equipment';

beforeEach(() => {
  EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const OPS = 'S3cret!Pass';
const READER = 'Lecture-1';

async function lab(): Promise<{ firewall: FortiGate; pc: LinuxPC; devices: Map<string, Equipment>; connections: ReturnType<typeof buildConnection>[] }> {
  const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', -150, 0);
  const connections = [buildConnection(pc, 'eth0', firewall, 'port1', 'ethernet')];
  await pc.executeCommand('ip addr add 10.0.10.9/24 dev eth0');
  for (const line of [
    'config system interface', 'edit "port1"', 'set mode static', 'set ip 10.0.10.2 255.255.255.0', 'set allowaccess ping ssh', 'next',
    'edit "port2"', 'set mode static', 'set ip 10.0.20.2 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config system admin',
    'edit "ops"', `set password "${OPS}"`, 'set accprofile "super_admin"', 'set trusthost1 10.0.10.0 255.255.255.0', 'next',
    'edit "lecteur"', `set password "${READER}"`, 'set accprofile "prof_admin"', 'set trusthost1 172.16.0.0 255.255.0.0', 'next', 'end',
    'config user local', 'edit "alice"', 'set type password', 'set passwd "Wonder-land1"', 'next', 'end',
    'config user ldap', 'edit "annuaire"', 'set server 10.1.1.1', 'set password "ldap-pw"', 'next', 'end',
    'config user radius', 'edit "rad"', 'set server 10.1.1.2', 'set secret "radsecret-1"', 'next', 'end',
    'config vpn ipsec phase1-interface', 'edit "tun1"', 'set interface "port2"', 'set remote-gw 1.2.3.4', 'set psksecret "pskpsk-1"', 'next', 'end',
  ]) await firewall.executeCommand(line);
  const devices = new Map<string, Equipment>([firewall, pc].map((d) => [d.getId(), d as Equipment]));
  return { firewall, pc, devices, connections };
}

async function reopened(source: Awaited<ReturnType<typeof lab>>): Promise<{ firewall: FortiGate; pc: LinuxPC }> {
  const saved = JSON.parse(JSON.stringify(exportTopology('lab', source.devices, source.connections.filter((c) => c !== null) as never)));
  EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const back = await importTopology(saved);
  const byName = new Map([...back.deviceInstances.values()].map((d) => [d.getName(), d]));
  return { firewall: byName.get('FGT') as FortiGate, pc: byName.get('PC') as LinuxPC };
}

const secretLines = async (firewall: FortiGate): Promise<string> => {
  const views = ['show full-configuration user local alice', 'show user ldap', 'show user radius', 'show vpn ipsec phase1-interface'];
  const parts: string[] = [];
  for (const view of views) parts.push((await firewall.executeCommand(view)).split('\n').filter((l) => /passwd|password|secret|psk/.test(l)).join('\n'));
  return parts.join('\n');
};

describe('les acces d\'un FortiGate survivent a la sauvegarde du lab', () => {
  it('TEMOIN : avant la sauvegarde, le lab authentifie et filtre', async () => {
    const { firewall } = await lab();
    expect(firewall.authenticateAdmin('ops', OPS, '10.0.10.9')).toBe(true);
    expect(firewall.authenticateAdmin('ops', 'faux', '10.0.10.9')).toBe(false);
    expect(firewall.authenticateAdmin('ops', OPS, '172.16.0.1')).toBe(false);
  });

  it('le mot de passe de l\'administrateur survit', async () => {
    const { firewall } = await reopened(await lab());
    expect(firewall.authenticateAdmin('ops', OPS, '10.0.10.9')).toBe(true);
    expect(firewall.authenticateAdmin('lecteur', READER, '172.16.0.5')).toBe(true);
  });

  it('un mauvais mot de passe reste refuse', async () => {
    const { firewall } = await reopened(await lab());
    expect(firewall.authenticateAdmin('ops', 'faux', '10.0.10.9')).toBe(false);
    expect(firewall.authenticateAdmin('ops', '', '10.0.10.9')).toBe(false);
  });

  it('`trusthost` filtre toujours la source', async () => {
    const { firewall } = await reopened(await lab());
    expect(firewall.authenticateAdmin('ops', OPS, '172.16.0.1')).toBe(false);
    expect(firewall.authenticateAdmin('lecteur', READER, '10.0.10.9')).toBe(false);
  });

  it('le profil d\'acces du compte survit', async () => {
    const { firewall } = await reopened(await lab());
    const shown = await firewall.executeCommand('show system admin lecteur');
    expect(shown).toContain('set accprofile "prof_admin"');
    expect(shown).toContain('set trusthost1 172.16.0.0 255.255.0.0');
  });

  it('un SSH depuis le poste, avec le bon mot de passe, atteint le pare-feu', async () => {
    const { pc } = await reopened(await lab());
    const reply = await pc.executeCommand(`sshpass -p '${OPS}' ssh -o StrictHostKeyChecking=accept-new ops@10.0.10.2 "get system status"`);
    expect(reply).toContain('Version');
  });

  it('un SSH avec un mauvais mot de passe est refuse', async () => {
    const { pc } = await reopened(await lab());
    const reply = await pc.executeCommand('sshpass -p faux ssh -o StrictHostKeyChecking=accept-new ops@10.0.10.2 "get system status"');
    expect(reply).toMatch(/Permission denied/);
  });

  it('`allowaccess` ferme toujours ce qui n\'est pas liste', async () => {
    const { firewall } = await reopened(await lab());
    const shown = await firewall.executeCommand('show system interface port2');
    expect(shown).toContain('set allowaccess ping');
    expect(shown).not.toContain('ssh');
  });

  it('les secrets des utilisateurs, de l\'annuaire, de RADIUS et d\'IPsec sont ceux qu\'on a poses', async () => {
    const source = await lab();
    const before = await secretLines(source.firewall);
    expect(before).toContain('ENC');
    const { firewall } = await reopened(source);
    expect(await secretLines(firewall)).toBe(before);
  });
});

describe('un rejeu qui echoue ne se perd plus en silence', () => {
  it('TEMOIN : un lab sain s\'importe sans avertissement', async () => {
    const source = await lab();
    const saved = JSON.parse(JSON.stringify(exportTopology('lab', source.devices, source.connections.filter((c) => c !== null) as never)));
    EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    expect((await importTopology(saved)).warnings).toEqual([]);
  });

  it('une ligne refusee au rejeu est rapportee avec son pare-feu et la reponse', async () => {
    const source = await lab();
    const saved = JSON.parse(JSON.stringify(exportTopology('lab', source.devices, source.connections.filter((c) => c !== null) as never)));
    const entry = saved.devices.find((d: { name: string }) => d.name === 'FGT');
    entry.runningConfigText += '\nconfig system admin\nedit "casse"\nset password ENC\nnext\nend\nset inconnu 1\n';
    EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    const warnings = (await importTopology(saved)).warnings;
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/^FGT: /);
  });
});

describe('`config system api-user` : un jeton REST est un acces comme un autre', () => {
  async function avecApi() {
    const source = await lab();
    for (const line of [
      'config system accprofile', 'edit "reseau"', 'set netgrp read', 'next', 'end',
      'config system api-user', 'edit "robot"', 'set api-key "Abc123Def456Ghi789"', 'set accprofile "super_admin"',
      'config trusthost', 'edit 1', 'set ipv4-trusthost 10.0.10.0 255.255.255.0', 'next', 'end', 'next',
      'edit "limite"', 'set api-key "Limite0000Limite"', 'set accprofile "reseau"', 'next', 'end',
    ]) await source.firewall.executeCommand(line);
    return source;
  }
  const get = (pc: LinuxPC, path: string, token: string) =>
    pc.executeCommand(`curl -k -s -i --connect-timeout 3 -H "Authorization: Bearer ${token}" https://10.0.10.2${path}`);

  async function ouvert() {
    const source = await avecApi();
    await source.firewall.executeCommand('config system interface');
    await source.firewall.executeCommand('edit "port1"');
    await source.firewall.executeCommand('set allowaccess ping ssh https');
    await source.firewall.executeCommand('next');
    await source.firewall.executeCommand('end');
    return source;
  }

  it('le jeton ouvre l\'API sans session', async () => {
    const { pc } = await ouvert();
    expect(await get(pc, '/api/v2/cmdb/system/admin', 'Abc123Def456Ghi789')).toContain('200 OK');
  });

  it('un mauvais jeton est refuse en 401', async () => {
    const { pc } = await ouvert();
    expect(await get(pc, '/api/v2/cmdb/system/admin', 'faux')).toContain('401');
  });

  it('le profil limite ce que le jeton lit', async () => {
    const { pc } = await ouvert();
    expect(await get(pc, '/api/v2/cmdb/system/admin', 'Limite0000Limite')).toContain('403');
  });

  it('le jeton est rendu sous la forme ENC, jamais en clair', async () => {
    const { pc } = await ouvert();
    const body = await get(pc, '/api/v2/cmdb/system/api-user', 'Abc123Def456Ghi789');
    expect(body).not.toContain('Abc123Def456Ghi789');
    expect(body).toMatch(/"api-key":"ENC [^"]+"/);
  });

  it('la trusthost du jeton filtre la source', async () => {
    const { pc, firewall } = await ouvert();
    for (const line of ['config system api-user', 'edit "robot"', 'config trusthost', 'edit 1', 'set ipv4-trusthost 172.16.0.0 255.255.0.0', 'next', 'end', 'next', 'end']) await firewall.executeCommand(line);
    expect(await get(pc, '/api/v2/cmdb/system/admin', 'Abc123Def456Ghi789')).toContain('401');
  });

  it('le jeton, son profil et sa trusthost survivent a la sauvegarde', async () => {
    const { pc } = await reopened(await ouvert());
    expect(await get(pc, '/api/v2/cmdb/system/admin', 'Abc123Def456Ghi789')).toContain('200 OK');
    expect(await get(pc, '/api/v2/cmdb/system/admin', 'Limite0000Limite')).toContain('403');
    expect(await get(pc, '/api/v2/cmdb/system/admin', 'faux')).toContain('401');
  });
});
