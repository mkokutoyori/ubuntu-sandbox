/**
 * Le tutoriel « Gestion des Accès, Identité et Privilèges sur Cisco »,
 * rejoué comme laboratoire.
 *
 * Ce que la mesure a trouvé avant qu'une ligne soit écrite. Le fil
 * commun des cinq défauts est le même : **une commande acceptée dont
 * personne ne lit le résultat**, ou **deux magasins pour un fait**.
 *
 * 1. **Deux configurations SSH sur une machine.** `ip ssh time-out 45`
 *    était accepté, gardé, rendu par `show running-config` — et NIÉ par
 *    `show ip ssh`, qui annonçait 120 sur la même machine au même
 *    instant. La cause : `show ip ssh` ne prenait aucun argument et
 *    rendait deux lignes constantes, et il existait un SECOND magasin
 *    (celui du gestionnaire) que le handler du routeur n'écrit jamais,
 *    avec des défauts contradictoires — version 1 contre 2, délai 120
 *    contre 60 — et son propre rendu vers le running-config, capable
 *    d'émettre la même directive deux fois dans un même fichier.
 *
 * 2. **`ip ssh server algorithm …`** était accepté et rangé nulle part :
 *    la commande de durcissement disparaissait de la configuration, donc
 *    du rechargement d'une topologie, sans que rien ne le dise.
 *
 * 3. **`username X algorithm-type scrypt secret …`** était accepté et le
 *    mot-clé JETÉ : le secret partait en MD5. La commande produisait
 *    exactement l'inverse de ce qu'elle promet, en silence — alors que
 *    son homologue `enable algorithm-type` fonctionne depuis toujours.
 *
 * 4. **`show aaa`, `show aaa sessions` et `show aaa user all`** rendaient
 *    un seul et même texte : deux des trois ne répondaient pas à la
 *    question posée.
 *
 * 5. **`login-timeout`** était refusé.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

async function ios(r: CiscoRouter, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = String(await r.executeCommand(c));
  return last;
}

/**
 * Rend TOUT ce que la séquence a écrit, pas seulement la dernière
 * ligne : un refus se produit au milieu d'un bloc de configuration, et
 * ne garder que la sortie de `end` le rendait invisible — ce qui a fait
 * échouer la première version de quatre de ces cas.
 */
async function config(r: CiscoRouter, cmds: string[]): Promise<string> {
  const sorties: string[] = [];
  for (const c of ['enable', 'configure terminal', ...cmds, 'end']) {
    sorties.push(String(await r.executeCommand(c)));
  }
  return sorties.join('\n');
}

/** La ligne de `show running-config` qui commence par ce préfixe. */
async function ligneConfig(r: CiscoRouter, prefixe: string): Promise<string | undefined> {
  const cfg = await ios(r, ['show running-config']);
  return cfg.split('\n').map((l) => l.trim()).find((l) => l.startsWith(prefixe));
}

// ── §12 — SSH durci ──────────────────────────────────────────────────

