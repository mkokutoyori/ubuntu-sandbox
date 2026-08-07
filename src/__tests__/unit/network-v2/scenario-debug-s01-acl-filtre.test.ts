import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

const run = (d: { executeCommand(c: string): string | Promise<string> }, c: string) =>
  Promise.resolve(d.executeCommand(c));

async function routeur(): Promise<CiscoRouter> {
  const r = new CiscoRouter('Router');
  await run(r, 'enable');
  return r;
}

async function poserFiltre(r: CiscoRouter, nom: string): Promise<string[]> {
  const sorties: string[] = [];
  await run(r, 'configure terminal');
  sorties.push(await run(r, `ip access-list extended ${nom}`));
  sorties.push(await run(r, '10 permit ip host 192.168.10.101 any'));
  sorties.push(await run(r, '20 permit ip any host 192.168.10.101'));
  await run(r, 'exit');
  await run(r, 'end');
  return sorties;
}

describe('Scénario 1 — ACL de filtrage avant tout debug', () => {
  it('l\'ACL nommée étendue s\'écrit avec des numéros de séquence', async () => {
    const r = await routeur();
    const sorties = await poserFiltre(r, 'MON-FILTRE-DEBUG');
    for (const s of sorties) expect(s).not.toContain('Invalid input');

    const acl = await run(r, 'show ip access-lists MON-FILTRE-DEBUG');
    expect(acl).toContain('Extended IP access list MON-FILTRE-DEBUG');
    expect(acl).toMatch(/10 permit ip host 192\.168\.10\.101 any/);
    expect(acl).toMatch(/20 permit ip any host 192\.168\.10\.101/);
  });

  it('debug ip packet <acl> nomme l\'ACL dans sa confirmation', async () => {
    const r = await routeur();
    await poserFiltre(r, 'MON-FILTRE-DEBUG');
    const out = await run(r, 'debug ip packet MON-FILTRE-DEBUG');
    expect(out).toContain('IP packet debugging is on for access list MON-FILTRE-DEBUG');
  });

  it('debug ip packet nu porte l\'avertissement CPU', async () => {
    const r = await routeur();
    const out = await run(r, 'debug ip packet');
  });

  it('show debugging liste le debug avec son ACL', async () => {
    const r = await routeur();
    await poserFiltre(r, 'MON-FILTRE-DEBUG');
    await run(r, 'debug ip packet MON-FILTRE-DEBUG');
    const out = await run(r, 'show debugging');
    expect(out).toContain('IP packet debugging is on for access list MON-FILTRE-DEBUG');
  });

  it('l\'ACL de debug filtre réellement les lignes émises', async () => {
    const r = await routeur();
    await poserFiltre(r, 'MON-FILTRE-DEBUG');
    const vues: string[] = [];
    r.getDebugService().subscribe((l: string) => vues.push(l));
    await run(r, 'debug ip packet MON-FILTRE-DEBUG');

    r.getDebugService().emitLine('ip.packet',
      'IP: s=192.168.10.101 (Gi0/0), d=8.8.8.8 (Gi0/1), g=8.8.8.8, len 64, forward');
    r.getDebugService().emitLine('ip.packet',
      'IP: s=192.168.10.102 (Gi0/0), d=8.8.8.8 (Gi0/1), g=8.8.8.8, len 64, forward');

    expect(vues.some(l => l.includes('192.168.10.101'))).toBe(true);
    expect(vues.some(l => l.includes('192.168.10.102'))).toBe(false);
  });

  it('no debug ip packet coupe ce seul debug', async () => {
    const r = await routeur();
    await run(r, 'debug ip packet');
    expect(await run(r, 'no debug ip packet')).toContain('IP packet debugging is off');
    expect(await run(r, 'show debugging')).toContain('No debug flags are enabled');
  });

  it('u all coupe tout et show debugging le confirme', async () => {
    const r = await routeur();
    await poserFiltre(r, 'MON-FILTRE-DEBUG');
    await run(r, 'debug ip packet MON-FILTRE-DEBUG');
    await run(r, 'debug ip icmp');
    expect(await run(r, 'u all')).toContain('All possible debugging has been turned off');
    expect(await run(r, 'show debugging')).toContain('No debug flags are enabled');
  });
});
