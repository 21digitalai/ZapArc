import { describe, expect, it } from 'vitest';
import { ChromeStorageManager } from './storage';

type Wallet = { metadata: { id: string; lastUsedAt?: number }; encryptedMnemonic: string; subWallets?: Array<{ index: number }> };
type StorageData = { activeWalletId: string; activeSubWalletIndex: number; wallets: Wallet[]; walletOrder: string[]; version: number };

function makeStorage(data: StorageData) {
    let stored = JSON.stringify(data);
    (globalThis as any).chrome = {
        storage: { local: {
            get: async () => ({ multiWalletData: stored }),
            set: async (value: { multiWalletData: string }) => { stored = value.multiWalletData; },
        } },
    };
    const manager = Object.create(ChromeStorageManager.prototype) as ChromeStorageManager;
    (manager as any).withStorageLock = async (operation: () => Promise<void>) => operation();
    return { manager, value: () => JSON.parse(stored) as StorageData };
}

describe('removeWallet', () => {
    it('resets the active sub-wallet when deleting the active wallet and cleans wallet order', async () => {
        const fixture = makeStorage({
            version: 1,
            activeWalletId: 'active',
            activeSubWalletIndex: 2,
            walletOrder: ['replacement', 'active'],
            wallets: [
                { metadata: { id: 'active' }, encryptedMnemonic: 'active seed', subWallets: [{ index: 2 }] },
                { metadata: { id: 'replacement' }, encryptedMnemonic: 'replacement seed' },
            ],
        });

        await fixture.manager.removeWallet('active', '123456');

        expect(fixture.value()).toMatchObject({
            activeWalletId: 'replacement',
            activeSubWalletIndex: 0,
            walletOrder: ['replacement'],
        });
        expect(fixture.value().wallets.map(wallet => wallet.metadata.id)).toEqual(['replacement']);
    });

    it('refuses to delete the last wallet without changing storage', async () => {
        const fixture = makeStorage({
            version: 1,
            activeWalletId: 'only',
            activeSubWalletIndex: 0,
            walletOrder: ['only'],
            wallets: [{ metadata: { id: 'only' }, encryptedMnemonic: 'only seed' }],
        });

        await expect(fixture.manager.removeWallet('only', '123456')).rejects.toThrow('Cannot remove the last wallet');
        expect(fixture.value().wallets.map(wallet => wallet.metadata.id)).toEqual(['only']);
    });
});
