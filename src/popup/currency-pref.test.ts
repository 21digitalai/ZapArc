import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/messaging', () => ({
    ExtensionMessaging: {
        getUserSettings: vi.fn(),
    },
}));

describe('shared currency preference', () => {
    let stored: Record<string, unknown>;
    let storageListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | undefined;

    beforeEach(() => {
        vi.resetModules();
        stored = {};
        storageListener = undefined;

        vi.stubGlobal('chrome', {
            storage: {
                local: {
                    get: vi.fn(async (keys: string[]) => Object.fromEntries(
                        keys.filter((key) => key in stored).map((key) => [key, stored[key]]),
                    )),
                    set: vi.fn(async (values: Record<string, unknown>) => {
                        Object.assign(stored, values);
                    }),
                },
                onChanged: {
                    addListener: vi.fn((listener) => {
                        storageListener = listener;
                    }),
                },
            },
        });
    });

    it('persists one fiat selection for settings and every display surface', async () => {
        const prefs = await import('./currency-pref');

        await prefs.persistFiatCurrency('eur');

        expect(stored.fiatCurrencyPreference).toBe('eur');
        expect(stored.display_currency).toBe('eur');
        expect(stored.userSettings).toEqual({ fiatCurrency: 'eur' });
        await expect(prefs.getUserFiatCurrency()).resolves.toBe('eur');
        await expect(prefs.getDisplayCurrency()).resolves.toBe('eur');
    });

    it('invalidates popup caches when settings changes in another extension page', async () => {
        stored = {
            fiatCurrencyPreference: 'usd',
            display_currency: 'usd',
        };
        const prefs = await import('./currency-pref');
        await expect(prefs.getDisplayCurrency()).resolves.toBe('usd');

        stored.fiatCurrencyPreference = 'eur';
        stored.display_currency = 'eur';
        storageListener?.({
            fiatCurrencyPreference: { oldValue: 'usd', newValue: 'eur' },
            display_currency: { oldValue: 'usd', newValue: 'eur' },
        }, 'local');

        await expect(prefs.getUserFiatCurrency()).resolves.toBe('eur');
        await expect(prefs.getDisplayCurrency()).resolves.toBe('eur');
    });
});
