import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_INVOICE_EXPIRY_SECS,
  MAX_INVOICE_EXPIRY_SECS,
  customMinutesToExpirySecs,
  getBolt11ExpiryTime,
  isInvoiceExpiryPreset
} from './invoice-expiry';
import { ChromeStorageManager } from './storage';
import { BreezSDKWrapper } from './breez-sdk';
import { WalletManager } from './wallet-manager';

const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bolt11WithExpiry(timestamp: number, expirySecs: number): string {
  const values: number[] = [];
  for (let index = 6; index >= 0; index -= 1) values.push(Math.floor(timestamp / (32 ** index)) % 32);
  const expiryValues: number[] = [];
  do {
    expiryValues.unshift(expirySecs % 32);
    expirySecs = Math.floor(expirySecs / 32);
  } while (expirySecs > 0);
  values.push(charset.indexOf('x'), 0, expiryValues.length, ...expiryValues);
  while (values.length < 7 + 3 + expiryValues.length + 104) values.push(0);
  return `lnbc1${values.map(value => charset[value]).join('')}`;
}

describe('invoice expiry settings', () => {
  it('uses one hour by default and retains every approved preset', () => {
    expect(DEFAULT_INVOICE_EXPIRY_SECS).toBe(3600);
    expect([900, 3600, 21600, 86400, 604800].every(isInvoiceExpiryPreset)).toBe(true);
  });

  it('accepts custom values only from one minute through seven days', () => {
    expect(customMinutesToExpirySecs('1')).toBe(60);
    expect(customMinutesToExpirySecs('10080')).toBe(MAX_INVOICE_EXPIRY_SECS);
    expect(customMinutesToExpirySecs('0')).toBeNull();
    expect(customMinutesToExpirySecs('10081')).toBeNull();
  });

  it('falls back to the requested duration when an invoice cannot be decoded', () => {
    const now = Date.now();
    const expiry = getBolt11ExpiryTime('not-a-bolt11-invoice', 900);
    expect(expiry).toBeGreaterThanOrEqual(now + 899000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 901000);
  });

  it('uses the encoded BOLT11 timestamp and x tag for monitoring deadline', () => {
    const timestamp = 1_700_000_000;
    expect(getBolt11ExpiryTime(bolt11WithExpiry(timestamp, 21_600), 900)).toBe((timestamp + 21_600) * 1000);
  });
});

describe('invoice expiry persistence and forwarding', () => {
  const storage: Record<string, any> = {};

  beforeEach(() => {
    for (const key of Object.keys(storage)) delete storage[key];
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter(key => key in storage).map(key => [key, storage[key]]))),
          set: vi.fn(async (values: Record<string, any>) => Object.assign(storage, values))
        }
      }
    };
  });

  it('merges legacy settings with the one-hour default and preserves an explicit saved choice', async () => {
    storage.userSettings = { useBuiltInWallet: false, autoLockTimeout: 0, fiatCurrency: 'eur' };
    const manager = new ChromeStorageManager();
    expect((await manager.getUserSettings()).invoiceExpirySecs).toBe(DEFAULT_INVOICE_EXPIRY_SECS);

    const settings = await manager.getUserSettings();
    settings.invoiceExpirySecs = 86_400;
    await manager.saveUserSettings(settings);
    expect((await manager.getUserSettings()).invoiceExpirySecs).toBe(86_400);
  });

  it('forwards expirySecs through both BreezSDKWrapper and WalletManager', async () => {
    const receivePayment = vi.fn(async () => ({ paymentRequest: 'lnbc1example' }));
    const wrapper = new BreezSDKWrapper();
    (wrapper as any).sdk = { receivePayment };
    (wrapper as any).isConnected = true;
    await wrapper.receivePayment({ amountSats: 25, description: 'test', expirySecs: 21_600 });
    expect(receivePayment).toHaveBeenCalledWith(expect.objectContaining({
      paymentMethod: expect.objectContaining({ expirySecs: 21_600 })
    }));

    const wallet = new WalletManager();
    const walletReceivePayment = vi.fn(async () => 'lnbc1wallet');
    (wallet as any).walletStatus.isConnected = true;
    (wallet as any).walletStatus.isUnlocked = true;
    (wallet as any).storage = { getUserSettings: vi.fn(async () => ({ invoiceExpirySecs: 604_800 })), updateActivity: vi.fn() };
    (wallet as any).breezSDK = { isWalletConnected: () => true, receivePayment: walletReceivePayment };
    await wallet.generateInvoice(50, 'wallet test');
    expect(walletReceivePayment).toHaveBeenCalledWith(expect.objectContaining({ expirySecs: 604_800 }));
  });

  it('keeps invoiceExpirySecs in both settings save surfaces', () => {
    const srcRoot = resolve(__dirname, '..');
    const standaloneSettings = readFileSync(resolve(srcRoot, 'settings/settings.ts'), 'utf8');
    const popupSettings = readFileSync(resolve(srcRoot, 'popup/popup.ts'), 'utf8');
    expect(standaloneSettings).toContain('invoiceExpirySecs');
    expect(standaloneSettings).toContain('ExtensionMessaging.saveUserSettings(newSettings)');
    expect(popupSettings).toContain('settings.invoiceExpirySecs = expirySecs');
    expect(popupSettings).toContain('ExtensionMessaging.saveUserSettings(settings)');
  });
});
