// Storage utilities for Chrome Extension
// Handles encrypted storage, settings, and data management

import {
  WalletData,
  UserSettings,
  DomainSettings,
  BlacklistData,
  EncryptedWalletEntry,
  WalletMetadata,
  MultiWalletStorage,
  SubWalletEntry,
  MasterKeyMetadata,
  EncryptedData,
  HIERARCHICAL_WALLET_CONSTANTS,
  LightningAddressInfo,
  Contact
} from '../types';

import { deriveSubWalletMnemonic } from './mnemonic-derivation';
import * as bip39 from 'bip39';

/**
 * Generate a UUID v4 string
 */
export function generateUUID(): string {
  return crypto.randomUUID();
}

export class ChromeStorageManager {
  // TODO(security): migrate legacy static salt usage to per-wallet random salts for all encryption paths.
  // Keep current value for backward compatibility with existing encrypted wallets.
  // Keep the original salt so existing encrypted wallets remain decryptable.
  private static readonly SALT = 'lightning-tipping-salt';
  private static readonly ITERATIONS = 100000;
  private static _storageMutex: Promise<void> = Promise.resolve();

  private static async withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>(resolve => {
      release = resolve;
    });
    const prev = ChromeStorageManager._storageMutex;
    ChromeStorageManager._storageMutex = next;
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Encrypt and save wallet data using user PIN
   */
  async saveEncryptedWallet(data: WalletData, pin: string): Promise<void> {
    console.log('🔵 [Storage] SAVE_ENCRYPTED_WALLET ENTRY', {
      timestamp: new Date().toISOString(),
      pinLength: pin.length,
      dataKeys: Object.keys(data),
      hasMnemonic: !!data.mnemonic,
      mnemonicWordCount: data.mnemonic ? data.mnemonic.split(' ').length : 0
    });

    try {
      const key = await this.deriveKey(pin);
      console.log('🔍 [Storage] Encryption key derived successfully');

      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encodedData = new TextEncoder().encode(JSON.stringify(data));
      console.log('🔍 [Storage] Data encoded', {
        encodedSize: encodedData.length,
        ivLength: iv.length
      });

      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encodedData
      );
      console.log('🔍 [Storage] Data encrypted', {
        encryptedSize: encrypted.byteLength
      });

      const encryptedData = {
        data: Array.from(new Uint8Array(encrypted)),
        iv: Array.from(iv)
      };

      await chrome.storage.local.set({
        encryptedWallet: JSON.stringify(encryptedData)
      });
      console.log('✅ [Storage] SAVE_ENCRYPTED_WALLET SUCCESS', {
        timestamp: new Date().toISOString(),
        savedDataSize: JSON.stringify(encryptedData).length
      });

      // Verify immediately that it was saved
      const verification = await chrome.storage.local.get(['encryptedWallet']);
      console.log('🔍 [Storage] Save verification', {
        walletExists: !!verification.encryptedWallet,
        savedSize: verification.encryptedWallet?.length
      });
    } catch (error) {
      console.error('❌ [Storage] SAVE_ENCRYPTED_WALLET FAILED', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString()
      });
      throw new Error('Wallet encryption failed');
    }
  }

  /**
   * Load and decrypt wallet data using user PIN
   */
  async loadEncryptedWallet(pin: string): Promise<WalletData | null> {
    console.log('🔵 [Storage] LOAD_ENCRYPTED_WALLET ENTRY', {
      timestamp: new Date().toISOString(),
      pinLength: pin.length
    });

    try {
      const result = await chrome.storage.local.get(['encryptedWallet']);
      console.log('🔍 [Storage] Retrieved from storage', {
        walletExists: !!result.encryptedWallet,
        storageSize: result.encryptedWallet?.length
      });

      if (!result.encryptedWallet) {
        console.warn('⚠️ [Storage] No encrypted wallet found in storage');
        return null;
      }

      const encryptedData = JSON.parse(result.encryptedWallet);
      console.log('🔍 [Storage] Parsed encrypted data', {
        hasData: !!encryptedData.data,
        hasIv: !!encryptedData.iv,
        dataLength: encryptedData.data?.length,
        ivLength: encryptedData.iv?.length
      });

      const key = await this.deriveKey(pin);
      console.log('🔍 [Storage] Decryption key derived successfully');

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(encryptedData.iv) },
        key,
        new Uint8Array(encryptedData.data)
      );
      console.log('🔍 [Storage] Data decrypted', {
        decryptedSize: decrypted.byteLength
      });

      const decoder = new TextDecoder();
      const walletData = JSON.parse(decoder.decode(decrypted));
      console.log('✅ [Storage] LOAD_ENCRYPTED_WALLET SUCCESS', {
        timestamp: new Date().toISOString(),
        hasMnemonic: !!walletData.mnemonic,
        mnemonicWordCount: walletData.mnemonic ? walletData.mnemonic.split(' ').length : 0,
        balance: walletData.balance
      });

      return walletData;
    } catch (error) {
      console.error('❌ [Storage] LOAD_ENCRYPTED_WALLET FAILED', {
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
        likelyPinMismatch: error instanceof Error && error.name === 'OperationError'
      });
      return null;
    }
  }

  /**
   * Save domain settings (whitelist/blacklist status)
   */
  async saveDomainSettings(domain: string, status: string): Promise<void> {
    try {
      const result = await chrome.storage.local.get(['domainSettings']);
      const domainSettings: DomainSettings = result.domainSettings || {};
      domainSettings[domain] = status as any;
      await chrome.storage.local.set({ domainSettings });
    } catch (error) {
      console.error('Failed to save domain settings:', error);
      throw error;
    }
  }

  /**
   * Get domain settings
   */
  async getDomainSettings(): Promise<DomainSettings> {
    try {
      const result = await chrome.storage.local.get(['domainSettings']);
      return result.domainSettings || {};
    } catch (error) {
      console.error('Failed to get domain settings:', error);
      return {};
    }
  }

  /**
   * Save LNURL blacklist
   */
  async saveBlacklist(lnurls: string[]): Promise<void> {
    try {
      const blacklistData: BlacklistData = {
        lnurls,
        lastUpdated: Date.now()
      };
      await chrome.storage.local.set({ blacklistData });
    } catch (error) {
      console.error('Failed to save blacklist:', error);
      throw error;
    }
  }

  /**
   * Get LNURL blacklist
   */
  async getBlacklist(): Promise<BlacklistData> {
    try {
      const result = await chrome.storage.local.get(['blacklistData']);
      return result.blacklistData || { lnurls: [], lastUpdated: 0 };
    } catch (error) {
      console.error('Failed to get blacklist:', error);
      return { lnurls: [], lastUpdated: 0 };
    }
  }

  /**
   * Cache Lightning Address info for a specific wallet
   */
  async cacheLightningAddress(walletId: string, info: LightningAddressInfo): Promise<void> {
    try {
      const key = `lightningAddress_${walletId}`;
      await chrome.storage.local.set({ [key]: info });
    } catch (error) {
      console.error('Failed to cache Lightning Address:', error);
    }
  }

  /**
   * Get cached Lightning Address info for a specific wallet
   */
  async getCachedLightningAddress(walletId: string): Promise<LightningAddressInfo | null> {
    try {
      const key = `lightningAddress_${walletId}`;
      const result = await chrome.storage.local.get([key]);
      const cached = result[key] as LightningAddressInfo | undefined;
      return cached || null;
    } catch (error) {
      console.error('Failed to get cached Lightning Address:', error);
      return null;
    }
  }

  /**
   * Clear cached Lightning Address info for a specific wallet
   */
  async clearCachedLightningAddress(walletId: string): Promise<void> {
    try {
      const key = `lightningAddress_${walletId}`;
      await chrome.storage.local.remove([key]);
    } catch (error) {
      console.error('Failed to clear cached Lightning Address:', error);
    }
  }

  // ========================================
  // Contacts / Address Book
  // ========================================

  async getContacts(): Promise<Contact[]> {
    try {
      const result = await chrome.storage.local.get(['contacts']);
      return Array.isArray(result.contacts) ? result.contacts : [];
    } catch (error) {
      console.error('Failed to get contacts:', error);
      return [];
    }
  }

  async saveContacts(contacts: Contact[]): Promise<void> {
    try {
      await chrome.storage.local.set({ contacts });
    } catch (error) {
      console.error('Failed to save contacts:', error);
      throw error;
    }
  }

  async addContact(contact: Contact): Promise<void> {
    const contacts = await this.getContacts();
    const normalized = contact.lightningAddress.trim().toLowerCase();
    const duplicate = contacts.find(c => c.lightningAddress.trim().toLowerCase() === normalized);
    if (duplicate) {
      throw new Error('A contact with this Lightning address already exists');
    }
    contacts.push({ ...contact, lightningAddress: normalized });
    await this.saveContacts(contacts);
  }

  async updateContact(id: string, updates: Partial<Contact>): Promise<void> {
    const contacts = await this.getContacts();
    const index = contacts.findIndex(c => c.id === id);
    if (index === -1) {
      throw new Error('Contact not found');
    }

    if (updates.lightningAddress) {
      const normalized = updates.lightningAddress.trim().toLowerCase();
      const duplicate = contacts.find(c => c.id !== id && c.lightningAddress.trim().toLowerCase() === normalized);
      if (duplicate) {
        throw new Error('A contact with this Lightning address already exists');
      }
      updates.lightningAddress = normalized;
    }

    contacts[index] = {
      ...contacts[index],
      ...updates,
      updatedAt: updates.updatedAt || Date.now()
    };

    await this.saveContacts(contacts);
  }

  async deleteContact(id: string): Promise<void> {
    const contacts = await this.getContacts();
    const filtered = contacts.filter(c => c.id !== id);
    await this.saveContacts(filtered);
  }

  /**
   * Get user settings with defaults
   */
  async getUserSettings(): Promise<UserSettings> {
    try {
      const FIAT_CURRENCY_KEY = 'fiatCurrencyPreference';
      const result = await chrome.storage.local.get(['userSettings', FIAT_CURRENCY_KEY]);
      const defaults = this.getDefaultSettings();
      
      // Merge stored settings with defaults to ensure all fields are present
      if (result.userSettings) {
        // Prefer dedicated fiat key when present (more resilient), fallback to userSettings/defaults
        const dedicatedFiat = result[FIAT_CURRENCY_KEY];
        const fiatCurrency = (dedicatedFiat === 'usd' || dedicatedFiat === 'eur')
          ? dedicatedFiat
          : (result.userSettings.fiatCurrency || defaults.fiatCurrency);

        // Properly merge settings, preserving 0 values (like autoLockTimeout: 0 for "Never")
        const merged: UserSettings = {
          useBuiltInWallet: result.userSettings.useBuiltInWallet !== undefined ? result.userSettings.useBuiltInWallet : defaults.useBuiltInWallet,
          floatingMenuEnabled: result.userSettings.floatingMenuEnabled !== undefined ? result.userSettings.floatingMenuEnabled : defaults.floatingMenuEnabled,
          autoLockTimeout: result.userSettings.autoLockTimeout !== undefined ? result.userSettings.autoLockTimeout : defaults.autoLockTimeout,
          customLNURL: result.userSettings.customLNURL !== undefined ? result.userSettings.customLNURL : defaults.customLNURL,
          facebookPostingMode: result.userSettings.facebookPostingMode || defaults.facebookPostingMode,
          allowedFacebookGroups: result.userSettings.allowedFacebookGroups || defaults.allowedFacebookGroups,
          deniedFacebookGroups: result.userSettings.deniedFacebookGroups || defaults.deniedFacebookGroups,
          fiatCurrency
        };
        return merged;
      }

      // No userSettings object yet, but dedicated fiat key may exist
      const dedicatedFiat = result[FIAT_CURRENCY_KEY];
      if (dedicatedFiat === 'usd' || dedicatedFiat === 'eur') {
        return { ...defaults, fiatCurrency: dedicatedFiat };
      }
      
      return defaults;
    } catch (error) {
      console.error('Failed to get user settings:', error);
      return this.getDefaultSettings();
    }
  }

  /**
   * Save user settings
   */
  async saveUserSettings(settings: UserSettings): Promise<void> {
    try {
      const FIAT_CURRENCY_KEY = 'fiatCurrencyPreference';
      await chrome.storage.local.set({
        userSettings: settings,
        [FIAT_CURRENCY_KEY]: settings.fiatCurrency
      });
    } catch (error) {
      console.error('Failed to save user settings:', error);
      throw error;
    }
  }

  /**
   * Check if a wallet exists (has been set up)
   * Checks multi-wallet storage format only
   */
  async walletExists(): Promise<boolean> {
    try {
      const result = await chrome.storage.local.get(['multiWalletData', 'walletVersion']);
      const exists = !!(result.multiWalletData || result.walletVersion === 1);
      console.log('🔍 [Storage] walletExists() check', {
        hasMultiWalletData: !!result.multiWalletData,
        walletVersion: result.walletVersion,
        exists
      });
      return exists;
    } catch (error) {
      console.error('Failed to check wallet existence:', error);
      return false;
    }
  }

  /**
   * Check if wallet is unlocked
   */
  async isWalletUnlocked(): Promise<boolean> {
    try {
      const result = await chrome.storage.local.get(['isUnlocked', 'lastActivity']);
      if (!result.isUnlocked) return false;

      const settings = await this.getUserSettings();
      const now = Date.now();
      const lastActivity = result.lastActivity || now;
      const timeoutMs = settings.autoLockTimeout * 1000;

      if (timeoutMs > 0 && (now - lastActivity) > timeoutMs) {
        await this.lockWallet();
        return false;
      }

      return true;
    } catch (error) {
      console.error('Failed to check wallet unlock status:', error);
      return false;
    }
  }

  /**
   * Lock the wallet
   */
  async lockWallet(): Promise<void> {
    try {
      await chrome.storage.local.set({ 
        isUnlocked: false,
        lastActivity: 0
      });
    } catch (error) {
      console.error('Failed to lock wallet:', error);
    }
  }

  /**
   * Unlock the wallet
   */
  async unlockWallet(): Promise<void> {
    try {
      await chrome.storage.local.set({ 
        isUnlocked: true,
        lastActivity: Date.now()
      });
    } catch (error) {
      console.error('Failed to unlock wallet:', error);
    }
  }

  /**
   * Update last activity timestamp
   */
  async updateActivity(): Promise<void> {
    try {
      const isUnlocked = await this.isWalletUnlocked();
      if (isUnlocked) {
        await chrome.storage.local.set({ lastActivity: Date.now() });
      }
    } catch (error) {
      console.error('Failed to update activity:', error);
    }
  }

  // ========================================
  // PIN Lockout Management
  // ========================================

  async checkPinLockout(): Promise<{ locked: boolean; remainingMs?: number }> {
    try {
      const result = await chrome.storage.local.get(['pinAttempts', 'pinLockUntil']);
      const lockUntil = result.pinLockUntil || 0;
      const now = Date.now();

      if (lockUntil > now) {
        return { locked: true, remainingMs: lockUntil - now };
      }

      if (lockUntil && lockUntil <= now) {
        await chrome.storage.local.set({ pinLockUntil: 0 });
      }

      return { locked: false };
    } catch (error) {
      console.error('Failed to check PIN lockout status:', error);
      return { locked: false };
    }
  }

  async recordFailedPin(): Promise<void> {
    try {
      const result = await chrome.storage.local.get(['pinAttempts']);
      const attempts = (result.pinAttempts || 0) + 1;
      let lockMs = 0;

      if (attempts >= 10) {
        lockMs = 30 * 60 * 1000;
      } else if (attempts >= 5) {
        lockMs = 5 * 60 * 1000;
      } else if (attempts >= 3) {
        lockMs = 30 * 1000;
      }

      await chrome.storage.local.set({
        pinAttempts: attempts,
        pinLockUntil: lockMs > 0 ? Date.now() + lockMs : 0
      });
    } catch (error) {
      console.error('Failed to record failed PIN attempt:', error);
    }
  }

  async resetPinAttempts(): Promise<void> {
    try {
      await chrome.storage.local.set({ pinAttempts: 0, pinLockUntil: 0 });
    } catch (error) {
      console.error('Failed to reset PIN attempts:', error);
    }
  }

  private formatLockoutDuration(remainingMs: number): string {
    const totalSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }

    return `${seconds}s`;
  }

  private encodeBytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    bytes.forEach(byte => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary);
  }

  private decodeBase64ToBytes(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Derive encryption key from PIN
   */
  private async deriveKey(pin: string, salt?: Uint8Array): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(pin),
      { name: 'PBKDF2' },
      false,
      ['deriveBits', 'deriveKey']
    );

    const derivedSalt = (salt || encoder.encode(ChromeStorageManager.SALT)) as BufferSource;

    return await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: derivedSalt,
        iterations: ChromeStorageManager.ITERATIONS,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Get default user settings
   */
  private getDefaultSettings(): UserSettings {
    return {
      useBuiltInWallet: true,
      floatingMenuEnabled: true,
      autoLockTimeout: 900, // 15 minutes
      customLNURL: undefined,
      facebookPostingMode: 'global',
      allowedFacebookGroups: [],
      deniedFacebookGroups: [],
      fiatCurrency: 'usd'
    };
  }

  // ========================================
  // Multi-Wallet Support Methods
  // ========================================

  /**
   * Validate encrypted payload integrity
   * Checks timestamp for suspicious age (potential rollback attack)
   */
  private validatePayloadIntegrity(timestamp: number): boolean {
    const now = Date.now();
    const maxAge = 90 * 24 * 60 * 60 * 1000; // 90 days
    const age = now - timestamp;

    if (age > maxAge) {
      console.warn('⚠️ [Storage] Wallet data timestamp is suspiciously old (>90 days)', {
        timestamp,
        age,
        ageInDays: Math.floor(age / (24 * 60 * 60 * 1000))
      });
      // Still return true but log warning for investigation
      return true;
    }

    if (age < 0) {
      console.warn('⚠️ [Storage] Wallet data timestamp is in the future (possible rollback attack)', {
        timestamp,
        now,
        difference: Math.abs(age)
      });
      // Still return true but log warning for investigation
      return true;
    }

    return true;
  }

  /**
   * Encrypt a single wallet mnemonic
   * Used for individual wallet encryption in multi-wallet structure
   */
  private async encryptMnemonic(mnemonic: string, pin: string): Promise<{ data: number[], iv: number[], timestamp: number, salt: string }> {
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await this.deriveKey(pin, salt);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encodedData = new TextEncoder().encode(mnemonic);

      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encodedData
      );

      return {
        data: Array.from(new Uint8Array(encrypted)),
        iv: Array.from(iv),
        timestamp: Date.now(),
        salt: this.encodeBytesToBase64(salt)
      };
    } catch (error) {
      console.error('❌ [Storage] Mnemonic encryption failed', error);
      throw new Error('Failed to encrypt wallet mnemonic');
    }
  }

  /**
   * Decrypt a single wallet mnemonic
   * Used for individual wallet decryption in multi-wallet structure
   */
  private async decryptMnemonic(
    encryptedData: { data: number[], iv: number[], timestamp: number, salt?: string },
    pin: string
  ): Promise<string> {
    try {
      // Validate integrity
      this.validatePayloadIntegrity(encryptedData.timestamp);

      const salt = encryptedData.salt ? this.decodeBase64ToBytes(encryptedData.salt) : undefined;
      const key = await this.deriveKey(pin, salt);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(encryptedData.iv) },
        key,
        new Uint8Array(encryptedData.data)
      );

      const mnemonic = new TextDecoder().decode(decrypted);
      return this.ensureValidBip39Mnemonic(mnemonic);
    } catch (error) {
      console.error('❌ [Storage] Mnemonic decryption failed', error);
      throw new Error('Failed to decrypt wallet mnemonic');
    }
  }

  /**
   * Normalize mnemonic for reliable round-trip comparison.
   */
  private normalizeMnemonicForComparison(mnemonic: string): string {
    return mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
  }

  private async withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
    return ChromeStorageManager.withStorageLock(fn);
  }

  private ensureValidBip39Mnemonic(mnemonic: string): string {
    const normalized = this.normalizeMnemonicForComparison(mnemonic);
    if (!bip39.validateMnemonic(normalized)) {
      throw new Error('Invalid mnemonic phrase');
    }
    return normalized;
  }

  /**
   * Verify encrypted mnemonic round-trip after storage write.
   * If verification fails, removes the stored entry and throws.
   */
  private async verifyStoredMnemonicRoundTrip(
    walletId: string,
    originalMnemonic: string,
    pin: string
  ): Promise<void> {
    const verificationResult = await chrome.storage.local.get(['multiWalletData', 'walletVersion']);

    if (!verificationResult.multiWalletData) {
      console.error('❌ [Storage] Round-trip verification failed: multiWalletData missing');
      throw new Error('Wallet storage verification failed');
    }

    const verificationData: MultiWalletStorage = JSON.parse(verificationResult.multiWalletData);
    const storedEntry = verificationData.wallets.find(w => w.metadata.id === walletId);

    if (!storedEntry) {
      console.error('❌ [Storage] Round-trip verification failed: wallet entry missing', { walletId });
      throw new Error('Wallet storage verification failed');
    }

    try {
      const decryptedMnemonic = await this.decryptMnemonic(storedEntry.encryptedMnemonic, pin);
      const normalizedOriginal = this.normalizeMnemonicForComparison(originalMnemonic);
      const normalizedDecrypted = this.normalizeMnemonicForComparison(decryptedMnemonic);

      if (normalizedOriginal !== normalizedDecrypted) {
        console.error('❌ [Storage] Round-trip verification mismatch', { walletId });

        verificationData.wallets = verificationData.wallets.filter(w => w.metadata.id !== walletId);
        verificationData.walletOrder = verificationData.walletOrder.filter(id => id !== walletId);

        if (verificationData.wallets.length === 0) {
          await chrome.storage.local.remove(['multiWalletData', 'walletVersion']);
        } else {
          if (!verificationData.wallets.some(w => w.metadata.id === verificationData.activeWalletId)) {
            verificationData.activeWalletId = verificationData.wallets[0].metadata.id;
          }

          await chrome.storage.local.set({
            multiWalletData: JSON.stringify(verificationData),
            walletVersion: 1
          });
        }

        throw new Error('Wallet storage verification failed: mnemonic mismatch after write');
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('mnemonic mismatch after write')) {
        throw error;
      }

      console.error('❌ [Storage] Round-trip verification decrypt failed', { walletId, error });

      verificationData.wallets = verificationData.wallets.filter(w => w.metadata.id !== walletId);
      verificationData.walletOrder = verificationData.walletOrder.filter(id => id !== walletId);

      if (verificationData.wallets.length === 0) {
        await chrome.storage.local.remove(['multiWalletData', 'walletVersion']);
      } else {
        if (!verificationData.wallets.some(w => w.metadata.id === verificationData.activeWalletId)) {
          verificationData.activeWalletId = verificationData.wallets[0].metadata.id;
        }

        await chrome.storage.local.set({
          multiWalletData: JSON.stringify(verificationData),
          walletVersion: 1
        });
      }

      throw new Error('Wallet storage verification failed');
    }
  }

  /**
   * Save multiple wallets to storage
   * Each wallet is encrypted individually with unique IV
   */
  async saveWallets(wallets: EncryptedWalletEntry[], activeId: string, pin: string): Promise<void> {
    console.log('🔵 [Storage] SAVE_WALLETS ENTRY', {
      timestamp: new Date().toISOString(),
      walletCount: wallets.length,
      activeId
    });

    try {
      // Validate input
      if (!wallets || wallets.length === 0) {
        throw new Error('Cannot save empty wallet array');
      }

      if (!activeId || !wallets.some(w => w.metadata.id === activeId)) {
        throw new Error('Active wallet ID must match one of the wallet IDs');
      }

      // Create multi-wallet storage structure
      const multiWalletData: MultiWalletStorage = {
        wallets,
        activeWalletId: activeId,
        walletOrder: wallets.map(w => w.metadata.id),
        version: 1
      };

      // Save to storage
      await this.withStorageLock(async () => {
        await chrome.storage.local.set({
          multiWalletData: JSON.stringify(multiWalletData),
          walletVersion: 1
        });
      });

      console.log('✅ [Storage] SAVE_WALLETS SUCCESS', {
        timestamp: new Date().toISOString(),
        walletCount: wallets.length,
        activeId
      });

      // Verify save
      const verification = await chrome.storage.local.get(['multiWalletData', 'walletVersion']);
      console.log('🔍 [Storage] Save verification', {
        dataExists: !!verification.multiWalletData,
        version: verification.walletVersion
      });
    } catch (error) {
      console.error('❌ [Storage] SAVE_WALLETS FAILED', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  /**
   * Load multiple wallets from storage
   * Returns all wallet entries and active wallet ID
   */
  async loadWallets(pin: string): Promise<{ wallets: EncryptedWalletEntry[], activeId: string } | null> {
    console.log('🔵 [Storage] LOAD_WALLETS ENTRY', {
      timestamp: new Date().toISOString()
    });

    try {
      const result = await chrome.storage.local.get(['multiWalletData', 'walletVersion']);

      if (!result.multiWalletData) {
        console.warn('⚠️ [Storage] No multi-wallet data found in storage');
        return null;
      }

      const multiWalletData: MultiWalletStorage = JSON.parse(result.multiWalletData);

      // Validate schema version
      if (multiWalletData.version !== 1) {
        console.error('❌ [Storage] Unsupported wallet schema version', {
          expected: 1,
          actual: multiWalletData.version
        });
        throw new Error(`Unsupported wallet schema version: ${multiWalletData.version}`);
      }

      console.log('✅ [Storage] LOAD_WALLETS SUCCESS', {
        timestamp: new Date().toISOString(),
        walletCount: multiWalletData.wallets.length,
        activeId: multiWalletData.activeWalletId
      });

      return {
        wallets: multiWalletData.wallets,
        activeId: multiWalletData.activeWalletId
      };
    } catch (error) {
      console.error('❌ [Storage] LOAD_WALLETS FAILED', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString()
      });
      return null;
    }
  }

  /**
   * Set the active wallet by ID
   * Updates the activeWalletId in storage
   */
  async setActiveWallet(id: string): Promise<void> {
    console.log('🔵 [Storage] SET_ACTIVE_WALLET', { id });

    try {
      await this.withStorageLock(async () => {
        const result = await chrome.storage.local.get(['multiWalletData']);

        if (!result.multiWalletData) {
          throw new Error('No multi-wallet data found');
        }

        const multiWalletData: MultiWalletStorage = JSON.parse(result.multiWalletData);

        // Validate wallet ID exists
        const wallet = multiWalletData.wallets.find(w => w.metadata.id === id);
        if (!wallet) {
          throw new Error(`Wallet with ID ${id} not found`);
        }

        // Update active wallet ID and lastUsedAt
        multiWalletData.activeWalletId = id;
        wallet.metadata.lastUsedAt = Date.now();

        await chrome.storage.local.set({
          multiWalletData: JSON.stringify(multiWalletData)
        });

        console.log('✅ [Storage] SET_ACTIVE_WALLET SUCCESS', { id });
      });
    } catch (error) {
      console.error('❌ [Storage] SET_ACTIVE_WALLET FAILED', error);
      throw error;
    }
  }

  /**
   * Add a new wallet to the multi-wallet structure
   * Encrypts the mnemonic and adds to storage
   */
  async addWallet(wallet: WalletData, nickname: string, pin: string): Promise<string> {
    console.log('🔵 [Storage] ADD_WALLET', { nickname });

    try {
      const normalizedMnemonic = this.ensureValidBip39Mnemonic(wallet.mnemonic);

      return await this.withStorageLock(async () => {
        // Load existing wallets or initialize empty array
        const result = await chrome.storage.local.get(['multiWalletData', 'walletVersion']);

        // Each wallet can have its own PIN - no need to verify against existing wallets
        console.log('✅ [Storage] ADD_WALLET - Adding wallet with its own PIN');

        // Generate new wallet entry
        const walletId = generateUUID();
        const encryptedMnemonic = await this.encryptMnemonic(normalizedMnemonic, pin);

        const newWallet: EncryptedWalletEntry = {
          metadata: {
            id: walletId,
            nickname,
            createdAt: Date.now(),
            lastUsedAt: Date.now()
          },
          encryptedMnemonic
        };

        let multiWalletData: MultiWalletStorage;

        if (result.multiWalletData) {
          multiWalletData = JSON.parse(result.multiWalletData);
          multiWalletData.wallets.push(newWallet);
          multiWalletData.walletOrder.push(walletId);
        } else {
          // First wallet in multi-wallet structure
          multiWalletData = {
            wallets: [newWallet],
            activeWalletId: walletId,
            walletOrder: [walletId],
            version: 1
          };
        }

        await chrome.storage.local.set({
          multiWalletData: JSON.stringify(multiWalletData),
          walletVersion: 1
        });

        // Verify post-storage round-trip
        await this.verifyStoredMnemonicRoundTrip(walletId, normalizedMnemonic, pin);

        console.log('✅ [Storage] ADD_WALLET SUCCESS', { walletId, nickname });
        return walletId;
      });
    } catch (error) {
      console.error('❌ [Storage] ADD_WALLET FAILED', error);
      throw error;
    }
  }

  /**
   * Remove a wallet from the multi-wallet structure
   * Does not allow removing the last wallet (use deleteAllWallets for that)
   */
  async removeWallet(id: string, pin: string): Promise<void> {
    console.log('🔵 [Storage] REMOVE_WALLET', { id });

    try {
      await this.withStorageLock(async () => {
        const result = await chrome.storage.local.get(['multiWalletData']);

        if (!result.multiWalletData) {
          throw new Error('No multi-wallet data found');
        }

        const multiWalletData: MultiWalletStorage = JSON.parse(result.multiWalletData);

        // Prevent removing the last wallet
        if (multiWalletData.wallets.length === 1) {
          throw new Error('Cannot remove the last wallet. Use deleteAllWallets() instead.');
        }

        // Find and remove the wallet
        const walletIndex = multiWalletData.wallets.findIndex(w => w.metadata.id === id);
        if (walletIndex === -1) {
          throw new Error(`Wallet with ID ${id} not found`);
        }

        multiWalletData.wallets.splice(walletIndex, 1);
        multiWalletData.walletOrder = multiWalletData.walletOrder.filter(wId => wId !== id);

        // If removing active wallet, switch to first remaining wallet
        if (multiWalletData.activeWalletId === id) {
          multiWalletData.activeWalletId = multiWalletData.wallets[0].metadata.id;
          multiWalletData.wallets[0].metadata.lastUsedAt = Date.now();
          console.log('⚠️ [Storage] Removed active wallet, switched to', {
            newActiveId: multiWalletData.activeWalletId
          });
        }

        await chrome.storage.local.set({
          multiWalletData: JSON.stringify(multiWalletData)
        });

        console.log('✅ [Storage] REMOVE_WALLET SUCCESS', { id });
      });
    } catch (error) {
      console.error('❌ [Storage] REMOVE_WALLET FAILED', error);
      throw error;
    }
  }

  /**
   * Decrypt and return the active wallet's full data
   * Used for unlocking and accessing wallet mnemonic
   */
  async getActiveWallet(pin: string): Promise<{ wallet: WalletData, metadata: WalletMetadata } | null> {
    console.log('🔵 [Storage] GET_ACTIVE_WALLET');

    try {
      const walletsData = await this.loadWallets(pin);
      if (!walletsData) {
        return null;
      }

      // Find active wallet
      const activeWallet = walletsData.wallets.find(w => w.metadata.id === walletsData.activeId);
      if (!activeWallet) {
        console.error('❌ [Storage] Active wallet not found in wallet list');
        return null;
      }

      // Decrypt mnemonic
      const mnemonic = await this.decryptMnemonic(activeWallet.encryptedMnemonic, pin);

      // Return wallet data with metadata
      const walletData: WalletData = {
        mnemonic,
        balance: 0,
        transactions: []
      };

      console.log('✅ [Storage] GET_ACTIVE_WALLET SUCCESS', {
        walletId: activeWallet.metadata.id,
        nickname: activeWallet.metadata.nickname
      });

      return {
        wallet: walletData,
        metadata: activeWallet.metadata
      };
    } catch (error) {
      console.error('❌ [Storage] GET_ACTIVE_WALLET FAILED', error);
      return null;
    }
  }

  /**
   * Try to unlock any wallet with the given PIN
   * Iterates through all wallets and returns the first one that successfully decrypts
   * Also sets that wallet as the active wallet
   */
  async tryUnlockAnyWallet(pin: string): Promise<{ wallet: WalletData, metadata: WalletMetadata } | null> {
    console.log('🔵 [Storage] TRY_UNLOCK_ANY_WALLET');

    try {
      const walletsData = await this.loadWallets(''); // Load wallet metadata without decryption
      if (!walletsData || walletsData.wallets.length === 0) {
        console.log('⚠️ [Storage] No wallets found');
        return null;
      }

      console.log(`🔍 [Storage] Trying PIN against ${walletsData.wallets.length} wallet(s)`);

      // Try to decrypt each wallet with the PIN
      for (const walletEntry of walletsData.wallets) {
        try {
          console.log('🔐 [Storage] Trying wallet');
          
          // Attempt to decrypt the mnemonic
          const mnemonic = await this.decryptMnemonic(walletEntry.encryptedMnemonic, pin);
          
          // If we get here, decryption succeeded!
          console.log('✅ [Storage] PIN matched wallet');
          
          // Set this wallet as active
          await this.setActiveWallet(walletEntry.metadata.id);
          
          const walletData: WalletData = {
            mnemonic,
            balance: 0,
            transactions: []
          };

          console.log('✅ [Storage] TRY_UNLOCK_ANY_WALLET SUCCESS', {
            walletId: walletEntry.metadata.id,
            nickname: walletEntry.metadata.nickname
          });

          return {
            wallet: walletData,
            metadata: walletEntry.metadata
          };
        } catch (decryptError) {
          // Decryption failed for this wallet, try the next one
          console.log('❌ [Storage] PIN did not match wallet');
          continue;
        }
      }

      // No wallet matched the PIN
      console.log('❌ [Storage] PIN did not match any wallet');
      return null;
    } catch (error) {
      console.error('❌ [Storage] TRY_UNLOCK_ANY_WALLET FAILED', error);
      return null;
    }
  }

  /**
   * Decrypt and return a specific wallet's full data by ID
   */
  async getWalletById(id: string, pin: string): Promise<{ wallet: WalletData, metadata: WalletMetadata } | null> {
    console.log('🔵 [Storage] GET_WALLET_BY_ID', { id });

    try {
      const walletsData = await this.loadWallets(pin);
      if (!walletsData) {
        return null;
      }

      // Find wallet by ID
      const walletEntry = walletsData.wallets.find(w => w.metadata.id === id);
      if (!walletEntry) {
        console.error('❌ [Storage] Wallet not found', { id });
        return null;
      }

      // Decrypt mnemonic
      const mnemonic = await this.decryptMnemonic(walletEntry.encryptedMnemonic, pin);

      // Return wallet data with metadata
      const walletData: WalletData = {
        mnemonic,
        balance: 0,
        transactions: []
      };

      console.log('✅ [Storage] GET_WALLET_BY_ID SUCCESS', {
        walletId: walletEntry.metadata.id,
        nickname: walletEntry.metadata.nickname
      });

      return {
        wallet: walletData,
        metadata: walletEntry.metadata
      };
    } catch (error) {
      console.error('❌ [Storage] GET_WALLET_BY_ID FAILED', error);
      return null;
    }
  }

  // ========================================
  // Migration Methods
  // ========================================

  /**
   * Check if migration to multi-wallet is needed
   * Returns true if old single-wallet exists and multi-wallet doesn't
   */
  async needsMigration(): Promise<boolean> {
    try {
      const result = await chrome.storage.local.get(['encryptedWallet', 'walletVersion', 'multiWalletData']);

      // Already migrated if walletVersion is 1 or multi-wallet data exists
      if (result.walletVersion === 1 || result.multiWalletData) {
        return false;
      }

      // Needs migration if old single wallet exists
      return !!result.encryptedWallet;
    } catch (error) {
      console.error('❌ [Storage] Failed to check migration status', error);
      return false;
    }
  }

  /**
   * Migrate from single-wallet to multi-wallet structure
   * Converts old encryptedWallet to new multi-wallet format
   *
   * @param pin - User's PIN to decrypt and re-encrypt wallet
   */
  async migrateToMultiWallet(pin: string): Promise<void> {
    console.log('🔵 [Storage] MIGRATE_TO_MULTI_WALLET START', {
      timestamp: new Date().toISOString()
    });

    try {
      // 1. Check if already migrated
      const needsMigration = await this.needsMigration();
      if (!needsMigration) {
        console.log('⚠️ [Storage] Migration not needed or already completed');
        return;
      }

      // 2. Load old single wallet (decrypt it)
      const oldWallet = await this.loadEncryptedWallet(pin);
      if (!oldWallet) {
        throw new Error('Failed to load old wallet for migration');
      }

      console.log('🔍 [Storage] Old wallet loaded successfully', {
        hasMnemonic: !!oldWallet.mnemonic,
        mnemonicWordCount: oldWallet.mnemonic ? oldWallet.mnemonic.split(' ').length : 0
      });

      // 3. Create first wallet entry with encrypted mnemonic
      const walletId = generateUUID();
      const encryptedMnemonic = await this.encryptMnemonic(oldWallet.mnemonic, pin);

      const firstWallet: EncryptedWalletEntry = {
        metadata: {
          id: walletId,
          nickname: 'Wallet 1',
          createdAt: Date.now(),
          lastUsedAt: Date.now()
        },
        encryptedMnemonic
      };

      console.log('🔍 [Storage] First wallet entry created', {
        walletId,
        nickname: firstWallet.metadata.nickname
      });

      // 4. Create multi-wallet storage structure
      const multiWalletData: MultiWalletStorage = {
        wallets: [firstWallet],
        activeWalletId: walletId,
        walletOrder: [walletId],
        version: 1
      };

      // 5. Backup old wallet before migration
      const oldWalletBackup = await chrome.storage.local.get(['encryptedWallet']);

      // 6. Save new multi-wallet structure
      await chrome.storage.local.set({
        multiWalletData: JSON.stringify(multiWalletData),
        walletVersion: 1,
        backup_encryptedWallet: oldWalletBackup.encryptedWallet  // Keep backup for safety
      });

      console.log('✅ [Storage] MIGRATE_TO_MULTI_WALLET SUCCESS', {
        timestamp: new Date().toISOString(),
        walletId,
        backupCreated: true
      });

      // 7. Verify migration
      const verification = await chrome.storage.local.get(['multiWalletData', 'walletVersion']);
      if (!verification.multiWalletData || verification.walletVersion !== 1) {
        throw new Error('Migration verification failed');
      }

      console.log('🔍 [Storage] Migration verified successfully');

    } catch (error) {
      console.error('❌ [Storage] MIGRATE_TO_MULTI_WALLET FAILED', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString()
      });
      throw new Error('Wallet migration failed: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  /**
   * Rollback migration and restore single wallet from backup
   * Emergency function in case migration causes issues
   */
  async rollbackMigration(): Promise<void> {
    console.log('🔵 [Storage] ROLLBACK_MIGRATION START', {
      timestamp: new Date().toISOString()
    });

    try {
      const result = await chrome.storage.local.get(['backup_encryptedWallet']);

      if (!result.backup_encryptedWallet) {
        throw new Error('No backup wallet found to restore');
      }

      // Restore old wallet
      await chrome.storage.local.set({
        encryptedWallet: result.backup_encryptedWallet
      });

      // Remove multi-wallet data
      await chrome.storage.local.remove(['multiWalletData', 'walletVersion']);

      console.log('✅ [Storage] ROLLBACK_MIGRATION SUCCESS', {
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ [Storage] ROLLBACK_MIGRATION FAILED', error);
      throw error;
    }
  }

  /**
   * Check which wallet storage version is active
   * Returns 0 for single-wallet (legacy), 1 for multi-wallet, 2 for hierarchical
   */
  async getWalletVersion(): Promise<number> {
    try {
      const result = await chrome.storage.local.get(['walletVersion', 'multiWalletData', 'encryptedWallet']);

      // Check for hierarchical (v2)
      if (result.multiWalletData) {
        const data = JSON.parse(result.multiWalletData);
        if (data.version === 2) {
          return 2;
        }
      }

      // Check for multi-wallet (v1)
      if (result.walletVersion === 1 || result.multiWalletData) {
        return 1;
      }

      // Check for single wallet (legacy)
      if (result.encryptedWallet) {
        return 0;
      }

      // No wallet exists
      return -1;
    } catch (error) {
      console.error('❌ [Storage] Failed to get wallet version', error);
      return -1;
    }
  }

  // ========================================
  // Hierarchical Multi-Wallet Methods (v2)
  // ========================================

  /**
   * Check if migration to hierarchical (v2) is needed
   * Returns true if v1 multi-wallet exists and v2 doesn't
   */
  async needsHierarchicalMigration(): Promise<boolean> {
    try {
      const result = await chrome.storage.local.get(['multiWalletData']);

      if (!result.multiWalletData) {
        return false;
      }

      const data = JSON.parse(result.multiWalletData);
      return data.version === 1;
    } catch (error) {
      console.error('❌ [Storage] Failed to check hierarchical migration status', error);
      return false;
    }
  }

  /**
   * Get all master key metadata (without decryption)
   * Reads directly from wallet list - each wallet IS a master key
   * No migration needed - just treats existing wallets as master keys
   */
  async getMasterKeyMetadata(): Promise<MasterKeyMetadata[]> {
    console.log('🔵 [Storage] GET_MASTER_KEY_METADATA');
    
    try {
      // Load v1 wallet list directly
      const result = await chrome.storage.local.get(['multiWalletData']);
      
      if (!result.multiWalletData) {
        console.log('⚠️ [Storage] No multiWalletData found');
        return [];
      }

      const data: MultiWalletStorage = JSON.parse(result.multiWalletData);
      
      // Each wallet is treated as a master key
      // Sub-wallets are optional additions to each wallet
      const masterKeys: MasterKeyMetadata[] = data.wallets.map(wallet => ({
        id: wallet.metadata.id,
        nickname: wallet.metadata.nickname,
        createdAt: wallet.metadata.createdAt,
        lastUsedAt: wallet.metadata.lastUsedAt,
        subWalletCount: wallet.subWallets?.length || 0, // Only count actual sub-wallets, not the master
        isExpanded: false // Default collapsed
      }));

      console.log('✅ [Storage] GET_MASTER_KEY_METADATA SUCCESS', {
        count: masterKeys.length
      });

      return masterKeys;
    } catch (error) {
      console.error('❌ [Storage] GET_MASTER_KEY_METADATA FAILED', error);
      return [];
    }
  }

  /**
   * Get sub-wallets for a specific wallet (master key)
   * Returns the wallet itself (index 0) plus any derived sub-wallets
   */
  async getSubWallets(masterKeyId: string, includeArchived: boolean = false): Promise<SubWalletEntry[]> {
    console.log('🔵 [Storage] GET_SUB_WALLETS', { masterKeyId, includeArchived });

    try {
      const result = await chrome.storage.local.get(['multiWalletData']);

      if (!result.multiWalletData) {
        return [];
      }

      const data: MultiWalletStorage = JSON.parse(result.multiWalletData);
      const wallet = data.wallets.find(w => w.metadata.id === masterKeyId);

      if (!wallet) {
        return [];
      }

      // Return only actual sub-wallets (index > 0), not the master wallet itself
      const allSubWallets: SubWalletEntry[] = wallet.subWallets || [];

      // Filter out archived sub-wallets by default
      const subWallets = includeArchived
        ? allSubWallets
        : allSubWallets.filter(sw => !sw.archivedAt);

      console.log('✅ [Storage] GET_SUB_WALLETS SUCCESS', {
        count: subWallets.length,
        includeArchived
      });

      return subWallets;
    } catch (error) {
      console.error('❌ [Storage] GET_SUB_WALLETS FAILED', error);
      return [];
    }
  }

  /**
   * Add a new master key with optional first sub-wallet
   */
  async addMasterKey(
    mnemonic: string,
    nickname: string,
    pin: string,
    _createDefaultSubWallet: boolean = true
  ): Promise<string> {
    console.log('🔵 [Storage] ADD_MASTER_KEY', { nickname });

    const normalizedMnemonic = this.ensureValidBip39Mnemonic(mnemonic);

    // addMasterKey now delegates to addWallet for consistency
    // Sub-wallets are added separately via addSubWallet
    const walletData: WalletData = {
      mnemonic: normalizedMnemonic,
      balance: 0,
      transactions: []
    };

    const walletId = await this.addWallet(walletData, nickname, pin);

    // Explicit verification for master key storage path
    await this.verifyStoredMnemonicRoundTrip(walletId, normalizedMnemonic, pin);

    return walletId;
  }

  /**
   * Add a sub-wallet to an existing wallet (master key)
   * Extends the wallet entry with a sub-wallet that uses a derived mnemonic
   */
  async addSubWallet(masterKeyId: string, nickname: string): Promise<number> {
    console.log('🔵 [Storage] ADD_SUB_WALLET', { masterKeyId, nickname });

    try {
      return await this.withStorageLock(async () => {
      const result = await chrome.storage.local.get(['multiWalletData']);
      
      if (!result.multiWalletData) {
        throw new Error('No wallet data found');
      }

      const data: MultiWalletStorage = JSON.parse(result.multiWalletData);
      const wallet = data.wallets.find(w => w.metadata.id === masterKeyId);
      
      if (!wallet) {
        throw new Error(`Wallet ${masterKeyId} not found`);
      }

      // Initialize subWallets array if it doesn't exist
      if (!wallet.subWallets) {
        wallet.subWallets = [];
      }

      // Check sub-wallet limit (index 0 is the original, so max 19 additional)
      if (wallet.subWallets.length >= HIERARCHICAL_WALLET_CONSTANTS.MAX_SUB_WALLETS - 1) {
        throw new Error(`Maximum of ${HIERARCHICAL_WALLET_CONSTANTS.MAX_SUB_WALLETS - 1} additional sub-wallets allowed`);
      }

      // Find next available index (skip 0 as it's the original wallet)
      const usedIndices = new Set(wallet.subWallets.map(sw => sw.index));
      usedIndices.add(0); // Reserve index 0 for the original wallet
      
      let nextIndex = -1;
      for (let i = 1; i < HIERARCHICAL_WALLET_CONSTANTS.MAX_SUB_WALLETS; i++) {
        if (!usedIndices.has(i)) {
          nextIndex = i;
          break;
        }
      }

      if (nextIndex === -1) {
        throw new Error('No available sub-wallet indices');
      }

      const now = Date.now();
      const newSubWallet: SubWalletEntry = {
        index: nextIndex,
        nickname,
        createdAt: now,
        lastUsedAt: now,
        hasActivity: false  // New sub-wallets start with no activity
      };

      wallet.subWallets.push(newSubWallet);
      wallet.metadata.lastUsedAt = now;

      // Save back to storage
      await chrome.storage.local.set({
        multiWalletData: JSON.stringify(data)
      });

      console.log('✅ [Storage] ADD_SUB_WALLET SUCCESS', { masterKeyId, index: nextIndex, nickname });
      return nextIndex;
      });
    } catch (error) {
      console.error('❌ [Storage] ADD_SUB_WALLET FAILED', error);
      throw error;
    }
  }

  /**
   * Remove a master key and all its sub-wallets
   */
  async removeMasterKey(masterKeyId: string): Promise<void> {
    console.log('🔵 [Storage] REMOVE_MASTER_KEY', { masterKeyId });

    try {
      await this.withStorageLock(async () => {
      const result = await chrome.storage.local.get(['multiWalletData']);

      if (!result.multiWalletData) {
        throw new Error('No wallet data found');
      }

      const data: MultiWalletStorage = JSON.parse(result.multiWalletData);

      // Prevent removing last wallet
      if (data.wallets.length === 1) {
        throw new Error('Cannot remove the last wallet');
      }

      const index = data.wallets.findIndex(w => w.metadata.id === masterKeyId);
      if (index === -1) {
        throw new Error(`Wallet ${masterKeyId} not found`);
      }

      data.wallets.splice(index, 1);
      data.walletOrder = data.walletOrder.filter(id => id !== masterKeyId);

      // If removing active wallet, switch to first remaining
      if (data.activeWalletId === masterKeyId) {
        data.activeWalletId = data.wallets[0].metadata.id;
        data.activeSubWalletIndex = 0;
        console.log('⚠️ [Storage] Removed active wallet, switched to', {
          newActiveWalletId: data.activeWalletId
        });
      }

      await chrome.storage.local.set({
        multiWalletData: JSON.stringify(data)
      });

      console.log('✅ [Storage] REMOVE_MASTER_KEY SUCCESS', { masterKeyId });
      });
    } catch (error) {
      console.error('❌ [Storage] REMOVE_MASTER_KEY FAILED', error);
      throw error;
    }
  }

  /**
   * Remove a sub-wallet from a wallet
   */
  async removeSubWallet(masterKeyId: string, subWalletIndex: number): Promise<void> {
    console.log('🔵 [Storage] REMOVE_SUB_WALLET', { masterKeyId, subWalletIndex });

    try {
      // Cannot remove index 0 (the original wallet)
      if (subWalletIndex === 0) {
        throw new Error('Cannot remove the original wallet (index 0)');
      }

      const result = await chrome.storage.local.get(['multiWalletData']);

      if (!result.multiWalletData) {
        throw new Error('No wallet data found');
      }

      const data: MultiWalletStorage = JSON.parse(result.multiWalletData);
      const wallet = data.wallets.find(w => w.metadata.id === masterKeyId);

      if (!wallet) {
        throw new Error(`Wallet ${masterKeyId} not found`);
      }

      if (!wallet.subWallets || wallet.subWallets.length === 0) {
        throw new Error('Wallet has no sub-wallets to remove');
      }

      const swIndex = wallet.subWallets.findIndex(sw => sw.index === subWalletIndex);
      if (swIndex === -1) {
        throw new Error(`Sub-wallet with index ${subWalletIndex} not found`);
      }

      wallet.subWallets.splice(swIndex, 1);

      // If removing active sub-wallet, switch to original wallet (index 0)
      if (data.activeWalletId === masterKeyId && data.activeSubWalletIndex === subWalletIndex) {
        data.activeSubWalletIndex = 0;
        console.log('⚠️ [Storage] Removed active sub-wallet, switched to index 0');
      }

      await chrome.storage.local.set({
        multiWalletData: JSON.stringify(data)
      });

      console.log('✅ [Storage] REMOVE_SUB_WALLET SUCCESS', { masterKeyId, subWalletIndex });
    } catch (error) {
      console.error('❌ [Storage] REMOVE_SUB_WALLET FAILED', error);
      throw error;
    }
  }

  /**
   * Set the active wallet (master key + sub-wallet)
   */
  async setActiveHierarchicalWallet(masterKeyId: string, subWalletIndex: number): Promise<void> {
    console.log('🔵 [Storage] SET_ACTIVE_HIERARCHICAL_WALLET', { masterKeyId, subWalletIndex });

    try {
      await this.withStorageLock(async () => {
      const result = await chrome.storage.local.get(['multiWalletData']);

      if (!result.multiWalletData) {
        throw new Error('No wallet data found');
      }

      const data: MultiWalletStorage = JSON.parse(result.multiWalletData);
      const wallet = data.wallets.find(w => w.metadata.id === masterKeyId);

      if (!wallet) {
        throw new Error(`Wallet ${masterKeyId} not found`);
      }

      // Validate sub-wallet index exists
      if (subWalletIndex === 0) {
        // Index 0 is always the original wallet (master key)
      } else {
        // Check if sub-wallet exists
        const subWallet = wallet.subWallets?.find(sw => sw.index === subWalletIndex);
        if (!subWallet) {
          throw new Error(`Sub-wallet with index ${subWalletIndex} not found`);
        }
        // Update lastUsedAt for the sub-wallet
        subWallet.lastUsedAt = Date.now();
      }

      // Update active wallet info
      data.activeWalletId = masterKeyId;
      data.activeSubWalletIndex = subWalletIndex;

      // Update lastUsedAt for the wallet
      wallet.metadata.lastUsedAt = Date.now();

      await chrome.storage.local.set({
        multiWalletData: JSON.stringify(data)
      });

      console.log('✅ [Storage] SET_ACTIVE_HIERARCHICAL_WALLET SUCCESS', { masterKeyId, subWalletIndex });
      });
    } catch (error) {
      console.error('❌ [Storage] SET_ACTIVE_HIERARCHICAL_WALLET FAILED', error);
      throw error;
    }
  }

  /**
   * Get the decrypted mnemonic for a master key (wallet)
   */
  async getMasterKeyMnemonic(masterKeyId: string, pin: string): Promise<string> {
    console.log('🔵 [Storage] GET_MASTER_KEY_MNEMONIC', { masterKeyId });

    try {
      const result = await chrome.storage.local.get(['multiWalletData']);

      if (!result.multiWalletData) {
        throw new Error('No wallet data found');
      }

      const data: MultiWalletStorage = JSON.parse(result.multiWalletData);
      const wallet = data.wallets.find(w => w.metadata.id === masterKeyId);

      if (!wallet) {
        throw new Error(`Wallet ${masterKeyId} not found`);
      }

      const mnemonic = await this.decryptMnemonic(wallet.encryptedMnemonic, pin);

      console.log('✅ [Storage] GET_MASTER_KEY_MNEMONIC SUCCESS');
      return mnemonic;
    } catch (error) {
      console.error('❌ [Storage] GET_MASTER_KEY_MNEMONIC FAILED', error);
      throw error;
    }
  }

  /**
   * Try to unlock any wallet with the given PIN
   * Returns the first wallet that successfully decrypts
   */
  async tryUnlockAnyMasterKey(pin: string): Promise<{ masterKeyId: string, mnemonic: string } | null> {
    console.log('🔵 [Storage] TRY_UNLOCK_ANY_MASTER_KEY');

    try {
      const result = await chrome.storage.local.get(['multiWalletData']);

      if (!result.multiWalletData) {
        return null;
      }

      const data: MultiWalletStorage = JSON.parse(result.multiWalletData);

      if (!data.wallets || data.wallets.length === 0) {
        return null;
      }

      // Try the currently active wallet FIRST to preserve sub-wallet selection
      if (data.activeWalletId) {
        const activeWallet = data.wallets.find(w => w.metadata.id === data.activeWalletId);
        if (activeWallet) {
          try {
            const mnemonic = await this.decryptMnemonic(activeWallet.encryptedMnemonic, pin);
            console.log('✅ [Storage] PIN matched active wallet');

            // Keep current sub-wallet index
            const subWalletIndex = data.activeSubWalletIndex ?? 0;
            await this.setActiveHierarchicalWallet(activeWallet.metadata.id, subWalletIndex);

            return { masterKeyId: activeWallet.metadata.id, mnemonic };
          } catch {
            console.log(`[Storage] PIN did not match active wallet, trying others...`);
          }
        }
      }

      // Fall back to trying all wallets if active wallet didn't match
      for (const wallet of data.wallets) {
        // Skip the active wallet (already tried)
        if (wallet.metadata.id === data.activeWalletId) {
          continue;
        }

        try {
          const mnemonic = await this.decryptMnemonic(wallet.encryptedMnemonic, pin);
          console.log('✅ [Storage] PIN matched wallet');

          // Different wallet matched - reset to sub-wallet 0
          await this.setActiveHierarchicalWallet(wallet.metadata.id, 0);

          return { masterKeyId: wallet.metadata.id, mnemonic };
        } catch {
          continue;
        }
      }

      return null;
    } catch (error) {
      console.error('❌ [Storage] TRY_UNLOCK_ANY_MASTER_KEY FAILED', error);
      return null;
    }
  }

  /**
   * Try to unlock a SPECIFIC master key with the given PIN
   * Only validates against the specified wallet, not all wallets
   */
  async tryUnlockSpecificMasterKey(masterKeyId: string, subWalletIndex: number, pin: string): Promise<{ masterKeyId: string, mnemonic: string } | null> {
    console.log('🔵 [Storage] TRY_UNLOCK_SPECIFIC_MASTER_KEY', { masterKeyId, subWalletIndex });

    try {
      const result = await chrome.storage.local.get(['multiWalletData']);

      if (!result.multiWalletData) {
        console.log('❌ [Storage] No multiWalletData found');
        return null;
      }

      const data: MultiWalletStorage = JSON.parse(result.multiWalletData);

      if (!data.wallets || data.wallets.length === 0) {
        console.log('❌ [Storage] No wallets found');
        return null;
      }

      // Find the specific wallet
      const wallet = data.wallets.find(w => w.metadata.id === masterKeyId);
      if (!wallet) {
        console.log(`❌ [Storage] Wallet ${masterKeyId} not found`);
        return null;
      }

      try {
        // Try to decrypt with the provided PIN
        const mnemonic = await this.decryptMnemonic(wallet.encryptedMnemonic, pin);
        console.log('✅ [Storage] PIN matched wallet');

        // Set this as active wallet with the specified sub-wallet index
        await this.setActiveHierarchicalWallet(masterKeyId, subWalletIndex);

        return { masterKeyId, mnemonic };
      } catch (error) {
        console.log('❌ [Storage] PIN did not match wallet');
        return null;
      }
    } catch (error) {
      console.error('❌ [Storage] TRY_UNLOCK_SPECIFIC_MASTER_KEY FAILED', error);
      return null;
    }
  }

  /**
   * Rename a wallet (master key)
   */
  async renameMasterKey(masterKeyId: string, newNickname: string): Promise<void> {
    console.log('🔵 [Storage] RENAME_MASTER_KEY', { masterKeyId, newNickname });

    try {
      await this.withStorageLock(async () => {
        const result = await chrome.storage.local.get(['multiWalletData']);

        if (!result.multiWalletData) {
          throw new Error('No wallet data found');
        }

        const data: MultiWalletStorage = JSON.parse(result.multiWalletData);
        const wallet = data.wallets.find(w => w.metadata.id === masterKeyId);

        if (!wallet) {
          throw new Error(`Wallet ${masterKeyId} not found`);
        }

        wallet.metadata.nickname = newNickname;

        await chrome.storage.local.set({
          multiWalletData: JSON.stringify(data)
        });

        console.log('✅ [Storage] RENAME_MASTER_KEY SUCCESS');
      });
    } catch (error) {
      console.error('❌ [Storage] RENAME_MASTER_KEY FAILED', error);
      throw error;
    }
  }

  /**
   * Rename a sub-wallet
   */
  async renameSubWallet(masterKeyId: string, subWalletIndex: number, newNickname: string): Promise<void> {
    console.log('🔵 [Storage] RENAME_SUB_WALLET', { masterKeyId, subWalletIndex, newNickname });

    try {
      await this.withStorageLock(async () => {
        const result = await chrome.storage.local.get(['multiWalletData']);

        if (!result.multiWalletData) {
          throw new Error('No wallet data found');
        }

        const data: MultiWalletStorage = JSON.parse(result.multiWalletData);
        const wallet = data.wallets.find(w => w.metadata.id === masterKeyId);

        if (!wallet) {
          throw new Error(`Wallet ${masterKeyId} not found`);
        }

        if (!wallet.subWallets) {
          throw new Error('Wallet has no sub-wallets');
        }

        const subWallet = wallet.subWallets.find(sw => sw.index === subWalletIndex);
        if (!subWallet) {
          throw new Error(`Sub-wallet with index ${subWalletIndex} not found`);
        }

        subWallet.nickname = newNickname;

        await chrome.storage.local.set({
          multiWalletData: JSON.stringify(data)
        });

        console.log('✅ [Storage] RENAME_SUB_WALLET SUCCESS');
      });
    } catch (error) {
      console.error('❌ [Storage] RENAME_SUB_WALLET FAILED', error);
      throw error;
    }
  }

  /**
   * Update the hasActivity flag for a sub-wallet
   * Called when we detect transactions on a sub-wallet
   */
  async updateSubWalletActivity(masterKeyId: string, subWalletIndex: number, hasActivity: boolean): Promise<void> {
    console.log('🔵 [Storage] UPDATE_SUB_WALLET_ACTIVITY', { masterKeyId, subWalletIndex, hasActivity });

    try {
      await this.withStorageLock(async () => {
        const result = await chrome.storage.local.get(['multiWalletData']);

        if (!result.multiWalletData) {
          throw new Error('No wallet data found');
        }

        const data: MultiWalletStorage = JSON.parse(result.multiWalletData);
        const wallet = data.wallets.find(w => w.metadata.id === masterKeyId);

        if (!wallet) {
          throw new Error(`Wallet ${masterKeyId} not found`);
        }

        if (!wallet.subWallets) {
          throw new Error('Wallet has no sub-wallets');
        }

        const subWallet = wallet.subWallets.find(sw => sw.index === subWalletIndex);
        if (!subWallet) {
          throw new Error(`Sub-wallet with index ${subWalletIndex} not found`);
        }

        subWallet.hasActivity = hasActivity;

        await chrome.storage.local.set({
          multiWalletData: JSON.stringify(data)
        });

        console.log('✅ [Storage] UPDATE_SUB_WALLET_ACTIVITY SUCCESS');
      });
    } catch (error) {
      console.error('❌ [Storage] UPDATE_SUB_WALLET_ACTIVITY FAILED', error);
      throw error;
    }
  }

  /**
   * Toggle wallet expansion state in UI
   */
  async toggleMasterKeyExpanded(masterKeyId: string): Promise<void> {
    try {
      await this.withStorageLock(async () => {
        const result = await chrome.storage.local.get(['multiWalletData']);

        if (!result.multiWalletData) return;

        const data: MultiWalletStorage = JSON.parse(result.multiWalletData);
        const wallet = data.wallets.find(w => w.metadata.id === masterKeyId);

        if (wallet) {
          wallet.isExpanded = !wallet.isExpanded;

          await chrome.storage.local.set({
            multiWalletData: JSON.stringify(data)
          });
        }
      });
    } catch (error) {
      console.error('❌ [Storage] TOGGLE_MASTER_KEY_EXPANDED FAILED', error);
    }
  }

  /**
   * Add discovered sub-wallets to a wallet
   * Used after sub-wallet discovery to add multiple sub-wallets at once
   *
   * @param masterKeyId - UUID of the wallet
   * @param subWallets - Array of { index, nickname } for discovered wallets
   */
  async addDiscoveredSubWallets(
    masterKeyId: string,
    subWallets: { index: number; nickname: string }[]
  ): Promise<void> {
    console.log('🔵 [Storage] ADD_DISCOVERED_SUB_WALLETS', {
      masterKeyId,
      count: subWallets.length
    });

    try {
      await this.withStorageLock(async () => {
        const result = await chrome.storage.local.get(['multiWalletData']);

        if (!result.multiWalletData) {
          throw new Error('No wallet data found');
        }

        const data: MultiWalletStorage = JSON.parse(result.multiWalletData);
        const wallet = data.wallets.find(w => w.metadata.id === masterKeyId);

        if (!wallet) {
          throw new Error(`Wallet ${masterKeyId} not found`);
        }

        // Initialize subWallets array if it doesn't exist
        if (!wallet.subWallets) {
          wallet.subWallets = [];
        }

        const now = Date.now();

        // Add each discovered sub-wallet if it doesn't already exist
        for (const sw of subWallets) {
          const exists = wallet.subWallets.some(existing => existing.index === sw.index);
          if (!exists) {
            wallet.subWallets.push({
              index: sw.index,
              nickname: sw.nickname,
              createdAt: now,
              lastUsedAt: now
            });
            console.log(`[Storage] Added discovered sub-wallet: index=${sw.index}, name="${sw.nickname}"`);
          } else {
            console.log(`[Storage] Sub-wallet index ${sw.index} already exists, skipping`);
          }
        }

        // Sort sub-wallets by index
        wallet.subWallets.sort((a, b) => a.index - b.index);

        await chrome.storage.local.set({
          multiWalletData: JSON.stringify(data)
        });

        console.log('✅ [Storage] ADD_DISCOVERED_SUB_WALLETS SUCCESS', {
          totalSubWallets: wallet.subWallets.length
        });
      });
    } catch (error) {
      console.error('❌ [Storage] ADD_DISCOVERED_SUB_WALLETS FAILED', error);
      throw error;
    }
  }

  /**
   * Get the active hierarchical wallet info
   * Returns masterKeyId and subWalletIndex of the currently active wallet
   */
  async getActiveHierarchicalWalletInfo(): Promise<{ masterKeyId: string, subWalletIndex: number } | null> {
    try {
      const result = await chrome.storage.local.get(['multiWalletData']);

      if (!result.multiWalletData) {
        return null;
      }

      const data: MultiWalletStorage = JSON.parse(result.multiWalletData);

      if (!data.activeWalletId) {
        return null;
      }

      return {
        masterKeyId: data.activeWalletId,
        subWalletIndex: data.activeSubWalletIndex ?? 0
      };
    } catch (error) {
      console.error('❌ [Storage] GET_ACTIVE_HIERARCHICAL_WALLET_INFO FAILED', error);
      return null;
    }
  }

  /**
   * Get the derived mnemonic for the active hierarchical wallet
   * This derives the sub-wallet mnemonic from the master key based on activeSubWalletIndex
   *
   * @param pin - User's PIN to decrypt the master key
   * @returns Derived mnemonic for the active sub-wallet, or null if not found
   */
  async getActiveHierarchicalWalletMnemonic(pin: string): Promise<{
    mnemonic: string;
    masterKeyId: string;
    subWalletIndex: number;
    masterKeyNickname: string;
    subWalletNickname: string;
  } | null> {
    console.log('🔵 [Storage] GET_ACTIVE_HIERARCHICAL_WALLET_MNEMONIC');

    try {
      const result = await chrome.storage.local.get(['multiWalletData']);

      if (!result.multiWalletData) {
        console.warn('⚠️ [Storage] No wallet data');
        return null;
      }

      const data: MultiWalletStorage = JSON.parse(result.multiWalletData);

      if (!data.activeWalletId) {
        console.warn('⚠️ [Storage] No active wallet');
        return null;
      }

      const wallet = data.wallets.find(w => w.metadata.id === data.activeWalletId);
      if (!wallet) {
        console.error('❌ [Storage] Active wallet not found');
        return null;
      }

      const subWalletIndex = data.activeSubWalletIndex ?? 0;

      // Get sub-wallet nickname
      let subWalletNickname = 'Default';
      if (subWalletIndex > 0 && wallet.subWallets) {
        const subWallet = wallet.subWallets.find(sw => sw.index === subWalletIndex);
        if (subWallet) {
          subWalletNickname = subWallet.nickname;
        }
      }

      // Decrypt the master mnemonic
      const masterMnemonic = await this.decryptMnemonic(wallet.encryptedMnemonic, pin);

      // Derive sub-wallet mnemonic (index 0 = original, index 1-19 = modified)
      const derivedMnemonic = deriveSubWalletMnemonic(masterMnemonic, subWalletIndex);

      console.log('✅ [Storage] GET_ACTIVE_HIERARCHICAL_WALLET_MNEMONIC SUCCESS', {
        masterKeyId: data.activeWalletId,
        subWalletIndex,
        isOriginalMnemonic: subWalletIndex === 0
      });

      return {
        mnemonic: derivedMnemonic,
        masterKeyId: data.activeWalletId,
        subWalletIndex,
        masterKeyNickname: wallet.metadata.nickname,
        subWalletNickname
      };
    } catch (error) {
      console.error('❌ [Storage] GET_ACTIVE_HIERARCHICAL_WALLET_MNEMONIC FAILED', error);
      return null;
    }
  }

  /**
   * Try to unlock any wallet with the given PIN
   * Returns the mnemonic for the active wallet (derived if sub-wallet is active)
   *
   * If a wallet is selected for unlock (via selectedWalletForUnlock in storage),
   * only that specific wallet is validated. Otherwise, iterates through all wallets.
   */
  async tryUnlockAnyWalletUnified(pin: string): Promise<{
    wallet: WalletData;
    metadata: WalletMetadata;
    isHierarchical: boolean;
    hierarchicalInfo?: {
      masterKeyId: string;
      subWalletIndex: number;
      masterKeyNickname: string;
      subWalletNickname: string;
    };
  } | null> {
    console.log('🔵 [Storage] TRY_UNLOCK_ANY_WALLET_UNIFIED');

    try {
      const lockout = await this.checkPinLockout();
      if (lockout.locked) {
        return null;
      }

      // Check if a specific wallet is selected for unlock
      const selectedResult = await chrome.storage.local.get(['selectedWalletForUnlock']);
      const selectedWallet = selectedResult.selectedWalletForUnlock;

      let unlocked: { masterKeyId: string, mnemonic: string } | null;

      if (selectedWallet && selectedWallet.masterKeyId) {
        // A specific wallet is selected - only validate against that wallet
        console.log('🔵 [Storage] Selected wallet found, validating against specific wallet:', selectedWallet);
        unlocked = await this.tryUnlockSpecificMasterKey(
          selectedWallet.masterKeyId,
          selectedWallet.subWalletIndex || 0,
          pin
        );
      } else {
        // No specific wallet selected - try all wallets (legacy behavior)
        console.log('🔵 [Storage] No selected wallet, trying all wallets');
        unlocked = await this.tryUnlockAnyMasterKey(pin);
      }

      if (!unlocked) {
        console.log('❌ [Storage] TRY_UNLOCK_ANY_WALLET_UNIFIED - No wallet matched PIN');
        await this.recordFailedPin();
        return null;
      }

      await this.resetPinAttempts();

      // We already have the decrypted master mnemonic from tryUnlockAnyMasterKey
      // Now get the active wallet info (without decrypting again)
      const result = await chrome.storage.local.get(['multiWalletData']);
      if (!result.multiWalletData) {
        return null;
      }

      const data: MultiWalletStorage = JSON.parse(result.multiWalletData);
      const wallet = data.wallets.find(w => w.metadata.id === unlocked.masterKeyId);
      if (!wallet) {
        return null;
      }

      // Use the active sub-wallet index from storage (already set by tryUnlockAnyMasterKey or tryUnlockSpecificMasterKey)
      const subWalletIndex = data.activeSubWalletIndex ?? 0;

      // Get sub-wallet nickname
      let subWalletNickname = 'Default';
      if (subWalletIndex > 0 && wallet.subWallets) {
        const subWallet = wallet.subWallets.find(sw => sw.index === subWalletIndex);
        if (subWallet) {
          subWalletNickname = subWallet.nickname;
        }
      }

      // Derive sub-wallet mnemonic using the already-decrypted master mnemonic
      // (index 0 = original, index 1-19 = modified)
      const derivedMnemonic = deriveSubWalletMnemonic(unlocked.mnemonic, subWalletIndex);

      const walletData: WalletData = {
        mnemonic: derivedMnemonic,
        balance: 0,
        transactions: []
      };

      // Create metadata for compatibility
      const metadata: WalletMetadata = {
        id: `${unlocked.masterKeyId}:${subWalletIndex}`,
        nickname: subWalletIndex === 0
          ? wallet.metadata.nickname
          : `${wallet.metadata.nickname} > ${subWalletNickname}`,
        createdAt: wallet.metadata.createdAt,
        lastUsedAt: wallet.metadata.lastUsedAt
      };

      // Clear the selected wallet for unlock after successful unlock
      await chrome.storage.local.remove(['selectedWalletForUnlock']);

      console.log('✅ [Storage] TRY_UNLOCK_ANY_WALLET_UNIFIED SUCCESS', {
        masterKeyId: unlocked.masterKeyId,
        subWalletIndex
      });

      return {
        wallet: walletData,
        metadata,
        isHierarchical: true,
        hierarchicalInfo: {
          masterKeyId: unlocked.masterKeyId,
          subWalletIndex,
          masterKeyNickname: wallet.metadata.nickname,
          subWalletNickname
        }
      };
    } catch (error) {
      console.error('❌ [Storage] TRY_UNLOCK_ANY_WALLET_UNIFIED FAILED', error);
      return null;
    }
  }

  // ========================================
  // Wallet Archiving
  // ========================================

  /**
   * Archive a master key (move to archived list without deleting)
   * Does NOT require PIN - useful when user forgot their PIN
   */
  async archiveMasterKey(masterKeyId: string): Promise<void> {
    console.log('🔵 [Storage] ARCHIVE_MASTER_KEY', { masterKeyId });

    try {
      const result = await chrome.storage.local.get(['multiWalletData', 'archivedWallets']);

      if (!result.multiWalletData) {
        throw new Error('No wallet data found');
      }

      const data: MultiWalletStorage = JSON.parse(result.multiWalletData);

      // Prevent archiving last wallet
      if (data.wallets.length === 1) {
        throw new Error('Cannot archive the last wallet');
      }

      // Find the wallet to archive
      const walletIndex = data.wallets.findIndex(w => w.metadata.id === masterKeyId);
      if (walletIndex === -1) {
        throw new Error(`Wallet ${masterKeyId} not found`);
      }

      const walletToArchive = data.wallets[walletIndex];

      // Get or initialize archived wallets list
      const archivedWallets: EncryptedWalletEntry[] = result.archivedWallets
        ? JSON.parse(result.archivedWallets)
        : [];

      // Add archived timestamp
      const archivedEntry = {
        ...walletToArchive,
        archivedAt: Date.now()
      };

      archivedWallets.push(archivedEntry);

      // Remove from active wallets
      data.wallets.splice(walletIndex, 1);
      data.walletOrder = data.walletOrder.filter(id => id !== masterKeyId);

      // If archiving active wallet, switch to first remaining
      if (data.activeWalletId === masterKeyId) {
        data.activeWalletId = data.wallets[0].metadata.id;
        data.activeSubWalletIndex = 0;
        console.log('⚠️ [Storage] Archived active wallet, switched to', {
          newActiveWalletId: data.activeWalletId
        });
      }

      // Save both updates
      await chrome.storage.local.set({
        multiWalletData: JSON.stringify(data),
        archivedWallets: JSON.stringify(archivedWallets)
      });

      console.log('✅ [Storage] ARCHIVE_MASTER_KEY SUCCESS', { masterKeyId });
    } catch (error) {
      console.error('❌ [Storage] ARCHIVE_MASTER_KEY FAILED', error);
      throw error;
    }
  }

  /**
   * Restore an archived master key back to active wallets
   * Does NOT require PIN - wallet remains encrypted
   */
  async restoreArchivedMasterKey(masterKeyId: string): Promise<void> {
    console.log('🔵 [Storage] RESTORE_ARCHIVED_MASTER_KEY', { masterKeyId });

    try {
      const result = await chrome.storage.local.get(['multiWalletData', 'archivedWallets']);

      if (!result.archivedWallets) {
        throw new Error('No archived wallets found');
      }

      const archivedWallets: (EncryptedWalletEntry & { archivedAt?: number })[] = JSON.parse(result.archivedWallets);

      // Find the wallet to restore
      const archivedIndex = archivedWallets.findIndex(w => w.metadata.id === masterKeyId);
      if (archivedIndex === -1) {
        throw new Error(`Archived wallet ${masterKeyId} not found`);
      }

      const walletToRestore = archivedWallets[archivedIndex];

      // Remove archivedAt property before restoring
      delete walletToRestore.archivedAt;

      // Get or initialize multiWalletData
      const data: MultiWalletStorage = result.multiWalletData
        ? JSON.parse(result.multiWalletData)
        : { wallets: [], activeWalletId: '', activeSubWalletIndex: 0, walletOrder: [], version: 2 };

      // Add back to active wallets
      data.wallets.push(walletToRestore);
      data.walletOrder.push(masterKeyId);

      // Remove from archived list
      archivedWallets.splice(archivedIndex, 1);

      // Save both updates
      await chrome.storage.local.set({
        multiWalletData: JSON.stringify(data),
        archivedWallets: JSON.stringify(archivedWallets)
      });

      console.log('✅ [Storage] RESTORE_ARCHIVED_MASTER_KEY SUCCESS', { masterKeyId });
    } catch (error) {
      console.error('❌ [Storage] RESTORE_ARCHIVED_MASTER_KEY FAILED', error);
      throw error;
    }
  }

  /**
   * Get list of archived wallets (metadata only, no decryption)
   */
  async getArchivedWallets(): Promise<(WalletMetadata & { archivedAt?: number })[]> {
    console.log('🔵 [Storage] GET_ARCHIVED_WALLETS');

    try {
      const result = await chrome.storage.local.get(['archivedWallets']);

      if (!result.archivedWallets) {
        return [];
      }

      const archivedWallets: (EncryptedWalletEntry & { archivedAt?: number })[] = JSON.parse(result.archivedWallets);

      // Return metadata only
      const metadata = archivedWallets.map(w => ({
        ...w.metadata,
        archivedAt: w.archivedAt
      }));

      console.log('✅ [Storage] GET_ARCHIVED_WALLETS SUCCESS', { count: metadata.length });
      return metadata;
    } catch (error) {
      console.error('❌ [Storage] GET_ARCHIVED_WALLETS FAILED', error);
      return [];
    }
  }

  /**
   * Permanently delete an archived wallet
   * This is the only way to truly delete a wallet - must be archived first
   */
  async deleteArchivedMasterKey(masterKeyId: string): Promise<void> {
    console.log('🔵 [Storage] DELETE_ARCHIVED_MASTER_KEY', { masterKeyId });

    try {
      const result = await chrome.storage.local.get(['archivedWallets']);

      if (!result.archivedWallets) {
        throw new Error('No archived wallets found');
      }

      const archivedWallets: EncryptedWalletEntry[] = JSON.parse(result.archivedWallets);

      const index = archivedWallets.findIndex(w => w.metadata.id === masterKeyId);
      if (index === -1) {
        throw new Error(`Archived wallet ${masterKeyId} not found`);
      }

      archivedWallets.splice(index, 1);

      await chrome.storage.local.set({
        archivedWallets: JSON.stringify(archivedWallets)
      });

      console.log('✅ [Storage] DELETE_ARCHIVED_MASTER_KEY SUCCESS', { masterKeyId });
    } catch (error) {
      console.error('❌ [Storage] DELETE_ARCHIVED_MASTER_KEY FAILED', error);
      throw error;
    }
  }

  /**
   * Verify PIN against an archived wallet
   * Used to confirm PIN before permanent deletion
   */
  async verifyArchivedWalletPin(masterKeyId: string, pin: string): Promise<boolean> {
    console.log('🔵 [Storage] VERIFY_ARCHIVED_WALLET_PIN', { masterKeyId });

    try {
      const result = await chrome.storage.local.get(['archivedWallets']);

      if (!result.archivedWallets) {
        throw new Error('No archived wallets found');
      }

      const archivedWallets: (EncryptedWalletEntry & { archivedAt?: number })[] = JSON.parse(result.archivedWallets);
      const wallet = archivedWallets.find(w => w.metadata.id === masterKeyId);

      if (!wallet) {
        throw new Error(`Archived wallet ${masterKeyId} not found`);
      }

      // Try to decrypt - if it succeeds, PIN is correct
      await this.decryptMnemonic(wallet.encryptedMnemonic, pin);

      console.log('✅ [Storage] VERIFY_ARCHIVED_WALLET_PIN SUCCESS');
      return true;
    } catch (error) {
      console.error('❌ [Storage] VERIFY_ARCHIVED_WALLET_PIN FAILED', error);
      return false;
    }
  }

  // ========================================
  // Sub-Wallet Archive/Restore Methods
  // ========================================

  /**
   * Archive a sub-wallet (mark as archived, not deleted)
   * The sub-wallet stays in the master key's subWallets array but with archivedAt set
   */
  async archiveSubWallet(masterKeyId: string, subWalletIndex: number): Promise<void> {
    console.log('🔵 [Storage] ARCHIVE_SUB_WALLET', { masterKeyId, subWalletIndex });

    try {
      const result = await chrome.storage.local.get(['multiWalletData']);

      if (!result.multiWalletData) {
        throw new Error('No wallet data found');
      }

      const data: MultiWalletStorage = JSON.parse(result.multiWalletData);
      const wallet = data.wallets.find(w => w.metadata.id === masterKeyId);

      if (!wallet) {
        throw new Error(`Master key ${masterKeyId} not found`);
      }

      if (!wallet.subWallets || wallet.subWallets.length === 0) {
        throw new Error('No sub-wallets found for this master key');
      }

      const subWallet = wallet.subWallets.find(sw => sw.index === subWalletIndex);
      if (!subWallet) {
        throw new Error(`Sub-wallet with index ${subWalletIndex} not found`);
      }

      if (subWallet.archivedAt) {
        throw new Error('Sub-wallet is already archived');
      }

      // Mark as archived
      subWallet.archivedAt = Date.now();

      // If this was the active sub-wallet, switch to another active one
      if (data.activeWalletId === masterKeyId && data.activeSubWalletIndex === subWalletIndex) {
        // Find another active sub-wallet in this master key
        const activeSubWallet = wallet.subWallets.find(sw => !sw.archivedAt && sw.index !== subWalletIndex);
        if (activeSubWallet) {
          data.activeSubWalletIndex = activeSubWallet.index;
        } else {
          // No active sub-wallets left, switch to first wallet's first active sub-wallet
          for (const w of data.wallets) {
            if (w.metadata.id !== masterKeyId) {
              const firstActive = w.subWallets?.find(sw => !sw.archivedAt);
              if (firstActive) {
                data.activeWalletId = w.metadata.id;
                data.activeSubWalletIndex = firstActive.index;
                break;
              } else if (!w.subWallets || w.subWallets.length === 0) {
                // Master key without sub-wallets uses index 0
                data.activeWalletId = w.metadata.id;
                data.activeSubWalletIndex = 0;
                break;
              }
            }
          }
        }
      }

      await chrome.storage.local.set({
        multiWalletData: JSON.stringify(data)
      });

      console.log('✅ [Storage] ARCHIVE_SUB_WALLET SUCCESS', { masterKeyId, subWalletIndex });
    } catch (error) {
      console.error('❌ [Storage] ARCHIVE_SUB_WALLET FAILED', error);
      throw error;
    }
  }

  /**
   * Restore an archived sub-wallet
   */
  async restoreSubWallet(masterKeyId: string, subWalletIndex: number): Promise<void> {
    console.log('🔵 [Storage] RESTORE_SUB_WALLET', { masterKeyId, subWalletIndex });

    try {
      const result = await chrome.storage.local.get(['multiWalletData']);

      if (!result.multiWalletData) {
        throw new Error('No wallet data found');
      }

      const data: MultiWalletStorage = JSON.parse(result.multiWalletData);
      const wallet = data.wallets.find(w => w.metadata.id === masterKeyId);

      if (!wallet) {
        throw new Error(`Master key ${masterKeyId} not found`);
      }

      if (!wallet.subWallets || wallet.subWallets.length === 0) {
        throw new Error('No sub-wallets found for this master key');
      }

      const subWallet = wallet.subWallets.find(sw => sw.index === subWalletIndex);
      if (!subWallet) {
        throw new Error(`Sub-wallet with index ${subWalletIndex} not found`);
      }

      if (!subWallet.archivedAt) {
        throw new Error('Sub-wallet is not archived');
      }

      // Remove archived status
      delete subWallet.archivedAt;

      await chrome.storage.local.set({
        multiWalletData: JSON.stringify(data)
      });

      console.log('✅ [Storage] RESTORE_SUB_WALLET SUCCESS', { masterKeyId, subWalletIndex });
    } catch (error) {
      console.error('❌ [Storage] RESTORE_SUB_WALLET FAILED', error);
      throw error;
    }
  }

  /**
   * Permanently delete an archived sub-wallet
   */
  async deleteArchivedSubWallet(masterKeyId: string, subWalletIndex: number): Promise<void> {
    console.log('🔵 [Storage] DELETE_ARCHIVED_SUB_WALLET', { masterKeyId, subWalletIndex });

    try {
      const result = await chrome.storage.local.get(['multiWalletData']);

      if (!result.multiWalletData) {
        throw new Error('No wallet data found');
      }

      const data: MultiWalletStorage = JSON.parse(result.multiWalletData);
      const wallet = data.wallets.find(w => w.metadata.id === masterKeyId);

      if (!wallet) {
        throw new Error(`Master key ${masterKeyId} not found`);
      }

      if (!wallet.subWallets || wallet.subWallets.length === 0) {
        throw new Error('No sub-wallets found for this master key');
      }

      const subWalletIdx = wallet.subWallets.findIndex(sw => sw.index === subWalletIndex);
      if (subWalletIdx === -1) {
        throw new Error(`Sub-wallet with index ${subWalletIndex} not found`);
      }

      const subWallet = wallet.subWallets[subWalletIdx];
      if (!subWallet.archivedAt) {
        throw new Error('Can only delete archived sub-wallets. Archive first.');
      }

      // Remove from array
      wallet.subWallets.splice(subWalletIdx, 1);

      await chrome.storage.local.set({
        multiWalletData: JSON.stringify(data)
      });

      console.log('✅ [Storage] DELETE_ARCHIVED_SUB_WALLET SUCCESS', { masterKeyId, subWalletIndex });
    } catch (error) {
      console.error('❌ [Storage] DELETE_ARCHIVED_SUB_WALLET FAILED', error);
      throw error;
    }
  }

  /**
   * Get all archived sub-wallets across all master keys
   * Returns sub-wallets with their parent master key info
   */
  async getArchivedSubWallets(): Promise<{
    masterKeyId: string;
    masterKeyNickname: string;
    subWalletIndex: number;
    subWalletNickname: string;
    archivedAt: number;
  }[]> {
    console.log('🔵 [Storage] GET_ARCHIVED_SUB_WALLETS');

    try {
      const result = await chrome.storage.local.get(['multiWalletData']);

      if (!result.multiWalletData) {
        return [];
      }

      const data: MultiWalletStorage = JSON.parse(result.multiWalletData);
      const archivedSubWallets: {
        masterKeyId: string;
        masterKeyNickname: string;
        subWalletIndex: number;
        subWalletNickname: string;
        archivedAt: number;
      }[] = [];

      for (const wallet of data.wallets) {
        if (wallet.subWallets) {
          for (const subWallet of wallet.subWallets) {
            if (subWallet.archivedAt) {
              archivedSubWallets.push({
                masterKeyId: wallet.metadata.id,
                masterKeyNickname: wallet.metadata.nickname,
                subWalletIndex: subWallet.index,
                subWalletNickname: subWallet.nickname,
                archivedAt: subWallet.archivedAt
              });
            }
          }
        }
      }

      console.log('✅ [Storage] GET_ARCHIVED_SUB_WALLETS SUCCESS', { count: archivedSubWallets.length });
      return archivedSubWallets;
    } catch (error) {
      console.error('❌ [Storage] GET_ARCHIVED_SUB_WALLETS FAILED', error);
      return [];
    }
  }
}
