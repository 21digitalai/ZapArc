import { describe, expect, it, vi } from 'vitest';
import { BreezSDKWrapper } from './breez-sdk';

function connectedWrapper(sdk: Record<string, unknown>): BreezSDKWrapper {
  const wrapper = new BreezSDKWrapper();
  (wrapper as any).sdk = sdk;
  (wrapper as any).isConnected = true;
  return wrapper;
}

describe('Breez SDK 0.23 compatibility', () => {
  it('uses the typed input request for BOLT11 sends', async () => {
    const prepareSendPayment = vi.fn(async () => ({ prepared: true }));
    const sendPayment = vi.fn(async () => ({ payment: { status: 'completed' } }));
    await connectedWrapper({ prepareSendPayment, sendPayment }).sendPayment({ bolt11: 'lnbc1invoice' });
    expect(prepareSendPayment).toHaveBeenCalledWith({ paymentRequest: { type: 'input', input: 'lnbc1invoice' } });
  });

  it('uses bigint amount and reads nested HTLC fields for LNURL payments', async () => {
    const prepareLnurlPay = vi.fn(async () => ({ feeSats: 2 }));
    const lnurlPay = vi.fn(async () => ({
      payment: { id: 'p1', amount: 10n, fees: 2n, details: { type: 'lightning', htlcDetails: { paymentHash: 'hash', preimage: 'preimage' } } }
    }));
    const result = await connectedWrapper({ prepareLnurlPay, lnurlPay }).payLnurl({ reqData: { callback: 'https://example.com' }, amountSats: 10 });
    expect(prepareLnurlPay).toHaveBeenCalledWith(expect.objectContaining({ amount: 10n }));
    expect(result).toMatchObject({ success: true, paymentHash: 'hash', preimage: 'preimage', amountSats: 10, feeSats: 2 });
  });

  it('maps the 0.23 completed status as completed', async () => {
    const listPayments = vi.fn(async () => ({ payments: [{ id: 'p1', paymentType: 'receive', amount: 1n, timestamp: 1, status: 'completed' }] }));
    const [payment] = await connectedWrapper({ listPayments }).listPayments();
    expect(payment.status).toBe('completed');
  });
});
