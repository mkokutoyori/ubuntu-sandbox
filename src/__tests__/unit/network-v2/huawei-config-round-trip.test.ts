/**
 * PRD-CLI-Fidelite-VRP.md §1.2-§1.3 / chantier A / lot V2 — la
 * configuration doit se rejouer.
 *
 * L'invariant n'est pas une liste de lignes attendues mais un
 * ALLER-RETOUR : serialiser, retaper sur une machine neuve en honorant
 * les `#`, re-serialiser, comparer. Zero ligne refusee, et les deux
 * textes identiques.
 *
 * C'est ce que fait l'import d'une topologie : la configuration rendue
 * n'est pas un affichage, c'est ce qui REFAIT l'equipement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;

async function run(dev: HuaweiRouter, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await dev.executeCommand(c);
}

/**
 * Une configuration qui touche chaque famille de bloc : interface,
 * Loopback, route statique, ACL numerotee a la main, RIP, OSPF, comptes.
 * Elle est volontairement variee — un aller-retour ne prouve rien s'il
 * ne traverse qu'un seul type de bloc.
 */
const POSE: readonly string[] = [
  'system-view', 'sysname LAB',
  'interface GigabitEthernet0/0/0', 'ip address 10.0.12.1 255.255.255.0',
  'description VERS-B', 'undo shutdown', 'quit',
  'interface LoopBack0', 'ip address 9.9.9.9 255.255.255.255', 'quit',
  'ip route-static 172.16.0.0 255.255.0.0 10.0.12.2 preference 100',
  'ospf 1 router-id 9.9.9.9', 'area 0', 'network 10.0.12.0 0.0.0.255', 'quit', 'quit',
  'rip 1', 'version 2', 'undo summary', 'network 10.0.0.0', 'quit',
  'acl number 2000', 'rule 15 permit source 10.0.0.0 0.255.255.255',
  'rule 25 deny source 192.168.1.0 0.0.0.255', 'quit',
  'aaa', 'local-user zoe password irreversible-cipher Huawei@123',
  'local-user zoe service-type telnet', 'quit',
];

/** Rejoue une configuration comme un import : `#` ramene en vue systeme. */
async function rejouer(conf: string, cible: HuaweiRouter): Promise<string[]> {
  const refus: string[] = [];
  await cible.executeCommand('system-view');
  for (const ligne of conf.split('\n')) {
    const t = ligne.trim();
    if (!t) continue;
    if (t === '#') {
      await cible.executeCommand('return');
      await cible.executeCommand('system-view');
      continue;
    }
    const out = await cible.executeCommand(t);
    if (/Error:/.test(out)) refus.push(`${t} => ${out.split('\n')[0]}`);
  }
  return refus;
}

async function labo(): Promise<{ conf: string; source: HuaweiRouter }> {
  const source = new HuaweiRouter(`TA${++serie}`);
  await run(source, POSE);
  return { conf: await source.executeCommand('display current-configuration'), source };
}

describe('l\'aller-retour de configuration', () => {
  it('ne fait refuser aucune de ses propres lignes', async () => {
    const { conf } = await labo();
    const refus = await rejouer(conf, new HuaweiRouter(`TB${++serie}`));
    expect(refus, refus.join('\n')).toEqual([]);
  });

  it('rend le meme texte apres rejeu', async () => {
    const { conf } = await labo();
    const cible = new HuaweiRouter(`TC${++serie}`);
    await rejouer(conf, cible);
    const apres = await cible.executeCommand('display current-configuration');
    const sansNom = (t: string) => t.replace(/^sysname .*$/m, 'sysname X');
    expect(sansNom(apres)).toBe(sansNom(conf));
  });

  it('est stable : deux rendus de suite donnent le meme texte', async () => {
    const { conf, source } = await labo();
    expect(await source.executeCommand('display current-configuration')).toBe(conf);
  });
});

