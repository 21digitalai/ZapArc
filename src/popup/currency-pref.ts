/**
 * Shared fiat currency preference reader.
 * Single source of truth for the current fiat currency across all popup modules.
 *
 * Uses an in-memory cache so that after saveFiatCurrency() updates the value,
 * all modules (popup.ts, deposit.ts, withdrawal.ts) immediately see the new
 * currency without waiting for a background storage round-trip.
 */

import type { FiatCurrency } from '../utils/currency';
import { ExtensionMessaging } from '../utils/messaging';
import type { UserSettings } from '../types';

export type DisplayCurrency = 'sats' | FiatCurrency;

let _cached: FiatCurrency | null = null;
let _displayCached: DisplayCurrency | null = null;
const FIAT_CURRENCY_KEY = 'fiatCurrencyPreference';
const DISPLAY_CURRENCY_KEY = 'display_currency';
const DISPLAY_ORDER: DisplayCurrency[] = ['sats', 'usd', 'eur'];

// Settings can be changed from the dedicated settings page while the popup is
// still alive. Invalidate this module's per-page cache so every surface reads
// the newly selected shared preference on its next render.
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        if (changes[FIAT_CURRENCY_KEY] || changes.userSettings) _cached = null;
        if (changes[DISPLAY_CURRENCY_KEY] || changes[FIAT_CURRENCY_KEY] || changes.userSettings) {
            _displayCached = null;
        }
    });
}

/**
 * Get the user's selected fiat currency.
 * Returns the in-memory cached value if available, otherwise reads from storage.
 */
export async function getUserFiatCurrency(): Promise<FiatCurrency> {
    if (_cached) return _cached;

    // Primary read path: dedicated key (most resilient against userSettings rewrites)
    try {
        const dedicated = await chrome.storage.local.get([FIAT_CURRENCY_KEY]);
        const value = dedicated?.[FIAT_CURRENCY_KEY];
        if (value === 'usd' || value === 'eur') {
            _cached = value;
            return value;
        }
    } catch (error) {
        console.warn('[CurrencyPref] Dedicated key read failed:', error);
    }

    // Secondary read path: canonical userSettings object
    try {
        const result = await chrome.storage.local.get(['userSettings']);
        const stored = result?.userSettings as Partial<UserSettings> | undefined;
        if (stored?.fiatCurrency === 'usd' || stored?.fiatCurrency === 'eur') {
            const value: FiatCurrency = stored.fiatCurrency;
            _cached = value;
            // Backfill dedicated key for future fast/reliable reads
            await chrome.storage.local.set({ [FIAT_CURRENCY_KEY]: value });
            return value;
        }
    } catch (error) {
        console.warn('[CurrencyPref] userSettings read failed:', error);
    }

    // Fallback read path: background messaging
    try {
        const response = await ExtensionMessaging.getUserSettings();
        if (response.success && response.data) {
            const value: FiatCurrency = (response.data as UserSettings).fiatCurrency || 'usd';
            _cached = value;
            await chrome.storage.local.set({ [FIAT_CURRENCY_KEY]: value });
            return value;
        }
    } catch (error) {
        console.warn('[CurrencyPref] Failed to read fiat currency via messaging:', error);
    }

    return 'usd';
}

/** Persist fiat currency to canonical userSettings object in storage. */
export async function persistFiatCurrency(currency: FiatCurrency): Promise<void> {
    const result = await chrome.storage.local.get(['userSettings']);
    const existing = (result?.userSettings || {}) as Partial<UserSettings>;
    await chrome.storage.local.set({
        [FIAT_CURRENCY_KEY]: currency,
        [DISPLAY_CURRENCY_KEY]: currency,
        userSettings: {
            ...existing,
            fiatCurrency: currency
        }
    });
    _cached = currency;
    _displayCached = currency;
}

export async function getDisplayCurrency(): Promise<DisplayCurrency> {
    if (_displayCached) return _displayCached;

    try {
        const result = await chrome.storage.local.get([DISPLAY_CURRENCY_KEY]);
        const value = result?.[DISPLAY_CURRENCY_KEY];
        if (value === 'sats' || value === 'usd' || value === 'eur') {
            _displayCached = value;
            return value;
        }
    } catch (error) {
        console.warn('[CurrencyPref] display_currency read failed:', error);
    }

    const migrated = await getUserFiatCurrency();
    _displayCached = migrated;
    try {
        await chrome.storage.local.set({ [DISPLAY_CURRENCY_KEY]: migrated });
    } catch (error) {
        console.warn('[CurrencyPref] display_currency migration write failed:', error);
    }
    return migrated;
}

export async function persistDisplayCurrency(currency: DisplayCurrency): Promise<void> {
    await chrome.storage.local.set({ [DISPLAY_CURRENCY_KEY]: currency });
    _displayCached = currency;

    if (currency === 'usd' || currency === 'eur') {
        await persistFiatCurrency(currency);
    }
}

export function cycleDisplayCurrency(current: DisplayCurrency): DisplayCurrency {
    const idx = DISPLAY_ORDER.indexOf(current);
    if (idx === -1) return 'sats';
    return DISPLAY_ORDER[(idx + 1) % DISPLAY_ORDER.length];
}

/**
 * Set the in-memory cache. Call this immediately after saving the new preference
 * so all modules see the update without waiting for storage.
 * Pass null to clear the cache (forces re-read from storage on next access).
 */
export function setFiatCurrencyCache(currency: FiatCurrency | null): void {
    _cached = currency;
}

export function setDisplayCurrencyCache(currency: DisplayCurrency | null): void {
    _displayCached = currency;
}