describe('§12 : SSH durci — une seule configuration, deux vues d\'accord', () => {
  it('`show ip ssh` lit ce que l\'opérateur a configuré', async () => {
    const r = new CiscoRouter('R1');
    await config(r, [
      'ip domain-name ma-banque.local',
      'crypto key generate rsa modulus 2048',
      'ip ssh version 2',
      'ip ssh time-out 45',
      'ip ssh authentication-retries 2',
    ]);
    const vue = await ios(r, ['show ip ssh']);
    expect(vue).toContain('SSH Enabled - version 2.0');
    expect(vue).toContain('Authentication timeout: 45 secs; Authentication retries: 2');
    expect(vue).toContain('Hostkey RSA key size is 2048 bits');
  });

  /**
   * `version 1` est le défaut d'IOS et signifie « les deux versions
   * acceptées », ce qu'IOS écrit `1.99`. Ce n'est pas une coquetterie :
   * c'est ainsi qu'un opérateur voit que `ip ssh version 2` manque.
   */
  it('sans configuration, la version annoncée est 1.99, pas 2.0', async () => {
    const r = new CiscoRouter('R1');
    expect(await ios(r, ['show ip ssh'])).toContain('SSH Enabled - version 1.99');
  });

  it('la taille de clé n\'est annoncée que s\'il y a une clé', async () => {
    const r = new CiscoRouter('R1');
    expect(await ios(r, ['show ip ssh'])).not.toContain('Hostkey RSA key size');
  });

  it('`ip ssh dh min size` est lu par la même vue', async () => {
    const r = new CiscoRouter('R1');
    await config(r, ['ip ssh dh min size 2048']);
    expect(await ios(r, ['show ip ssh']))
      .toContain('Minimum expected Diffie Hellman key size : 2048 bits');
  });

  it('les listes d\'algorithmes se relisent comme elles ont été écrites', async () => {
    const r = new CiscoRouter('R1');
    await config(r, [
      'ip ssh server algorithm mac hmac-sha2-256 hmac-sha2-512',
      'ip ssh server algorithm encryption aes256-ctr aes192-ctr aes128-ctr',
      'ip ssh server algorithm kex diffie-hellman-group14-sha1',
    ]);
    const cfg = await ios(r, ['show running-config']);
    expect(cfg).toContain('ip ssh server algorithm mac hmac-sha2-256 hmac-sha2-512');
    expect(cfg).toContain('ip ssh server algorithm encryption aes256-ctr aes192-ctr aes128-ctr');
    expect(cfg).toContain('ip ssh server algorithm kex diffie-hellman-group14-sha1');

    const vue = await ios(r, ['show ip ssh']);
    expect(vue).toContain('MAC Algorithms:hmac-sha2-256,hmac-sha2-512');
    expect(vue).toContain('KEX Algorithms:diffie-hellman-group14-sha1');
  });

  it('une famille d\'algorithmes inconnue est refusée, pas rangée', async () => {
    const r = new CiscoRouter('R1');
    expect(await config(r, ['ip ssh server algorithm bidon aes256-ctr']))
      .toContain('% Invalid input detected');
  });

  /**
   * Le second magasin pouvait faire émettre la même directive deux fois
   * dans un même fichier — une configuration qu'IOS ne produirait jamais
   * et qu'un import rejouerait deux fois.
   */
  it('la configuration ne contient qu\'UNE ligne par directive `ip ssh`', async () => {
    const r = new CiscoRouter('R1');
    await config(r, [
      'ip domain-name ma-banque.local', 'crypto key generate rsa modulus 2048',
      'ip ssh version 2', 'ip ssh time-out 45', 'ip ssh authentication-retries 2',
    ]);
    const cfg = await ios(r, ['show running-config']);
    for (const directive of ['ip ssh version', 'ip ssh time-out', 'ip ssh authentication-retries']) {
      const n = cfg.split('\n').filter((l) => l.trim().startsWith(directive)).length;
      expect(n, directive).toBe(1);
    }
  });
});

// ── §2 et §3 — mots de passe et comptes locaux ───────────────────────

describe('§2-§3 : les types de stockage des mots de passe', () => {
  it('`enable secret` produit un type 5, le défaut d\'IOS', async () => {
    const r = new CiscoRouter('R1');
    await config(r, ['enable secret MonMotDePasseComplexe2024!']);
    expect(await ligneConfig(r, 'enable secret')).toMatch(/^enable secret 5 \$1\$/);
  });

  it('`enable algorithm-type scrypt secret` produit un type 9', async () => {
    const r = new CiscoRouter('R1');
    await config(r, ['enable algorithm-type scrypt secret MonMotDePasse2024!']);
    expect(await ligneConfig(r, 'enable secret')).toMatch(/^enable secret 9 \$9\$/);
  });

  /**
   * Le défaut : le mot-clé était accepté et jeté, donc un secret demandé
   * en scrypt partait en MD5 — l'inverse de ce que la commande promet.
   */
  it('`username … algorithm-type sha256|scrypt` produit un type 8 ou 9', async () => {
    const r = new CiscoRouter('R1');
    await config(r, [
      'username u8 algorithm-type sha256 secret Sha@2024Long!',
      'username u9 algorithm-type scrypt secret Scr@2024Long!',
      'username u5 secret Md5ParDefaut2024',
    ]);
    expect(await ligneConfig(r, 'username u8')).toMatch(/secret 8 \$8\$/);
    expect(await ligneConfig(r, 'username u9')).toMatch(/secret 9 \$9\$/);
    // Sans le mot-clé, IOS hache en type 5 : le défaut ne change pas.
    expect(await ligneConfig(r, 'username u5')).toMatch(/secret 5 \$1\$/);
  });

  it('un chiffre explicite décrit un condensé déjà calculé et l\'emporte', async () => {
    const r = new CiscoRouter('R1');
    await config(r, ['username uX algorithm-type scrypt secret 5 $1$abc$deja']);
    expect(await ligneConfig(r, 'username uX')).toContain('secret 5 $1$abc$deja');
  });

  it('un algorithme inconnu est refusé, pas silencieusement ignoré', async () => {
    const r = new CiscoRouter('R1');
    expect(await config(r, ['username uY algorithm-type bidon secret Quelque@Chose1']))
      .toContain('% Invalid input detected');
  });

  it('`service password-encryption` transforme le type 0 en type 7', async () => {
    const r = new CiscoRouter('R1');
    await config(r, ['service password-encryption', 'enable password MonMotDePasse']);
    expect(await ligneConfig(r, 'enable password')).toMatch(/^enable password 7 /);
  });

  it('`security passwords min-length` refuse et le dit', async () => {
    const r = new CiscoRouter('R1');
    const refus = await config(r, [
      'security passwords min-length 12',
      'username court secret abc',
    ]);
    expect(refus).toContain('Password too short - must be at least 12 characters');
    expect(await ligneConfig(r, 'username court')).toBeUndefined();
  });
});

