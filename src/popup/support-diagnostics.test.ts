import { describe, expect, it } from 'vitest';
import { beginSdkLogSession, buildSdkLogsExport, buildSupportExport, htlcClassification, recentSdkLogs, recordSdkLog, sanitizeSupportValue } from './support-diagnostics';
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
        expect(recentSdkLogs().length).toBeLessThanOrEqual(250);
        expect(htlcClassification('Returned')).toContain('not verified');
    });

    it('uses an explicit allowlist for the sanitized export and retains detailed context only after approval', () => {
        const payment = { id: 'payment-id', status: 'pending', paymentType: 'receive', amount: 2n, fees: 0n, timestamp: 1, method: 'lightning', details: { type: 'lightning', invoice: 'lnbc123', destinationPubkey: 'pubkey', htlcDetails: { paymentHash: 'hash', expiryTime: 10, status: 'waitingForPreimage' } } } as const;
        recordSdkLog('DEBUG', 'payment id=payment-id invoice=lnbc123');
        const sanitized = buildSupportExport(payment, 10, false);
        const detailed = buildSupportExport(payment, 10, true);
        expect(sanitized).not.toContain('payment-id');
        expect(sanitized).not.toContain('lnbc123');
        expect(sanitized).not.toContain('destinationPubkey');
        expect(sanitized).toContain('not included in sanitized export');
        expect(detailed).toContain('payment-id');
        expect(detailed).toContain('lnbc123');
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

        const output = buildSdkLogsExport(payment, undefined, now);
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

        const parsed = JSON.parse(buildSdkLogsExport(payment, undefined, new Date('2026-08-30T12:39:52.000Z')));
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
        }, undefined, now));

        expect(parsed.correlation.paymentId).toBe('01a052a2-2cd9-72f3-bb09-3fdf173a278a');
        expect(parsed.correlation.paymentTimestamp).toBe(paymentAt.toISOString());
        expect(parsed.correlation.exactPaymentLogMatchAvailable).toBe(true);
        expect(parsed.exactPaymentLogs).toHaveLength(1);
    });

    it('includes Breez-native payment and wallet snapshots after an authoritative sync', () => {
        const payment = {
            id: 'failed-payment', status: 'failed', paymentType: 'send', amount: 45n, fees: 1n,
            timestamp: 1, method: 'lightning',
            details: { type: 'lightning', htlcDetails: { paymentHash: 'hash', expiryTime: 99, status: 'returned' } },
        } as unknown as import('@breeztech/breez-sdk-spark/web').Payment;

        const parsed = JSON.parse(buildSdkLogsExport(payment, {
            payment,
            walletInfo: { balanceSats: 123n },
            syncSucceeded: true,
        }));

        expect(parsed.breez.paymentSnapshot.id).toBe('failed-payment');
        expect(parsed.breez.paymentSnapshot.amount).toBe('45');
        expect(parsed.breez.walletInfo.balanceSats).toBe('123');
        expect(parsed.zaparc.authoritativeSync.succeeded).toBe(true);
        expect(parsed.zaparc.htlcStatusLabel).toContain('not verified');
    });

    it('serializes a failed detailed refresh rather than presenting retained data as current', () => {
        const parsed = JSON.parse(buildSupportExport(undefined, 0, true, {
            attempted: true,
            succeeded: false,
            error: 'Support refresh timed out after 10 seconds',
        }));

        expect(parsed.zaparc.authoritativeSync).toEqual({
            attempted: true,
            succeeded: false,
            error: 'Support refresh timed out after 10 seconds',
        });
    });

    it('includes the complete active wallet session and retained recovery context', () => {
        const startedAt = new Date('2026-08-30T13:00:00.000Z');
        beginSdkLogSession(startedAt);
        recordSdkLog('DEBUG', 'historical recovery query without selected payment identifier', new Date('2026-08-30T13:00:01.000Z'));

        const parsed = JSON.parse(buildSdkLogsExport(undefined, undefined, new Date('2026-08-30T13:00:02.000Z')));
        expect(parsed.currentSdkSessionLogs.some((entry: SdkSupportLog) => entry.line.includes('historical recovery query'))).toBe(true);
        expect(parsed.fullRetainedSdkLogs.some((entry: SdkSupportLog) => entry.line.includes('historical recovery query'))).toBe(true);
        expect(parsed.retention.maxEntries).toBe(250);
    });
});
