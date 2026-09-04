import { describe, expect, it, vi } from 'vitest';
import { finishWalletImport } from './wallet-import-flow';

describe('finishWalletImport', () => {
    it('preserves each import mnemonic across finalization and discovery', async () => {
        let mutableMnemonic = 'first wallet phrase';
        const discoveries: Array<[string, string]> = [];

        const runAttempt = async (masterKeyId: string) => {
            const mnemonic = mutableMnemonic;
            return finishWalletImport({
                masterKeyId,
                mnemonic,
                finalize: async () => {
                    mutableMnemonic = '';
                    return true;
                },
                recover: vi.fn(),
                startDiscovery: async (id, phrase) => {
                    discoveries.push([id, phrase]);
                },
                onDiscoveryError: vi.fn(),
            });
        };

        await expect(runAttempt('wallet-1')).resolves.toBe(true);
        mutableMnemonic = 'second wallet phrase';
        await expect(runAttempt('wallet-2')).resolves.toBe(true);

        expect(discoveries).toEqual([
            ['wallet-1', 'first wallet phrase'],
            ['wallet-2', 'second wallet phrase'],
        ]);
    });

    it('recovers the form and skips discovery when finalization fails', async () => {
        const recover = vi.fn();
        const startDiscovery = vi.fn(async () => undefined);

        await expect(finishWalletImport({
            masterKeyId: 'wallet-2',
            mnemonic: 'second wallet phrase',
            finalize: async () => false,
            recover,
            startDiscovery,
            onDiscoveryError: vi.fn(),
        })).resolves.toBe(false);

        expect(recover).toHaveBeenCalledOnce();
        expect(startDiscovery).not.toHaveBeenCalled();
    });
});
