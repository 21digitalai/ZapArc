import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const settingsHtml = readFileSync(new URL('./settings.html', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('./settings.ts', import.meta.url), 'utf8');
const backgroundSource = readFileSync(new URL('../background/background.ts', import.meta.url), 'utf8');

describe('Settings encrypted backup controls', () => {
  it('keeps the file picker hidden behind a styled action and exposes local backup actions', () => {
    expect(settingsHtml).toContain('id="restore-backup-file" class="backup-file-input" type="file"');
    expect(settingsHtml).toContain('for="restore-backup-file" class="backup-file-btn"');
    expect(settingsHtml).toContain('id="export-backup" class="backup-action-btn"');
    expect(settingsHtml).toContain('id="restore-backup" class="backup-action-btn backup-action-btn-secondary"');
  });

  it('uses the privileged encrypted boundary and clears entered secrets after success', () => {
    expect(settingsSource).toContain('ExtensionMessaging.exportEncryptedBackup');
    expect(settingsSource).toContain('ExtensionMessaging.restoreEncryptedBackup');
    expect(settingsSource).toContain('clearBackupPasswordFields();');
    expect(settingsSource).toContain('selectedBackupFile.size > 1024 * 1024');
  });

  it('requires a distinct new six-digit PIN for restore while retaining the selected file after validation feedback', () => {
    expect(settingsHtml).toContain('for="restore-wallet-pin">New PIN for restored wallet</label>');
    expect(settingsHtml).toContain('id="restore-wallet-pin"');
    expect(settingsSource).toContain('getRestoreBackupCredentials()');
    expect(settingsSource).toContain("Choose a new six-digit PIN for the restored wallet.");
    expect(settingsSource).toContain('credentials.newWalletPin');
    expect(settingsSource).toContain('restoreButton.disabled = !selectedBackupFile;');
  });

  it('preserves the privileged PIN lockout and six-digit restore PIN boundary', () => {
    const exportCase = backgroundSource.split("case 'EXPORT_ENCRYPTED_BACKUP':")[1].split("case 'RESTORE_ENCRYPTED_BACKUP':")[0];
    expect(exportCase).toContain('checkPinLockout()');
    expect(exportCase.indexOf('checkPinLockout()')).toBeLessThan(exportCase.indexOf('exportActiveWalletBackup'));
    expect(backgroundSource).toContain('/^\\d{6}$/.test(newWalletPin)');
  });
});
