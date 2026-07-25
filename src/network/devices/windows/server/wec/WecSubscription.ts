/**
 * Windows Event Collector subscription (PRD-Wecutil.md §2.1 P3) — the
 * fixed-shape XML document `wecutil cs` consumes
 * (`http://schemas.microsoft.com/2006/03/windows/events/subscription`).
 *
 * The parser below is a small regex-based tag extractor scoped strictly
 * to this schema, in the same spirit as the PowerShell `[xml]` cast's
 * own regex-recursive parser (`src/powershell/runtime/PSRuntime.ts`) —
 * not a general-purpose XML/DOM parser, which this document doesn't need.
 */

export interface WecSubscriptionQuery {
  logName: string;
  /** Extracted from every `EventID=<n>` equality/`or` clause inside the
   *  `<Select>` XPath (PRD-Wecutil.md §2.2 — a full XPath evaluator is
   *  out of scope; more complex predicates are ignored rather than
   *  rejected). */
  eventIds: number[];
}

export type WecSubscriptionType = 'SourceInitiated' | 'CollectorInitiated';

export interface WecSubscription {
  subscriptionId: string;
  subscriptionType: WecSubscriptionType;
  description: string;
  enabled: boolean;
  configurationMode: string;
  query: WecSubscriptionQuery;
  readExistingEvents: boolean;
  transportName: string;
  contentFormat: string;
  logFile: string;
}

export type ParseSubscriptionResult =
  | { ok: true; subscription: WecSubscription }
  | { ok: false; error: string };

function tagContent(xml: string, name: string): string | null {
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i');
  const m = re.exec(xml);
  if (!m) return null;
  let content = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(content);
  if (cdata) content = cdata[1].trim();
  return content;
}

export function parseSubscriptionXml(xml: string): ParseSubscriptionResult {
  if (!/<Subscription[\s>]/i.test(xml)) {
    return { ok: false, error: 'The specified XML is not a valid subscription document (missing a <Subscription> root element).' };
  }
  const subscriptionId = tagContent(xml, 'SubscriptionId');
  if (!subscriptionId) {
    return { ok: false, error: 'The specified XML is not a valid subscription document (missing <SubscriptionId>).' };
  }
  const subscriptionType = (tagContent(xml, 'SubscriptionType') as WecSubscriptionType | null) ?? 'SourceInitiated';
  const description = tagContent(xml, 'Description') ?? '';
  const enabled = (tagContent(xml, 'Enabled') ?? 'true').toLowerCase() === 'true';
  const configurationMode = tagContent(xml, 'ConfigurationMode') ?? 'Normal';
  const queryRaw = tagContent(xml, 'Query') ?? '';
  const pathMatch = /Path="([^"]+)"/.exec(queryRaw);
  const eventIds = Array.from(queryRaw.matchAll(/EventID\s*=\s*(\d+)/g)).map(m => Number(m[1]));
  const readExistingEvents = (tagContent(xml, 'ReadExistingEvents') ?? 'false').toLowerCase() === 'true';
  const transportName = tagContent(xml, 'TransportName') ?? 'HTTP';
  const contentFormat = tagContent(xml, 'ContentFormat') ?? 'RenderedText';
  const logFile = tagContent(xml, 'LogFile') ?? 'ForwardedEvents';

  return {
    ok: true,
    subscription: {
      subscriptionId, subscriptionType, description, enabled, configurationMode,
      query: { logName: pathMatch?.[1] ?? '', eventIds },
      readExistingEvents, transportName, contentFormat, logFile,
    },
  };
}
