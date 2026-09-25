import { describe, expect, it } from 'vitest';
import * as bip39 from 'bip39';
import { encryptBackupMnemonic } from './backup-crypto';
import { ChromeStorageManager } from './storage';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RESTORE_MNEMONIC = bip39.generateMnemonic();

function makeManager(options: { failFirstWrite?: boolean; switchActiveDuringEncryption?: boolean; corruptContactsWrite?: boolean } = {}) {
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
  let setCalls = 0;
  (globalThis as any).chrome = { storage: { local: {
    get: async () => ({ multiWalletData: walletData, contacts, walletVersion: 1 }),
    set: async (value: { multiWalletData?: string; contacts?: unknown }) => {
      setCalls += 1;
      if (options.failFirstWrite && setCalls === 1) throw new Error('Simulated storage failure');
      if (value.multiWalletData !== undefined) walletData = value.multiWalletData;
      if (value.contacts !== undefined) {
        contacts = options.corruptContactsWrite && setCalls === 1
          ? [{ id: 'corrupt', name: 'Corrupt', lightningAddress: 'corrupt@example.com', createdAt: 1, updatedAt: 1 }]
          : value.contacts;
      }
    },
  } } };
  const manager = Object.create(ChromeStorageManager.prototype) as ChromeStorageManager;
  (manager as any).withStorageLock = async (operation: () => Promise<unknown>) => operation();
  (manager as any).decryptMnemonic = async (entry: { data: number[] }) => entry.data[0] === 1 ? MNEMONIC : 'other wallet mnemonic';
  (manager as any).encryptMnemonic = async () => {
    if (options.switchActiveDuringEncryption) {
      const data = JSON.parse(walletData);
      data.activeWalletId = 'other';
      walletData = JSON.stringify(data);
    }
    return { data: [3], iv: [1], timestamp: 1, salt: 'salt' };
  };
  (manager as any).verifyStoredMnemonicRoundTrip = async () => undefined;
  return { manager, state: () => ({ walletData, wallets: JSON.parse(walletData).wallets, contacts }), writes: () => setCalls };
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

  it('rolls back both wallet and contacts when the restore write fails', async () => {
    const fixture = makeManager({ failFirstWrite: true });
    const before = fixture.state();
    const backup = await encryptBackupMnemonic(RESTORE_MNEMONIC, 'BackupPass1', 'Restored', JSON.stringify([
      { id: 'new', name: 'New', lightningAddress: 'new@example.com', createdAt: 2, updatedAt: 2 },
    ]));

    await expect(fixture.manager.restoreEncryptedBackup(backup, 'BackupPass1', '111111', 'Restored', 'active')).rejects.toThrow('Simulated storage failure');

    expect(fixture.state()).toEqual(before);
    expect(fixture.writes()).toBe(2);
  });

  it('rolls back both documents when a same-length contacts write is corrupted', async () => {
    const fixture = makeManager({ corruptContactsWrite: true });
    const before = fixture.state();
    const backup = await encryptBackupMnemonic(RESTORE_MNEMONIC, 'BackupPass1', 'Restored', JSON.stringify([
      { id: 'new', name: 'New', lightningAddress: 'new@example.com', createdAt: 2, updatedAt: 2 },
    ]));

    await expect(fixture.manager.restoreEncryptedBackup(backup, 'BackupPass1', '111111', 'Restored', 'active')).rejects.toThrow('Contact restore verification failed');

    expect(fixture.state()).toEqual(before);
    expect(fixture.writes()).toBe(2);
  });

  it('does not mutate storage when the active wallet changes during restore', async () => {
    const fixture = makeManager({ switchActiveDuringEncryption: true });
    const backup = await encryptBackupMnemonic(RESTORE_MNEMONIC, 'BackupPass1', 'Restored');

    await expect(fixture.manager.restoreEncryptedBackup(backup, 'BackupPass1', '111111', 'Restored', 'active')).rejects.toThrow('Active wallet changed');

    expect(fixture.state().wallets).toHaveLength(2);
    expect(fixture.state().contacts).toHaveLength(1);
    expect(fixture.writes()).toBe(0);
  });

  it('does not mutate wallets or contacts when the mnemonic already exists', async () => {
    const fixture = makeManager();
    const before = fixture.state();
    const backup = await encryptBackupMnemonic(MNEMONIC, 'BackupPass1', 'Duplicate', JSON.stringify([
      { id: 'new', name: 'New', lightningAddress: 'new@example.com', createdAt: 2, updatedAt: 2 },
    ]));

    await expect(fixture.manager.restoreEncryptedBackup(backup, 'BackupPass1', '111111', 'Duplicate', 'active')).rejects.toThrow('already been imported');

    expect(fixture.state()).toEqual(before);
    expect(fixture.writes()).toBe(0);
  });
});
