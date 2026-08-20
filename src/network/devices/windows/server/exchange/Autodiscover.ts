export interface AutodiscoverResponse {
  readonly smtpAddress: string;
  readonly displayName: string;
  readonly mailboxServer: string;
  readonly protocol: 'Exchange';
}

export function parseAutodiscoverRequestXml(xml: string): string | null {
  const match = /<EMailAddress>\s*([^<]+?)\s*<\/EMailAddress>/.exec(xml);
  return match ? match[1] : null;
}

export function renderAutodiscoverSuccessXml(response: AutodiscoverResponse): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">',
    '  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">',
    '    <Account>',
    '      <AccountType>email</AccountType>',
    '      <Action>settings</Action>',
    '      <Protocol>',
    `        <Type>${response.protocol}</Type>`,
    `        <Server>${response.mailboxServer}</Server>`,
    `        <LoginName>${response.smtpAddress}</LoginName>`,
    `        <DisplayName>${response.displayName}</DisplayName>`,
    '      </Protocol>',
    '    </Account>',
    '  </Response>',
    '</Autodiscover>',
  ].join('\n');
}

export function renderAutodiscoverErrorXml(message: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">',
    '  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">',
    '    <Error Id="0">',
    '      <ErrorCode>500</ErrorCode>',
    `      <Message>${message}</Message>`,
    '    </Error>',
    '  </Response>',
    '</Autodiscover>',
  ].join('\n');
}
