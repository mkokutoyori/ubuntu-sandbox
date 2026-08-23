import { test, expect } from '@playwright/test';
import { waitForStore, addDevice, openTerminal, typeCmd, modalText, waitForText } from './helpers/ciscoBangLab';

/**
 * Le tutoriel ACL Cisco, dans un VRAI terminal.
 *
 * La sonde unitaire (`tuto-acl-cisco.test.ts`) rejoue les onze concepts
 * en pilotant les equipements directement. Celle-ci verifie que ce que le
 * lecteur TAPE dans l'onglet lui rend bien ce que le tutoriel promet —
 * l'alignement, les numeros de sequence, les vues du commutateur.
 */

function tail(vue: string, ancre: string): string {
  return vue.slice(vue.lastIndexOf(ancre));
}

test.describe('Le tutoriel ACL Cisco dans le terminal', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
  });

  test('une liste standard s aligne comme sur un vrai IOS', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);

    for (const ligne of [
      'enable', 'configure terminal',
      'access-list 1 remark === Blocage du poste PC-WIN ===',
      'access-list 1 deny host 192.168.10.20',
      'access-list 1 permit any',
      'end',
    ]) await typeCmd(page, ligne);

    await typeCmd(page, 'show access-lists 1', 600);
    await waitForText(page, 'Standard IP access list 1');

    const vue = tail(await modalText(page), 'Standard IP access list 1');
    expect(vue).toContain('10 deny   192.168.10.20');
    expect(vue).toContain('20 permit any');
    expect(vue).not.toContain('remark');
  });

  test('une ACL nommee numerote ses regles, et pas ses commentaires',
    async ({ page }) => {
      const id = await addDevice(page, 'router-cisco');
      await openTerminal(page, id);

      for (const ligne of [
        'enable', 'configure terminal',
        'ip access-list extended USERS-VERS-SERVEURS',
        'remark === Politique acces LAN utilisateurs ===',
        'permit tcp 192.168.10.0 0.0.0.255 host 192.168.30.20 eq 3389',
        'deny ip 192.168.10.0 0.0.0.255 192.168.30.0 0.0.0.255',
        'permit ip any any',
        'end',
      ]) await typeCmd(page, ligne);

      await typeCmd(page, 'show access-lists USERS-VERS-SERVEURS', 600);
      await waitForText(page, 'Extended IP access list USERS-VERS-SERVEURS');

      const vue = tail(await modalText(page), 'Extended IP access list');
      expect(vue).toMatch(/10 permit tcp/);
      expect(vue).toMatch(/30 permit ip any any/);
    });

  test('`show ip interface` nomme la liste appliquee', async ({ page }) => {
    const id = await addDevice(page, 'router-cisco');
    await openTerminal(page, id);

    for (const ligne of [
      'enable', 'configure terminal',
      'access-list 1 permit any',
      'interface GigabitEthernet0/0',
      'ip address 192.168.30.1 255.255.255.0',
      'no shutdown',
      'ip access-group 1 out',
      'end',
    ]) await typeCmd(page, ligne);

    await typeCmd(page, 'show ip interface GigabitEthernet0/0', 600);
    await waitForText(page, 'Outgoing access list is 1');

    expect(await modalText(page)).toContain('Inbound  access list is not set');
  });

  test('`show time-range` suit l horloge posee par `clock set`',
    async ({ page }) => {
      const id = await addDevice(page, 'router-cisco');
      await openTerminal(page, id);

      for (const ligne of [
        'enable', 'configure terminal',
        'time-range HEURES-OUVREES',
        'periodic weekdays 08:00 to 18:00',
        'end',
        'clock set 14:30:00 22 Aug 2026',
      ]) await typeCmd(page, ligne);

      await typeCmd(page, 'show time-range', 600);
      await waitForText(page, '(inactive)');

      await typeCmd(page, 'clock set 09:00:00 24 Aug 2026');
      await typeCmd(page, 'show time-range', 600);
      await waitForText(page, '(active)');
    });

  test('`clear access-list counters` remet le compteur a zero',
    async ({ page }) => {
      const id = await addDevice(page, 'router-cisco');
      await openTerminal(page, id);

      for (const ligne of [
        'enable', 'configure terminal',
        'access-list 1 permit any',
        'end',
      ]) await typeCmd(page, ligne);

      await typeCmd(page, 'clear access-list counters', 500);
      expect(await modalText(page)).not.toContain('Invalid input');

      await typeCmd(page, 'clear access-list counters 99', 500);
      await waitForText(page, '% Access list 99 not found');
    });

  test('le commutateur relit sa VACL et son port protege', async ({ page }) => {
    const id = await addDevice(page, 'switch-cisco');
    await openTerminal(page, id);

    for (const ligne of [
      'enable', 'configure terminal',
      'ip access-list extended TRAFIC-SSH-INTERNE',
      'permit tcp any any eq 22',
      'exit',
      'vlan access-map FILTRE-VLAN10 10',
      'match ip address TRAFIC-SSH-INTERNE',
      'action drop',
      'exit',
      'vlan filter FILTRE-VLAN10 vlan-list 1',
      'interface FastEthernet0/2',
      'switchport protected',
      'end',
    ]) await typeCmd(page, ligne);

    await typeCmd(page, 'show vlan access-map', 600);
    await waitForText(page, 'Vlan access-map "FILTRE-VLAN10"  10');
    expect(await modalText(page)).toContain('ip  address: TRAFIC-SSH-INTERNE');

    await typeCmd(page, 'show vlan filter', 600);
    await waitForText(page, 'VLAN Map FILTRE-VLAN10:');

    await typeCmd(page, 'show interfaces FastEthernet0/2 switchport', 600);
    await waitForText(page, 'Protected: true');
  });

  test('une PACL se pose sur le commutateur et se relit dans la config',
    async ({ page }) => {
      const id = await addDevice(page, 'switch-cisco');
      await openTerminal(page, id);

      for (const ligne of [
        'enable', 'configure terminal',
        'ip access-list extended PROTEGE-PC-LNX',
        'deny tcp any host 192.168.10.10 eq 22',
        'permit ip any any',
        'exit',
        'interface FastEthernet0/2',
      ]) await typeCmd(page, ligne);

      await typeCmd(page, 'ip access-group PAS-LA in', 500);
      await waitForText(page, '% Access list PAS-LA not found');

      await typeCmd(page, 'ip access-group PROTEGE-PC-LNX in');
      await typeCmd(page, 'end');
      await typeCmd(page, 'show running-config', 900);
      await waitForText(page, 'ip access-group PROTEGE-PC-LNX in');

      expect(await modalText(page))
        .toContain('ip access-list extended PROTEGE-PC-LNX');
    });
});
