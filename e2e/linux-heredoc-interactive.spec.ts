import { expect, test } from '@playwright/test';
import { waitForStore, addDevice, openTerminal, typeCmd, modalText, waitForText } from './helpers/ciscoBangLab';

/**
 * PRD-Bash-Heredoc — l'expérience interactive, dans le vrai terminal de
 * l'UI : le prompt PS2, l'abandon par Ctrl+C, la fin par Ctrl+D avec
 * l'avertissement bash, la tabulation littérale dans le corps, et deux
 * heredocs ouverts sur la même ligne.
 *
 * Ces cas ne sont pas testables au niveau moteur : ils vivent tous dans la
 * boucle clavier de la session terminal.
 */

const prompt = '[data-testid="terminal-modal"] input[type="text"]';

/** Le texte du prompt affiché à gauche de la ligne de saisie. */
async function promptText(page: import('@playwright/test').Page): Promise<string> {
  const text = await modalText(page);
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  return lines[lines.length - 1] ?? '';
}

test.describe('heredoc interactif (e2e)', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/', { timeout: 45_000 });
    await waitForStore(page);
    const id = await addDevice(page, 'linux-pc');
    await openTerminal(page, id);
  });

  test('Ctrl+C abandonne le heredoc et rend un prompt normal', async ({ page }) => {
    await typeCmd(page, 'cat <<EOF');
    await typeCmd(page, 'alpha');
    expect(await promptText(page), 'le corps du heredoc est saisi au prompt PS2').toContain('>');

    await page.locator(prompt).last().press('Control+c');
    await page.waitForTimeout(300);
    await waitForText(page, '^C');

    await typeCmd(page, 'echo apres-annulation', 500);
    const after = (await modalText(page)).split('^C')[1] ?? '';
    expect(after).toContain('apres-annulation');
    expect(
      after,
      'le corps abandonné ne doit pas ressurgir accroché à la commande suivante',
    ).not.toContain('alpha');
  });

  test('Ctrl+D termine le heredoc avec l avertissement bash, sans fermer le terminal', async ({ page }) => {
    await typeCmd(page, 'cat <<EOF');
    await typeCmd(page, 'ligne-conservee');

    await page.locator(prompt).last().fill('');
    await page.locator(prompt).last().press('Control+d');
    await page.waitForTimeout(500);

    await waitForText(page, /bash: warning: here-document at line \d+ delimited by end-of-file \(wanted `EOF'\)/);
    await waitForText(page, 'ligne-conservee');
    await expect(
      page.locator('[data-testid="terminal-modal"]'),
      'le terminal reste ouvert — Ctrl+D dans un heredoc ne déconnecte pas',
    ).toBeVisible();

    await typeCmd(page, 'echo toujours-la', 500);
    await waitForText(page, 'toujours-la');
  });

  test('Tab insère une tabulation dans le corps au lieu de compléter', async ({ page }) => {
    await typeCmd(page, 'cat <<EOF');
    const input = page.locator(prompt).last();
    await input.click();
    await input.fill('ec');
    await input.press('Tab');
    await page.waitForTimeout(300);

    expect(
      await input.inputValue(),
      'aucune complétion ne doit se déclencher dans un corps de heredoc',
    ).toBe('ec\t');
  });

  test('deux heredocs sur une ligne attendent A puis B', async ({ page }) => {
    await typeCmd(page, 'cat <<A <<B');
    expect(await promptText(page)).toContain('>');
    await typeCmd(page, 'corps-a');
    await typeCmd(page, 'A');
    expect(
      await promptText(page),
      'fermer A laisse B ouvert — la commande n est pas complète',
    ).toContain('>');
    await typeCmd(page, 'corps-b');
    await typeCmd(page, 'B', 500);
    expect(await promptText(page)).not.toContain('>');
  });

  test('un heredoc complet reste une seule entrée d historique', async ({ page }) => {
    await typeCmd(page, 'cat <<EOF');
    await typeCmd(page, 'une-ligne');
    await typeCmd(page, 'EOF', 500);
    await waitForText(page, 'une-ligne');

    const input = page.locator(prompt).last();
    await input.click();
    await input.press('ArrowUp');
    await page.waitForTimeout(200);
    expect(
      await input.inputValue(),
      'la flèche haut rappelle le bloc entier, pas seulement sa dernière ligne',
    ).toContain('cat <<EOF');
  });
});
