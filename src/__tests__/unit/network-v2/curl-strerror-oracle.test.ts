/*
 * Probe - curl_easy_strerror, the text impstats' push logs after "HTTP request failed:".  The fixture (support/oracle/curl/libcurl-strerror.json) holds what the
 * installed libcurl 8.5.0 answers for every CURLcode from 0 to 109 and for an unknown code; the table must give the same text for each.
 * Measured before the table existed (git stash push -- src/network): the module is untracked-new, so both cases fail at import.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { curlStrerror } from '@/network/http/curl/CurlStrerror';

const recorded: { messages: Record<string, string> } = JSON.parse(readFileSync(new URL('../../support/oracle/curl/libcurl-strerror.json', import.meta.url), 'utf8'));

describe('curlStrerror against libcurl', () => {
  it('gives the text libcurl gives for every code', () => {
    const different = Object.entries(recorded.messages).filter(([code]) => code !== 'unknown').filter(([code, text]) => curlStrerror(Number(code)) !== text).map(([code]) => code);
    expect(different).toEqual([]);
  });

  it('gives the unknown-error text for a code libcurl does not define', () => {
    expect(curlStrerror(999)).toBe(recorded.messages.unknown);
    expect(curlStrerror(7)).toBe("Couldn't connect to server");
  });
});
