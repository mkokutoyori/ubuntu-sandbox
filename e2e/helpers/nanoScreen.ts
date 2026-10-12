import type { Page } from '@playwright/test';

export async function nanoRows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const edit = document.querySelector('[data-testid="nano-edit"]');
    return edit ? Array.from(edit.children).map((row) => (row.textContent ?? '').replace(/\s+$/, '')) : [];
  });
}

export async function nanoText(page: Page): Promise<string> {
  const rows = await nanoRows(page);
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows.join('\n');
}

export async function nanoCursor(page: Page): Promise<{ row: number; column: number }> {
  return page.evaluate(() => {
    const body = document.querySelector('[data-testid="nano-body"]');
    if (!body) return { row: -1, column: -1 };
    let row = 0;
    for (const section of Array.from(body.children)) {
      for (const line of Array.from(section.children)) {
        let column = 0;
        for (const span of Array.from(line.children) as HTMLElement[]) {
          if (span.getAttribute('data-testid') === 'nano-cursor') return { row, column };
          column += span.style.width === '2ch' ? 2 : (span.textContent ?? '').length;
        }
        row++;
      }
    }
    return { row: -1, column: -1 };
  });
}

export async function nanoPromptAnswer(page: Page, label: string): Promise<string> {
  const status = (await page.locator('[data-testid="nano-status-message"]').textContent()) ?? '';
  const at = status.indexOf(label);
  return at < 0 ? '' : status.slice(at + label.length).replace(/\s+$/, '').replace(/^ /, '');
}

export async function nanoHighlighted(page: Page): Promise<string> {
  return page.evaluate(() => {
    const edit = document.querySelector('[data-testid="nano-edit"]');
    if (!edit) return '';
    const reverse = 'rgb(211, 215, 207)';
    return (Array.from(edit.querySelectorAll('span')) as HTMLElement[])
      .filter((span) => span.style.backgroundColor === reverse || span.getAttribute('data-testid') === 'nano-cursor')
      .map((span) => span.textContent ?? '')
      .join('');
  });
}
