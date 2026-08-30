import { describe, expect, it } from 'vitest';
import { buildSdkLogsExport, buildSupportExport, htlcClassification, recentSdkLogs, recordSdkLog, sanitizeSupportValue } from './support-diagnostics';
import type { SdkSupportLog } from './support-diagnostics';

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

    it('creates one full SDK log export with payment correlation context', () => {
        const now = new Date('2026-08-30T12:00:00.000Z');
        recordSdkLog('ERROR', 'payment id=secret-payment invoice=lnbc123 failed', now);
        const payment = {
            id: 'secret-payment',
            status: 'failed',
            paymentType: 'send',
            amount: 2n,
            fees: 0n,
            timestamp: Math.floor(now.getTime() / 1000),
            method: 'lightning',
            details: { type: 'lightning' },
        } as unknown as import('@breeztech/breez-sdk-spark/web').Payment;

        const output = buildSdkLogsExport(payment, now);
        expect(output).toContain('"exportType": "sdk-support-logs"');
        expect(output).toContain('secret-payment');
        expect(output).toContain('"sanitized": false');
        expect(output).toContain('"exactPaymentLogMatchAvailable": true');
        expect(output).toContain('"exactPaymentLogs"');
        expect(output).toContain('"paymentTimeWindowLogs"');
    });

    it('does not claim unrelated time-window logs are exact payment logs', () => {
        const paymentAt = new Date('2026-08-30T12:25:56.000Z');
        recordSdkLog('DEBUG', 'Building sdk and starting wallet sync', new Date('2026-08-30T12:39:00.000Z'));
        const payment = {
            id: '01a052a2-2cd9-72f3-bb09-3fdf173a278a',
            status: 'completed', paymentType: 'send', amount: 2n, fees: 0n,
            timestamp: Math.floor(paymentAt.getTime() / 1000), method: 'lightning', details: { type: 'lightning' },
        } as unknown as import('@breeztech/breez-sdk-spark/web').Payment;

        const parsed = JSON.parse(buildSdkLogsExport(payment, new Date('2026-08-30T12:39:52.000Z')));
        expect(parsed.correlation.exactPaymentLogMatchAvailable).toBe(false);
        expect(parsed.exactPaymentLogs).toEqual([]);
        expect(parsed.paymentTimeWindowAvailable).toBe(true);
        expect(parsed.paymentTimeWindowLogs.some((entry: SdkSupportLog) => entry.line.includes('starting wallet sync'))).toBe(true);
    });

    it('preserves transaction correlation when the raw Breez payment was omitted from Chrome storage', () => {
        const now = new Date('2026-08-30T12:47:37.000Z');
        const paymentAt = new Date('2026-08-30T12:47:30.000Z');
        recordSdkLog('DEBUG', 'payment 01a052a2-2cd9-72f3-bb09-3fdf173a278a reconciled', paymentAt);

        const parsed = JSON.parse(buildSdkLogsExport({
            id: '01a052a2-2cd9-72f3-bb09-3fdf173a278a',
            timestamp: paymentAt.getTime(),
            paymentHash: '4031af93283e10c9ce0639c343daaef1446fb1a4815455c2a7622ab0d1303595',
            status: 'completed',
            paymentType: 'receive',
            amount: 16,
        }, now));

        expect(parsed.correlation.paymentId).toBe('01a052a2-2cd9-72f3-bb09-3fdf173a278a');
        expect(parsed.correlation.paymentTimestamp).toBe(paymentAt.toISOString());
        expect(parsed.correlation.exactPaymentLogMatchAvailable).toBe(true);
        expect(parsed.exactPaymentLogs).toHaveLength(1);
    });
});
