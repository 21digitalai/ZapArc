import { describe, expect, it } from 'vitest';
import { decryptBackupMnemonic, encryptBackupMnemonic, isEncryptedBackup } from './backup-crypto';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'BackupPass1';

describe('mobile-compatible encrypted backup format', () => {
  it('round-trips a mnemonic and an independently authenticated contacts blob', async () => {
    const backup = await encryptBackupMnemonic(MNEMONIC, PASSWORD, 'Main Wallet', '[{"lightningAddress":"alice@example.com"}]');
    expect(isEncryptedBackup(backup)).toBe(true);
    expect(backup.version).toBe(3);
    expect(backup.format).toBe('aes-256-gcm');
    await expect(decryptBackupMnemonic(backup, PASSWORD)).resolves.toEqual({ mnemonic: MNEMONIC, contacts: '[{"lightningAddress":"alice@example.com"}]' });
  });

  it('rejects a wrong password and authenticated ciphertext tampering', async () => {
    const backup = await encryptBackupMnemonic(MNEMONIC, PASSWORD);
    await expect(decryptBackupMnemonic(backup, 'WrongPass1')).rejects.toThrow('Failed to decrypt backup');
    backup.ciphertext = `${backup.ciphertext.slice(0, -1)}A`;
    await expect(decryptBackupMnemonic(backup, PASSWORD)).rejects.toThrow('Failed to decrypt backup');
  });
});
