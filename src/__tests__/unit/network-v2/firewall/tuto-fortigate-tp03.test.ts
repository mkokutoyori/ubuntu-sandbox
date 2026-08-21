import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function taper(d: FortiGate, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

function propre(sorties: string[]): void {
  for (const s of sorties) {
    expect(s).not.toMatch(/Unknown action|command parse error|Invalid|entry not found/i);
  }
}

async function troisObjets(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config firewall address',
    'edit "TP3-Serveur-A"', 'set subnet 10.99.1.10 255.255.255.255', 'next',
    'edit "TP3-Serveur-B"', 'set subnet 10.99.1.11 255.255.255.255', 'next',
    'edit "TP3-Reseau"', 'set subnet 10.99.1.0 255.255.255.0', 'next',
    'end',
  ]);
}

describe('TP 3 — maitriser la CLI par la manipulation', () => {
  it('etape 1 : trois objets se creent dans une seule table', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    propre(await troisObjets(fgt));
    const conf = await fgt.executeCommand('show firewall address');
    expect(conf).toContain('edit "TP3-Serveur-A"');
    expect(conf).toContain('edit "TP3-Serveur-B"');
    expect(conf).toContain('edit "TP3-Reseau"');
    expect(conf).toContain('set subnet 10.99.1.0 255.255.255.0');
  });

  it('etape 1 : l\'invite dit TOUJOURS ou l\'on est dans l\'arbre', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await fgt.executeCommand('config firewall address');
    expect(fgt.getPrompt()).toBe('FGT-01 (address) # ');
    await fgt.executeCommand('edit "TP3-Serveur-A"');
    expect(fgt.getPrompt()).toBe('FGT-01 (TP3-Serveur-A) # ');
    await fgt.executeCommand('next');
    expect(fgt.getPrompt()).toBe('FGT-01 (address) # ');
    await fgt.executeCommand('end');
    expect(fgt.getPrompt()).toBe('FGT-01 # ');
  });

  it('etape 2 : `show ... | grep` filtre vraiment la sortie', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await troisObjets(fgt);
    const filtre = await fgt.executeCommand('show firewall address | grep TP3');
    expect(filtre).toContain('TP3-Serveur-A');
    expect(filtre).not.toMatch(/^\s*set subnet 10\.99\.1\.10/m);
    expect(filtre).not.toContain('config firewall address');
  });

  it('etape 3 : `set ?` decrit les attributs de l\'objet', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await taper(fgt, ['config firewall address', 'edit "TP3-Serveur-A"']);
    const aide = await fgt.executeCommand('set ?');
    expect(aide).toContain('type');
    expect(aide).toContain('comment');
    expect(aide).toContain('subnet');
    await fgt.executeCommand('abort');
  });

  it('etape 3 : `set type ?` decrit les valeurs admises', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await taper(fgt, ['config firewall address', 'edit "TP3-Serveur-A"']);
    const aide = await fgt.executeCommand('set type ?');
    expect(aide).toContain('ipmask');
    expect(aide).toContain('iprange');
    expect(aide).toContain('fqdn');
    await fgt.executeCommand('abort');
  });

  it('etape 3 : `abort` ANNULE ce qui a ete tape', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await troisObjets(fgt);
    await taper(fgt, [
      'config firewall address', 'edit "TP3-Serveur-A"',
      'set comment "annule"', 'abort',
    ]);
    expect(fgt.getPrompt()).toBe('FGT-01 # ');
    expect(await fgt.executeCommand('show firewall address')).not.toContain('annule');
  });

  it('etape 4 : `show <table> <objet>` ne rend QUE cet objet', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await troisObjets(fgt);
    const un = await fgt.executeCommand('show firewall address TP3-Serveur-A');
    expect(un).toContain('edit "TP3-Serveur-A"');
    expect(un).toContain('set subnet 10.99.1.10 255.255.255.255');
    expect(un).not.toContain('TP3-Serveur-B');
  });

  it('etape 4 : `show full-configuration` en rend davantage', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await troisObjets(fgt);
    const court = await fgt.executeCommand('show firewall address TP3-Serveur-A');
    const complet = await fgt.executeCommand(
      'show full-configuration firewall address TP3-Serveur-A');
    expect(complet).toContain('edit "TP3-Serveur-A"');
    expect(complet).toContain('set type');
    expect(complet.split('\n').length).toBeGreaterThan(court.split('\n').length);
  });

  it('etape 5 : `clone ... to ...` duplique VRAIMENT les valeurs', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await troisObjets(fgt);
    propre(await taper(fgt, [
      'config firewall address',
      'clone "TP3-Serveur-A" to "TP3-Serveur-C"',
      'end',
    ]));
    const conf = await fgt.executeCommand('show firewall address TP3-Serveur-C');
    expect(conf).toContain('edit "TP3-Serveur-C"');
    expect(conf).toContain('set subnet 10.99.1.10 255.255.255.255');

    propre(await taper(fgt, [
      'config firewall address', 'edit "TP3-Serveur-C"',
      'set subnet 10.99.1.12 255.255.255.255',
      'set comment "Cree par clonage"', 'next', 'end',
    ]));
    expect(await fgt.executeCommand('show firewall address TP3-Serveur-A'))
      .toContain('set subnet 10.99.1.10 255.255.255.255');
    expect(await fgt.executeCommand('show firewall address TP3-Serveur-C'))
      .toContain('set subnet 10.99.1.12 255.255.255.255');
  });

  it('etape 6 : `rename ... to ...` garde les valeurs', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await troisObjets(fgt);
    await taper(fgt, [
      'config firewall address', 'clone "TP3-Serveur-A" to "TP3-Serveur-C"', 'end',
    ]);
    propre(await taper(fgt, [
      'config firewall address',
      'rename "TP3-Serveur-C" to "TP3-Serveur-Clone"',
      'end',
    ]));
    const conf = await fgt.executeCommand('show firewall address');
    expect(conf).toContain('edit "TP3-Serveur-Clone"');
    expect(conf).not.toContain('TP3-Serveur-C"');
  });

  it('etape 7 : supprimer un objet REFERENCE est refuse', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await troisObjets(fgt);
    propre(await taper(fgt, [
      'config firewall addrgrp', 'edit "TP3-Groupe"',
      'set member "TP3-Serveur-A" "TP3-Serveur-B"', 'next', 'end',
    ]));
    await fgt.executeCommand('config firewall address');
    const refus = await fgt.executeCommand('delete "TP3-Serveur-A"');
    expect(refus).toMatch(/used by other entries|Cannot be deleted/i);
    await fgt.executeCommand('end');
    expect(await fgt.executeCommand('show firewall address'))
      .toContain('edit "TP3-Serveur-A"');
  });

  it('etape 7 : `diagnose sys checkused` NOMME qui reference l\'objet', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await troisObjets(fgt);
    await taper(fgt, [
      'config firewall addrgrp', 'edit "TP3-Groupe"',
      'set member "TP3-Serveur-A" "TP3-Serveur-B"', 'next', 'end',
    ]);
    const out = await fgt.executeCommand(
      'diagnose sys checkused firewall.address.name "TP3-Serveur-A"');
    expect(out).not.toMatch(/Unknown action/i);
    expect(out).toContain('TP3-Groupe');
  });

  it('etape 8 : le nettoyage dans le bon ordre passe, et laisse la table vide', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await troisObjets(fgt);
    await taper(fgt, [
      'config firewall addrgrp', 'edit "TP3-Groupe"',
      'set member "TP3-Serveur-A" "TP3-Serveur-B"', 'next', 'end',
    ]);
    propre(await taper(fgt, [
      'config firewall addrgrp', 'delete "TP3-Groupe"', 'end',
      'config firewall address',
      'delete "TP3-Serveur-A"', 'delete "TP3-Serveur-B"',
      'delete "TP3-Reseau"', 'end',
    ]));
    expect(await fgt.executeCommand('show firewall address | grep TP3')).toBe('');
  });

  it('`set` sur une liste REMPLACE, il n\'ajoute pas', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await troisObjets(fgt);
    await taper(fgt, [
      'config firewall addrgrp', 'edit "TP3-Groupe"',
      'set member "TP3-Serveur-A" "TP3-Serveur-B"',
      'set member "TP3-Reseau"',
      'next', 'end',
    ]);
    const conf = await fgt.executeCommand('show firewall addrgrp TP3-Groupe');
    expect(conf).toContain('TP3-Reseau');
    expect(conf).not.toContain('TP3-Serveur-A');
  });

  it('`append` AJOUTE la ou `set` remplace', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await troisObjets(fgt);
    propre(await taper(fgt, [
      'config firewall addrgrp', 'edit "TP3-Groupe"',
      'set member "TP3-Serveur-A"',
      'append member "TP3-Serveur-B"',
      'next', 'end',
    ]));
    const conf = await fgt.executeCommand('show firewall addrgrp TP3-Groupe');
    expect(conf).toContain('TP3-Serveur-A');
    expect(conf).toContain('TP3-Serveur-B');
  });
});
