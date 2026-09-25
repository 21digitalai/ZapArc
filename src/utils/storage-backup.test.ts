import { describe, expect, it } from 'vitest';
import * as bip39 from 'bip39';
import { encryptBackupMnemonic } from './backup-crypto';
import { ChromeStorageManager } from './storage';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RESTORE_MNEMONIC = bip39.generateMnemonic();

function makeManager() {
  let walletData = JSON.stringify({
    version: 1,
    activeWalletId: 'active',
    walletOrder: ['active', 'other'],
    wallets: [
      { metadata: { id: 'active', nickname: 'Active', createdAt: 1, lastUsedAt: 1 }, encryptedMnemonic: { data: [1], iv: [1], timestamp: 1 } },
      { metadata: { id: 'other', nickname: 'Other', createdAt: 1, lastUsedAt: 1 }, encryptedMnemonic: { data: [2], iv: [1], timestamp: 1 } },
    ],
  });
  let contacts: unknown = [{ id: 'keep', name: 'Existing', lightningAddress: 'existing@example.com', createdAt: 1, updatedAt: 1 }];
  (globalThis as any).chrome = { storage: { local: {
    get: async () => ({ multiWalletData: walletData, contacts, walletVersion: 1 }),
    set: async (value: { multiWalletData?: string; contacts?: unknown }) => {
      if (value.multiWalletData !== undefined) walletData = value.multiWalletData;
      if (value.contacts !== undefined) contacts = value.contacts;
    },
  } } };
  const manager = Object.create(ChromeStorageManager.prototype) as ChromeStorageManager;
  (manager as any).withStorageLock = async (operation: () => Promise<unknown>) => operation();
  (manager as any).decryptMnemonic = async (entry: { data: number[] }) => entry.data[0] === 1 ? MNEMONIC : 'other wallet mnemonic';
  (manager as any).encryptMnemonic = async () => ({ data: [3], iv: [1], timestamp: 1, salt: 'salt' });
  (manager as any).verifyStoredMnemonicRoundTrip = async () => undefined;
  return { manager, state: () => ({ wallets: JSON.parse(walletData).wallets, contacts }) };
}

describe('encrypted backup storage transaction', () => {
  it('exports global contacts while exporting only the selected active master mnemonic', async () => {
    const fixture = makeManager();
    const backup = await fixture.manager.exportActiveWalletBackup('active', '111111', 'BackupPass1');

    expect(backup.walletName).toBe('Active');
    expect(backup.contacts).toBeDefined();
    await expect(fixture.manager.exportActiveWalletBackup('other', '111111', 'BackupPass1')).rejects.toThrow('Active wallet changed');
  });

  it('merges only new global contacts and preserves the active wallet on restore', async () => {
    const fixture = makeManager();
    const backup = await encryptBackupMnemonic(RESTORE_MNEMONIC, 'BackupPass1', 'Restored', JSON.stringify([
      { id: 'different-id', name: 'Duplicate', lightningAddress: 'existing@example.com', createdAt: 2, updatedAt: 2 },
      { id: 'new', name: 'New', lightningAddress: 'new@example.com', createdAt: 2, updatedAt: 2 },
    ]));

    const result = await fixture.manager.restoreEncryptedBackup(backup, 'BackupPass1', '111111', 'Restored', 'active');

    expect(result).toMatchObject({ importedContacts: 1, skippedContacts: 1 });
    expect(fixture.state().wallets).toHaveLength(3);
    expect(fixture.state().contacts).toEqual([
      { id: 'keep', name: 'Existing', lightningAddress: 'existing@example.com', createdAt: 1, updatedAt: 1 },
      { id: 'new', name: 'New', lightningAddress: 'new@example.com', createdAt: 2, updatedAt: 2 },
    ]);
  });
});
