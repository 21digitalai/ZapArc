export const MIN_INVOICE_EXPIRY_SECS = 60;
export const MAX_INVOICE_EXPIRY_SECS = 7 * 24 * 60 * 60;
export const DEFAULT_INVOICE_EXPIRY_SECS = 21600;
export const INVOICE_EXPIRY_PRESETS = [900, 3600, 21600, 86400, MAX_INVOICE_EXPIRY_SECS] as const;

export function customMinutesToExpirySecs(value: string): number | null {
  const seconds = Math.round(Number(value) * 60);
  return Number.isFinite(seconds) && seconds >= MIN_INVOICE_EXPIRY_SECS && seconds <= MAX_INVOICE_EXPIRY_SECS ? seconds : null;
}

export function isInvoiceExpiryPreset(seconds: number): boolean {
  return INVOICE_EXPIRY_PRESETS.includes(seconds as typeof INVOICE_EXPIRY_PRESETS[number]);
}

/** Decode the BOLT11 timestamp and expiry tag, without trusting the requested duration. */
export function getBolt11ExpiryTime(invoice: string, fallbackSecs: number): number {
  try {
    const separator = invoice.lastIndexOf('1');
    const data = invoice.slice(separator + 1).toLowerCase();
    const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const values = Array.from(data, char => charset.indexOf(char));
    if (separator < 1 || values.length < 111 || values.slice(0, 7).some(value => value < 0)) throw new Error('invalid bolt11');
    let timestamp = 0;
    for (let index = 0; index < 7; index += 1) timestamp = (timestamp * 32) + values[index];
    let expirySecs = 3600;
    for (let index = 7; index < values.length - 104;) {
      const tag = values[index];
      const length = (values[index + 1] * 32) + values[index + 2];
      if (length < 0 || index + 3 + length > values.length - 104) break;
      if (charset[tag] === 'x') {
        expirySecs = 0;
        for (let item = 0; item < length; item += 1) expirySecs = (expirySecs * 32) + values[index + 3 + item];
      }
      index += 3 + length;
    }
    return (timestamp + expirySecs) * 1000;
  } catch {
    return Date.now() + (fallbackSecs * 1000);
  }
}
