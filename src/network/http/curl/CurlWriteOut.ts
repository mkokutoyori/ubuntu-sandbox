export interface WriteOutFacts {
  readonly httpCode: number;
  readonly urlEffective: string;
  readonly remoteIp: string;
  readonly remotePort: number;
  readonly sizeDownload: number;
  readonly sizeUpload: number;
  readonly contentType: string;
  readonly numRedirects: number;
  readonly timeTotal: number;
  readonly method: string;
  readonly scheme: string;
  readonly httpVersion: string;
  readonly exitCode: number;
  readonly errorMsg: string;
  readonly numHeaders: number;
}

export interface WriteOutResult {
  readonly text: string;
  readonly warnings: readonly string[];
}

function seconds(value: number): string {
  return value.toFixed(6);
}

function variableValue(name: string, facts: WriteOutFacts): string | null {
  switch (name) {
    case 'http_code':
    case 'response_code': return String(facts.httpCode);
    case 'url_effective': return facts.urlEffective;
    case 'remote_ip': return facts.remoteIp;
    case 'remote_port': return String(facts.remotePort);
    case 'size_download': return String(facts.sizeDownload);
    case 'size_upload': return String(facts.sizeUpload);
    case 'content_type': return facts.contentType;
    case 'num_redirects': return String(facts.numRedirects);
    case 'num_headers': return String(facts.numHeaders);
    case 'method': return facts.method;
    case 'scheme': return facts.scheme;
    case 'http_version': return facts.httpVersion;
    case 'exitcode': return String(facts.exitCode);
    case 'errormsg': return facts.errorMsg;
    case 'time_total': return seconds(facts.timeTotal);
    default: return null;
  }
}

export function applyWriteOut(format: string, facts: WriteOutFacts): WriteOutResult {
  const warnings: string[] = [];
  let out = '';

  for (let i = 0; i < format.length; i++) {
    const ch = format[i];

    if (ch === '\\' && i + 1 < format.length) {
      const next = format[++i];
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'r') out += '\r';
      else if (next === '\\') out += '\\';
      else out += next;
      continue;
    }

    if (ch === '%' && format[i + 1] === '%') { out += '%'; i++; continue; }

    if (ch === '%' && format[i + 1] === '{') {
      const end = format.indexOf('}', i + 2);
      if (end === -1) { out += ch; continue; }
      const name = format.slice(i + 2, end);
      i = end;
      const value = variableValue(name, facts);
      if (value === null) warnings.push(`curl: unknown --write-out variable: '${name}'`);
      else out += value;
      continue;
    }

    out += ch;
  }

  return { text: out, warnings };
}
