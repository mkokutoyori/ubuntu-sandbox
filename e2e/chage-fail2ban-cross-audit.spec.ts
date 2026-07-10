import { test, expect, type Page } from '@playwright/test';

async function waitForStore(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__networkStore, { timeout: 15_000 });
}

async function openTerminal(page: Page, id: string): Promise<void> {
  await page.locator(`[data-device-id="${id}"]`).first().dblclick({ timeout: 8_000 });
  await page.locator('[data-testid="terminal-modal"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
}

async function typeCmd(page: Page, command: string): Promise<void> {
  const input = page.locator('[data-testid="terminal-modal"] input[type="text"]').last();
  await input.click();
  await input.fill(command);
  await input.press('Enter');
  await page.waitForTimeout(250);
}

async function modalText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-modal"]').innerText()).trim();
}

async function waitForText(page: Page, needle: string, timeout = 8_000): Promise<void> {
  await expect.poll(async () => (await modalText(page)).includes(needle), { timeout }).toBe(true);
}

const AUDIT_SCRIPT = `
WINDOW=300
for user in $(awk -F: '$3 >= 1000 {print $1}' /etc/passwd); do
  maxdays=$(chage -l "$user" | grep "Maximum number" | awk -F: '{print $2}' | tr -d ' ')
  ips=$(grep "Accepted.*for $user from" /var/log/auth.log | grep -oP 'from \\K[0-9.]+' | sort -u)
  ipcount=$(echo "$ips" | grep -c .)

  compromised=0
  prev_ip=""
  prev_ts=""
  matches=$(grep "Accepted.*for $user from" /var/log/auth.log)
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    ts=$(date -d "$(echo "$line" | awk '{print $1, $2, $3}')" +%s)
    ip=$(echo "$line" | grep -oP 'from \\K[0-9.]+')
    if [ -n "$prev_ip" ] && [ "$ip" != "$prev_ip" ]; then
      diff=$((ts - prev_ts))
      if [ "$diff" -lt 0 ]; then diff=$((-diff)); fi
      if [ "$diff" -lt "$WINDOW" ]; then compromised=1; fi
    fi
    prev_ip="$ip"
    prev_ts="$ts"
  done <<< "$matches"

  flag="OK"
  if [ "$compromised" -eq 1 ]; then flag="COMPROMISED"; fi

  echo "USER=$user MAXDAYS=$maxdays IPCOUNT=$ipcount FLAG=$flag"
done
`;

interface Lab {
  server: string;
  ipA1: string;
  ipA2: string;
}

async function buildLab(page: Page): Promise<Lab> {
  return page.evaluate(({ script }) => {
    type S = {
      addDevice(t: string, x: number, y: number): { id: string };
      deviceInstances: Map<string, Record<string, unknown>>;
      addConnection(a: string, ai: string, b: string, bi: string, t?: string): unknown;
    };
    const store = (window as Record<string, unknown>).__networkStore as { getState(): S };
    const sw = store.getState().addDevice('switch-generic', 400, 400);
    const server = store.getState().addDevice('linux-server', 600, 250);
    const ipA1 = store.getState().addDevice('linux-pc', 200, 150);
    const ipA2 = store.getState().addDevice('linux-pc', 200, 350);
    store.getState().addConnection(server.id, 'eth0', sw.id, 'eth0', 'ethernet');
    store.getState().addConnection(ipA1.id, 'eth0', sw.id, 'eth1', 'ethernet');
    store.getState().addConnection(ipA2.id, 'eth0', sw.id, 'eth2', 'ethernet');

    const serverDev = store.getState().deviceInstances.get(server.id) as Record<string, unknown>;
    const ipA1Dev = store.getState().deviceInstances.get(ipA1.id) as Record<string, unknown>;
    const ipA2Dev = store.getState().deviceInstances.get(ipA2.id) as Record<string, unknown>;
    const serverExec = serverDev.executeCommand as (c: string) => Promise<string>;
    const ipA1Exec = ipA1Dev.executeCommand as (c: string) => Promise<string>;
    const ipA2Exec = ipA2Dev.executeCommand as (c: string) => Promise<string>;

    return Promise.resolve()
      .then(() => serverExec.call(serverDev, 'ip addr add 10.0.0.2/24 dev eth0'))
      .then(() => ipA1Exec.call(ipA1Dev, 'ip addr add 10.0.0.30/24 dev eth0'))
      .then(() => ipA2Exec.call(ipA2Dev, 'ip addr add 10.0.0.31/24 dev eth0'))
      .then(() => serverExec.call(serverDev, "useradd -m alice; echo 'alice:wonderland' | chpasswd"))
      .then(() => serverExec.call(serverDev, 'chage -M 90 -W 14 -I 30 alice'))
      .then(() => ipA1Exec.call(ipA1Dev, 'sshpass -p wonderland ssh alice@10.0.0.2 whoami'))
      .then(() => ipA2Exec.call(ipA2Dev, 'sshpass -p wonderland ssh alice@10.0.0.2 whoami'))
      .then(() => serverExec.call(serverDev, `cat > /root/audit.sh <<'SCRIPTEOF'\n${script}\nSCRIPTEOF`))
      .then(() => ({ server: server.id, ipA1: ipA1.id, ipA2: ipA2.id }));
  }, { script: AUDIT_SCRIPT });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForStore(page);
});

test.describe('Scénario 4 — audit croisé chage + Fail2ban (UI réelle)', () => {
  test('le script d\'audit signale le compte alice comme compromis après connexions depuis deux IPs', async ({ page }) => {
    const { server } = await buildLab(page);

    await openTerminal(page, server);
    await typeCmd(page, 'bash /root/audit.sh');
    await waitForText(page, 'FLAG=COMPROMISED');

    const text = await modalText(page);
    expect(text).toMatch(/USER=alice MAXDAYS=90 IPCOUNT=2 FLAG=COMPROMISED/);
  });
});
