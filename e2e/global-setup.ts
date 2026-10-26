import { chromium, type FullConfig } from '@playwright/test';

export default async function warmUpDevServer(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:8080';
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(baseURL, { timeout: 240_000, waitUntil: 'networkidle' });
  } finally {
    await browser.close();
  }
}