// ── §4 — niveaux de privilège ────────────────────────────────────────

describe('§4 : les niveaux de privilège', () => {
  it('`privilege exec level N <commande>` se configure et se relit', async () => {
    const r = new CiscoRouter('R1');
    await config(r, [
      'privilege exec level 5 show running-config',
      'privilege exec level 5 ping',
      'privilege exec level 15 configure',
    ]);
    const cfg = await ios(r, ['show running-config']);
    expect(cfg).toContain('privilege exec level 5 show running-config');
    expect(cfg).toContain('privilege exec level 5 ping');
    expect(cfg).toContain('privilege exec level 15 configure');
  });

  it('`enable secret level 5` cohabite avec le secret de niveau 15', async () => {
    const r = new CiscoRouter('R1');
    await config(r, [
      'enable secret MotDePasse15Complexe!',
      'enable secret level 5 NOCEnable2024!',
    ]);
    const cfg = await ios(r, ['show running-config']);
    expect(cfg).toMatch(/enable secret 5 \$1\$/);
    expect(cfg).toMatch(/enable secret level 5 5 \$1\$/);
  });

  it('`show privilege` rapporte le niveau courant', async () => {
    const r = new CiscoRouter('R1');
    await ios(r, ['enable']);
    expect(await ios(r, ['show privilege'])).toContain('Current privilege level is 15');
  });
});

// ── §6 et §7 — force brute et ACL VTY ────────────────────────────────

describe('§6-§7 : protection contre la force brute et filtrage VTY', () => {
  it('`login block-for … attempts … within …` est lu par `show login`', async () => {
    const r = new CiscoRouter('R1');
    await config(r, ['login block-for 120 attempts 3 within 30', 'login delay 3']);
    const vue = await ios(r, ['show login']);
    expect(vue).toContain('A login delay of 3 seconds is applied.');
    expect(vue).toContain('If more than 3 login failures occur in 30 seconds');
    expect(vue).toContain('logins will be disabled for 120 seconds');
  });

  it('`login quiet-mode access-class` est retenu et rapporté', async () => {
    const r = new CiscoRouter('R1');
    await config(r, [
      'ip access-list standard LOGIN_WHITELIST', 'permit 192.168.100.0 0.0.0.255', 'exit',
      'login block-for 120 attempts 3 within 30',
      'login quiet-mode access-class LOGIN_WHITELIST',
    ]);
    expect(await ios(r, ['show login']))
      .toContain('Quiet-Mode access list LOGIN_WHITELIST is applied.');
  });

  /** `login-timeout` compte la SAISIE ; `exec-timeout` compte l'inactivité. */
  it('`login-timeout` est accepté sur une ligne et se relit', async () => {
    const r = new CiscoRouter('R1');
    await config(r, ['line vty 0 4', 'exec-timeout 15 0', 'login-timeout 30']);
    const cfg = await ios(r, ['show running-config']);
    expect(cfg).toContain(' login-timeout 30');
    expect(cfg).toContain(' exec-timeout 15 0');
  });

  it('une valeur hors bornes de `login-timeout` est refusée', async () => {
    const r = new CiscoRouter('R1');
    expect(await config(r, ['line vty 0 4', 'login-timeout 999']))
      .toContain('% Invalid input detected');
  });

  it('`access-class … in` sur les VTY se configure et se relit', async () => {
    const r = new CiscoRouter('R1');
    await config(r, [
      'ip access-list standard SSH_ALLOWED', 'permit 192.168.100.0 0.0.0.255', 'exit',
      'line vty 0 4', 'access-class SSH_ALLOWED in', 'transport input ssh',
    ]);
    const cfg = await ios(r, ['show running-config']);
    expect(cfg).toContain(' access-class SSH_ALLOWED in');
    expect(cfg).toContain(' transport input ssh');
  });
});

