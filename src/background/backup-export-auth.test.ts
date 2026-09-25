import { describe, expect, it } from 'vitest';
import { isBackupExportPinFailure } from './backup-export-auth';

describe('backup export PIN failure classification', () => {
  it('counts only an active-wallet authentication failure toward lockout', () => {
    expect(isBackupExportPinFailure(new Error('Failed to decrypt wallet mnemonic'))).toBe(true);
  });

  it.each([
    'A wallet, PIN, and backup password of at least 8 characters are required',
    'Active wallet changed; try again',
    'Active wallet is unavailable',
    'Storage is unavailable',
  ])('does not count %s as a PIN failure', message => {
    expect(isBackupExportPinFailure(new Error(message))).toBe(false);
  });
});
