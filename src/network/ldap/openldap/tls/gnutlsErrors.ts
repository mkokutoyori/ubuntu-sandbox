export const GNUTLS_E_SUCCESS = 0;
export const GNUTLS_E_BASE64_DECODING_ERROR = -34;
export const GNUTLS_E_NO_CERTIFICATE_FOUND = -49;
export const GNUTLS_E_REQUESTED_DATA_NOT_AVAILABLE = -56;
export const GNUTLS_E_CERTIFICATE_KEY_MISMATCH = -60;
export const GNUTLS_E_FILE_ERROR = -64;

const UNKNOWN_ERROR_TEXT = '(unknown error code)';

const ERROR_TEXT: Readonly<Record<number, string>> = {
  [GNUTLS_E_SUCCESS]: 'Success.',
  [GNUTLS_E_BASE64_DECODING_ERROR]: 'Base64 decoding error.',
  [GNUTLS_E_NO_CERTIFICATE_FOUND]: 'No certificate was found.',
  [GNUTLS_E_REQUESTED_DATA_NOT_AVAILABLE]: 'The requested data were not available.',
  [GNUTLS_E_CERTIFICATE_KEY_MISMATCH]: 'The certificate and the given key do not match.',
  [GNUTLS_E_FILE_ERROR]: 'Error while reading file.',
};

export function gnutlsStrerror(code: number): string {
  return ERROR_TEXT[code] ?? UNKNOWN_ERROR_TEXT;
}