// ── §8 et §9 — AAA et TACACS+ ────────────────────────────────────────

describe('§8-§9 : AAA et TACACS+', () => {
  /**
   * Les trois commandes rendaient un seul et même texte. `show aaa`
   * décrit l'ÉTAT DU SOUS-SYSTÈME ; `show aaa sessions` compte les
   * sessions. Ce sont deux questions.
   */
  it('`show aaa` décrit le sous-système, pas les sessions', async () => {
    const r = new CiscoRouter('R1');
    expect(await ios(r, ['show aaa'])).toBe('AAA is disabled.');

    await config(r, [
      'aaa new-model',
      'aaa authentication login default group tacacs+ local',
    ]);
    const vue = await ios(r, ['show aaa']);
    expect(vue).toContain('Global Authentication: enabled');
    // Rien n'est configuré pour ces deux-là : elles ne doivent pas
    // s'annoncer actives.
    expect(vue).toContain('Global Authorization: disabled');
    expect(vue).toContain('Global Accounting: disabled');
    expect(vue).not.toContain('Total sessions');

    await config(r, [
      'aaa authorization exec default local',
      'aaa accounting exec default start-stop group tacacs+',
    ]);
    const apres = await ios(r, ['show aaa']);
    expect(apres).toContain('Global Authorization: enabled');
    expect(apres).toContain('Global Accounting: enabled');
  });

  it('`show aaa sessions` répond bien à sa propre question', async () => {
    const r = new CiscoRouter('R1');
    await config(r, ['aaa new-model']);
    expect(await ios(r, ['show aaa sessions'])).toContain('Total sessions since last reload');
  });

  it('la séquence sûre du tutoriel se configure entièrement', async () => {
    const r = new CiscoRouter('R1');
    await config(r, [
      'username admin privilege 15 secret SecretAdmin2024!',
      'username emergency privilege 15 secret Emergency@2024!',
      'aaa new-model',
      'aaa authentication login default group tacacs+ local',
    ]);
    const cfg = await ios(r, ['show running-config']);
    expect(cfg).toContain('aaa new-model');
    expect(cfg).toContain('aaa authentication login default group tacacs+ local');
    // Le compte de secours existe AVANT que AAA ne prenne la main.
    expect(cfg).toMatch(/username emergency privilege 15 secret/);
  });

  it('un serveur TACACS+ nommé se déclare et se relit', async () => {
    const r = new CiscoRouter('R1');
    await config(r, [
      'tacacs server TACACS_PRIMAIRE',
      'address ipv4 192.168.100.10',
      'key SecretTACACS2024!',
      'timeout 5',
      'exit',
      'aaa group server tacacs+ GROUPE_TACACS',
      'server name TACACS_PRIMAIRE',
    ]);
    const cfg = await ios(r, ['show running-config']);
    expect(cfg).toContain('tacacs server TACACS_PRIMAIRE');
    expect(cfg).toContain('aaa group server tacacs+ GROUPE_TACACS');

    expect(await ios(r, ['show tacacs'])).toContain('192.168.100.10');
  });

  it('un profil d\'authentification nommé pour la console se configure', async () => {
    const r = new CiscoRouter('R1');
    await config(r, [
      'aaa new-model',
      'aaa authentication login CONSOLE_AUTH local',
      'line console 0', 'login authentication CONSOLE_AUTH',
    ]);
    expect(await ios(r, ['show running-config']))
      .toContain('aaa authentication login CONSOLE_AUTH local');
  });
});

// ── §5 — bannières ───────────────────────────────────────────────────

describe('§5 : les trois bannières', () => {
  it('les trois se configurent et se relisent', async () => {
    const r = new CiscoRouter('R1');
    await config(r, [
      'banner motd #ACCES RESTREINT ET SURVEILLE#',
      'banner login #Authentification requise.#',
      'banner exec #Contacter le NOC.#',
    ]);
    const cfg = await ios(r, ['show running-config']);
    for (const kind of ['motd', 'login', 'exec']) {
      expect(cfg, kind).toContain(`banner ${kind} `);
    }
    expect(cfg).toContain('ACCES RESTREINT ET SURVEILLE');
    expect(cfg).toContain('Authentification requise.');
  });
});
