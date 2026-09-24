/*
 * Probe — an option that needs a libcurl feature this curl does not
 * announce is refused the way curl refuses it.
 *
 * Before: `curl --compressed` (FortiGate battery 02, test 99) and
 * `--http2` / `--http2-prior-knowledge` / `--http3` answered "is not
 * implemented in this simulator" — words no real curl prints — while
 * `curl --version` announces `Features: IPv6 SSL`, i.e. neither libz,
 * brotli, zstd, HTTP2 nor HTTP3.
 *
 * Authority: curl 8.5.0 (curl/curl, tag curl-8_5_0), src/tool_getparam.c:
 * `--compressed` returns PARAM_LIBCURL_DOESNT_SUPPORT unless libz, brotli
 * or zstd is built in; `--http2` and `--http2-prior-knowledge` unless
 * HTTP2; `--http3` and `--http3-only` unless HTTP3. src/tool_helpers.c
 * words it "the installed libcurl version doesn't support this".
 *
 * Measured before the change (git stash of src/network/http/curl): 5 of the
 * 6 cases fail.
 * Passing either way:
 *   - "curl announces neither compression nor HTTP/2" is the WITNESS: the
 *     Features line these refusals must agree with.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

async function refusal(option: string): Promise<string> {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  pc.powerOn();
  return pc.executeCommand(`curl ${option} http://10.0.0.2/; echo EC=$?`);
}

describe('curl options gated on libcurl features', () => {
  it('curl announces neither compression nor HTTP/2', async () => {
    const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
    pc.powerOn();
    const features = (await pc.executeCommand('curl --version')).split('\n').find((l) => l.startsWith('Features:'));
    expect(features).toBe('Features: IPv6 SSL');
  });

  for (const option of ['--compressed', '--http2', '--http2-prior-knowledge', '--http3', '--http3-only']) {
    it(`${option} is refused in curl's words`, async () => {
      const out = await refusal(option);
      expect(out).toContain(`curl: option ${option}: the installed libcurl version doesn't support this`);
      expect(out).toContain('EC=2');
    });
  }
});
