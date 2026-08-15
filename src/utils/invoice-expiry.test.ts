import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INVOICE_EXPIRY_SECS,
  MAX_INVOICE_EXPIRY_SECS,
  customMinutesToExpirySecs,
  getBolt11ExpiryTime,
  isInvoiceExpiryPreset
} from './invoice-expiry';

describe('invoice expiry settings', () => {
  it('uses one hour by default and retains every approved preset', () => {
    expect(DEFAULT_INVOICE_EXPIRY_SECS).toBe(3600);
    expect([900, 3600, 21600, 86400, 604800].every(isInvoiceExpiryPreset)).toBe(true);
  });

  it('accepts custom values only from one minute through seven days', () => {
    expect(customMinutesToExpirySecs('1')).toBe(60);
    expect(customMinutesToExpirySecs('10080')).toBe(MAX_INVOICE_EXPIRY_SECS);
    expect(customMinutesToExpirySecs('0')).toBeNull();
    expect(customMinutesToExpirySecs('10081')).toBeNull();
  });

  it('falls back to the requested duration when an invoice cannot be decoded', () => {
    const now = Date.now();
    const expiry = getBolt11ExpiryTime('not-a-bolt11-invoice', 900);
    expect(expiry).toBeGreaterThanOrEqual(now + 899000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 901000);
  });
});