describe('la structure en blocs, qui est ce qui rend le rejeu possible', () => {
  it('une ligne de premier niveau ne suit jamais une ligne indentee sans `#`', async () => {
    const { conf } = await labo();
    const lignes = conf.split('\n');
    for (let i = 1; i < lignes.length; i++) {
      const courante = lignes[i];
      const precedente = lignes[i - 1];
      const premierNiveau = courante.length > 0 && !/^\s/.test(courante) && courante !== '#';
      if (premierNiveau && /^\s/.test(precedente)) {
        throw new Error(`ligne ${i} « ${courante} » suit « ${precedente} » sans separateur`);
      }
    }
  });

  it('`ip route-static` et `aaa` sortent de leur bloc precedent', async () => {
    const { conf } = await labo();
    const lignes = conf.split('\n');
    for (const tete of ['ip route-static 172.16.0.0 255.255.0.0 10.0.12.2 preference 100', 'aaa']) {
      const i = lignes.indexOf(tete);
      expect(i, tete).toBeGreaterThan(0);
      expect(lignes[i - 1], tete).toBe('#');
    }
  });

  it('aucun `#` n\'est double', async () => {
    const { conf } = await labo();
    expect(conf).not.toContain('#\n#');
  });
});

describe('ce que l\'operateur a ecrit revient tel quel', () => {
  it('le numero de regle d\'une ACL est le sien', async () => {
    const { conf } = await labo();
    expect(conf).toContain(' rule 15 permit source 10.0.0.0 0.255.255.255');
    expect(conf).toContain(' rule 25 deny source 192.168.1.0 0.0.0.255');
  });

  it('un numero que la machine attribue elle-meme reste le sien', async () => {
    const r = new HuaweiRouter(`TD${++serie}`);
    await run(r, ['system-view', 'acl number 2001',
      'rule permit source 192.168.0.0 0.0.0.255',
      'rule deny source 10.0.0.0 0.0.0.255', 'quit']);
    const vue = await r.executeCommand('display acl 2001');
    expect(vue).toContain('rule 0');
    expect(vue).toContain('rule 5');
  });

  it('`undo summary` et le `service-type` sont rendus', async () => {
    const { conf } = await labo();
    expect(conf).toContain(' undo summary');
    expect(conf).toContain(' local-user zoe service-type telnet');
  });

  it('la version de RIP est celle qui a ete posee', async () => {
    for (const v of ['1', '2']) {
      const r = new HuaweiRouter(`TV${++serie}`);
      await run(r, ['system-view', 'rip 1', `version ${v}`, 'network 10.0.0.0', 'quit']);
      expect(await r.executeCommand('display current-configuration'), `version ${v}`)
        .toContain(` version ${v}`);
    }
  });
});

describe('un compte survit au rejeu, mot de passe compris', () => {
  it('la configuration ne porte jamais le clair', async () => {
    const { conf } = await labo();
    expect(conf).not.toContain('Huawei@123');
    expect(conf).toMatch(/local-user zoe password irreversible-cipher \S+/);
  });

  it('le compte rejoue s\'ouvre avec le mot de passe d\'origine', async () => {
    const { conf } = await labo();
    const cible = new HuaweiRouter(`TE${++serie}`);
    await rejouer(conf, cible);

    const compte = cible.getCredentialStore().get('zoe');
    expect(compte, 'le compte doit exister apres rejeu').toBeTruthy();
    expect(compte!.authenticate('Huawei@123')).toBe(true);
    expect(compte!.authenticate('mauvais')).toBe(false);
  });

  it('l\'empreinte est la meme des deux cotes', async () => {
    const { conf, source } = await labo();
    const cible = new HuaweiRouter(`TF${++serie}`);
    await rejouer(conf, cible);
    expect(cible.getCredentialStore().get('zoe')?.secret)
      .toBe(source.getCredentialStore().get('zoe')?.secret);
  });

  it('le compte pose en clair s\'ouvre toujours', async () => {
    const r = new HuaweiRouter(`TG${++serie}`);
    await run(r, ['system-view', 'aaa',
      'local-user paul password irreversible-cipher Motdepasse1', 'quit']);
    expect(r.getCredentialStore().get('paul')?.authenticate('Motdepasse1')).toBe(true);
  });
});
