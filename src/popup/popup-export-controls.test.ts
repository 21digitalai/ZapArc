import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collectDetailedSupportSnapshot } from './support-diagnostics';

const popupSource = readFileSync(new URL('./popup.ts', import.meta.url), 'utf8');

describe('transaction-detail support export controls', () => {
    it('keeps detailed collection behind confirmation, so cancellation performs no refresh', () => {
        const confirmIndex = popupSource.indexOf('const confirmed = await showConfirmDialog(');
        const cancellationIndex = popupSource.indexOf('if (!confirmed) return;', confirmIndex);
        const collectionIndex = popupSource.indexOf('collectDetailedSupportSnapshot(', cancellationIndex);

        expect(confirmIndex).toBeGreaterThanOrEqual(0);
        expect(cancellationIndex).toBeGreaterThan(confirmIndex);
        expect(collectionIndex).toBeGreaterThan(cancellationIndex);
    });

    it('records an authoritative success outcome after refreshing payment and wallet data', async () => {
        const payment = { id: 'fresh-payment' } as never;
        const snapshot = await collectDetailedSupportSnapshot({
            syncWallet: async () => undefined,
            getPayment: async () => ({ payment }),
            getInfo: async () => ({ balanceSats: 21n }),
        }, 'fresh-payment', 5);

        expect(snapshot.payment).toBe(payment);
        expect(snapshot.walletInfo).toEqual({ balanceSats: 21n });
        expect(snapshot.refresh).toEqual({ attempted: true, succeeded: true });
    });

    it('records timeout/failure context while keeping export available', async () => {
        const snapshot = await collectDetailedSupportSnapshot({
            syncWallet: () => new Promise(() => undefined),
            getPayment: async () => ({ payment: undefined }),
            getInfo: async () => ({}),
        }, 'payment-id', 1);

        expect(snapshot.payment).toBeUndefined();
        expect(snapshot.refresh.attempted).toBe(true);
        expect(snapshot.refresh.succeeded).toBe(false);
        expect(snapshot.refresh.error).toContain('timed out');
    });
});
