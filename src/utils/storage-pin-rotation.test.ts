import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ChromeStorageManager } from './storage';

type Wallet = { metadata: { id: string }; encryptedMnemonic: string; subWallets?: Array<{ index: number }> };
type StorageData = { activeWalletId: string; activeSubWalletIndex: number; wallets: Wallet[]; walletOrder: string[]; version: number };

function makeStorage(data: StorageData, failPersistedRead = false, failFirstWrite = false) {
    let stored = JSON.stringify(data);
    let reads = 0;
    let writes = 0;
    (globalThis as any).chrome = {
        storage: { local: {
            get: async () => {
                reads += 1;
                return { multiWalletData: failPersistedRead && reads > 1 ? JSON.stringify({ ...data, wallets: [] }) : stored };
            },
            set: async (value: { multiWalletData: string }) => {
                writes += 1;
                if (failFirstWrite && writes === 1) throw new Error('Storage quota exceeded');
                stored = value.multiWalletData;
            },
        } },
    };
    const manager = Object.create(ChromeStorageManager.prototype) as ChromeStorageManager;
    (manager as any).withStorageLock = async (operation: () => Promise<void>) => operation();
    (manager as any).decryptMnemonic = async (ciphertext: string, pin: string) => {
        const [savedPin, mnemonic] = ciphertext.split(':');
        if (savedPin !== pin) throw new Error('Incorrect PIN');
        return mnemonic;
    };
    (manager as any).encryptMnemonic = async (mnemonic: string, pin: string) => `${pin}:${mnemonic}`;
    (manager as any).normalizeMnemonicForComparison = (mnemonic: string) => mnemonic.trim();
    return { manager, value: () => JSON.parse(stored) as StorageData };
}

describe('rotateMasterKeyPin', () => {
    it('rotates only the active master wallet while preserving its sub-wallets and independent wallets', async () => {
        const initial: StorageData = {
            version: 1, activeWalletId: 'active', activeSubWalletIndex: 1, walletOrder: ['active', 'other'],
            wallets: [
                { metadata: { id: 'active' }, encryptedMnemonic: '111111:active seed', subWallets: [{ index: 1 }] },
                { metadata: { id: 'other' }, encryptedMnemonic: '111111:other seed' },
            ],
        };
        const fixture = makeStorage(initial);

        await fixture.manager.rotateMasterKeyPin('active', '111111', '222222');

        expect(fixture.value().wallets[0].encryptedMnemonic).toBe('222222:active seed');
        expect(fixture.value().wallets[0].subWallets).toEqual([{ index: 1 }]);
        expect(fixture.value().wallets[1].encryptedMnemonic).toBe('111111:other seed');
        await expect(fixture.manager.getMasterKeyMnemonic('active', '111111')).rejects.toThrow('Incorrect PIN');
        await expect(fixture.manager.getMasterKeyMnemonic('active', '222222')).resolves.toBe('active seed');
    });

    it('restores the original ciphertext when persisted verification fails', async () => {
        const data: StorageData = {
            version: 1, activeWalletId: 'active', activeSubWalletIndex: 0, walletOrder: ['active'],
            wallets: [{ metadata: { id: 'active' }, encryptedMnemonic: '111111:seed' }],
        };
        const fixture = makeStorage(data, true);

        await expect(fixture.manager.rotateMasterKeyPin('active', '111111', '222222')).rejects.toThrow('PIN change verification failed');
        expect(fixture.value().wallets[0].encryptedMnemonic).toBe('111111:seed');
    });

    it('restores the original ciphertext after a failed storage write', async () => {
        const data: StorageData = {
            version: 1, activeWalletId: 'active', activeSubWalletIndex: 0, walletOrder: ['active'],
            wallets: [{ metadata: { id: 'active' }, encryptedMnemonic: '111111:seed' }],
        };
        const fixture = makeStorage(data, false, true);

        await expect(fixture.manager.rotateMasterKeyPin('active', '111111', '222222')).rejects.toThrow('Storage quota exceeded');
        expect(fixture.value().wallets[0].encryptedMnemonic).toBe('111111:seed');
    });

    it('rejects a stale active-wallet target without mutating either wallet', async () => {
        const data: StorageData = {
            version: 1, activeWalletId: 'other', activeSubWalletIndex: 0, walletOrder: ['active', 'other'],
            wallets: [{ metadata: { id: 'active' }, encryptedMnemonic: '111111:seed' }, { metadata: { id: 'other' }, encryptedMnemonic: '333333:other' }],
        };
        const fixture = makeStorage(data);

        await expect(fixture.manager.rotateMasterKeyPin('active', '111111', '222222')).rejects.toThrow('Active wallet changed');
        expect(fixture.value().wallets.map(wallet => wallet.encryptedMnemonic)).toEqual(['111111:seed', '333333:other']);
    });

    it('leaves a legacy storage payload untouched with a recovery-safe error', async () => {
        const set = async () => { throw new Error('legacy storage must not be written'); };
        (globalThis as any).chrome = { storage: { local: {
            get: async () => ({ multiWalletData: 'legacy-wallet-format' }),
            set,
        } } };
        const manager = Object.create(ChromeStorageManager.prototype) as ChromeStorageManager;
        (manager as any).withStorageLock = async (operation: () => Promise<void>) => operation();

        await expect(manager.rotateMasterKeyPin('active', '111111', '222222')).rejects.toThrow('cannot safely change PIN');
    });
});

describe('Settings Change PIN action', () => {
    it('keeps the documented semantic class on the existing Settings action', () => {
        const popupHtml = readFileSync(new URL('../popup/popup.html', import.meta.url), 'utf8');
        expect(popupHtml).toContain('id="settings-change-pin-btn" class="settings-change-pin-btn settings-action-btn"');
    });
});
