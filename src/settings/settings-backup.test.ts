import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const settingsHtml = readFileSync(new URL('./settings.html', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('./settings.ts', import.meta.url), 'utf8');

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
});
