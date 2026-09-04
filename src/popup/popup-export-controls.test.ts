import { describe, expect, it, vi } from 'vitest';
import { copySupportExport, createDetailedSupportExportHandler } from './detailed-support-export';
import { collectDetailedSupportSnapshot } from './support-diagnostics';

describe('transaction-detail support export controls', () => {
    it('does not collect or export when detailed export confirmation is cancelled', async () => {
        const button = { disabled: false, textContent: 'Copy detailed support export' };
        const collect = vi.fn();
        const exportSnapshot = vi.fn();
        const handler = createDetailedSupportExportHandler(button, {
            confirm: vi.fn(async () => false), collect, exportSnapshot, reportError: vi.fn(),
        });

        await handler();

        expect(collect).not.toHaveBeenCalled();
        expect(exportSnapshot).not.toHaveBeenCalled();
        expect(button).toEqual({ disabled: false, textContent: 'Copy detailed support export' });
    });

    it('collects and exports on confirmation, including fallback-owned export and button recovery', async () => {
        const button = { disabled: false, textContent: 'Copy detailed support export' };
        const snapshot = { refresh: { attempted: true, succeeded: true } };
        const collect = vi.fn(async () => snapshot);
        const exportSnapshot = vi.fn(async () => undefined);
        const handler = createDetailedSupportExportHandler(button, {
            confirm: vi.fn(async () => true), collect, exportSnapshot, reportError: vi.fn(),
        });

        await handler();

        expect(collect).toHaveBeenCalledOnce();
        expect(exportSnapshot).toHaveBeenCalledWith(snapshot);
        expect(button).toEqual({ disabled: false, textContent: 'Copy detailed support export' });
    });

    it('reports export failure and still restores the detailed export button', async () => {
        const button = { disabled: false, textContent: 'Copy detailed support export' };
        const reportError = vi.fn();
        const handler = createDetailedSupportExportHandler(button, {
            confirm: vi.fn(async () => true),
            collect: vi.fn(async () => ({ refresh: { attempted: true, succeeded: false, error: 'offline' } })),
            exportSnapshot: vi.fn(async () => { throw new Error('Clipboard and download failed'); }),
            reportError,
        });

        await handler();

        expect(reportError).toHaveBeenCalledWith(expect.any(Error));
        expect(button).toEqual({ disabled: false, textContent: 'Copy detailed support export' });
    });

    it('falls back to a local JSON download when clipboard copy is unavailable', async () => {
        const download = vi.fn();
        const notifyFallback = vi.fn();
        const warn = vi.fn();
        await copySupportExport('safe export', 'Copied', 'detailed-support', {
            copy: vi.fn(async () => { throw new Error('clipboard rejected'); }),
            download,
            notifyFallback,
            warn,
            now: () => new Date('2026-09-04T14:19:00.000Z'),
        });

        expect(download).toHaveBeenCalledWith('safe export', 'zaparc-detailed-support-2026-09-04T14-19-00-000Z.json');
        expect(notifyFallback).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(expect.any(Error));
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
