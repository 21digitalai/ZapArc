import { describe, expect, it } from 'vitest';
import { buildSupportExport, htlcClassification, recentSdkLogs, recordSdkLog, sanitizeSupportValue } from './support-diagnostics';

describe('support diagnostics', () => {
    it('irreversibly removes true secrets from support exports', () => {
        const output = buildSupportExport({ id: 'payment-id', status: 'failed', paymentType: 'send', amount: 12n, fees: 1n, timestamp: 1, method: 'lightning', details: { type: 'lightning', invoice: 'lnbc123', destinationPubkey: 'pubkey', htlcDetails: { paymentHash: 'hash', preimage: 'secret', expiryTime: 10, status: 'returned' } } }, 12, true);
        expect(output).not.toContain('"preimage": "secret"');
        expect(output).toContain('"amount": "12"');
        expect(output).toContain('Returned (balance restoration not verified)');
        expect(sanitizeSupportValue('Authorization: Bearer shh')).toBe('Authorization:[REDACTED]');
    });

    it('keeps a bounded log ring and uses cautious returned classification', () => {
        for (let index = 0; index < 255; index++) recordSdkLog('DEBUG', `line ${index}`);
        expect(recentSdkLogs()).toHaveLength(250);
        expect(htlcClassification('Returned')).toContain('not verified');
    });

    it('redacts identifiers only from the sanitized export', () => {
        const payment = { id: 'payment-id', status: 'pending', paymentType: 'receive', amount: 2n, fees: 0n, timestamp: 1, method: 'lightning', details: { type: 'lightning', invoice: 'lnbc123', destinationPubkey: 'pubkey', htlcDetails: { paymentHash: 'hash', expiryTime: 10, status: 'waitingForPreimage' } } } as const;
        expect(buildSupportExport(payment, 10, false)).not.toContain('payment-id');
        expect(buildSupportExport(payment, 10, true)).toContain('payment-id');
    });

    it('serializes bigint values anywhere in the Breez response', () => {
        const payment = { id: 'payment-id', status: 'completed', paymentType: 'receive', amount: 2n, fees: 0n, timestamp: 1, method: 'spark', details: { type: 'spark', invoiceDetails: { invoice: 'spark123' } }, futureSdkField: { amount: 999n } } as unknown as import('@breeztech/breez-sdk-spark/web').Payment;
        expect(() => buildSupportExport(payment, 10, true)).not.toThrow();
        expect(buildSupportExport(payment, 10, true)).toContain('"amount": "999"');
    });
});
