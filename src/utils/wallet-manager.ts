// Wallet Manager - High-level wallet operations and state management
// Combines Breez SDK operations with local storage and state management

import * as bip39 from 'bip39';
import { BreezSDKWrapper, BreezConfig, LnurlPayResult } from './breez-sdk';
import { ChromeStorageManager } from './storage';
import { WalletData, Transaction, UserSettings, HIERARCHICAL_WALLET_CONSTANTS } from '../types';
import { deriveSubWalletMnemonic } from './mnemonic-derivation';

export interface WalletStatus {
  isConnected: boolean;
  isUnlocked: boolean;
  balance: number;
  nodeId?: string;
  channelCount?: number;
  lastSync?: number;
}

export interface WalletSetupOptions {
  mnemonic?: string;
  pin: string;
  network?: 'mainnet' | 'regtest';
  apiKey?: string;
}

export class WalletManager {
  private breezSDK: BreezSDKWrapper;
  private storage: ChromeStorageManager;
  private walletStatus: WalletStatus;

  constructor() {
    this.breezSDK = new BreezSDKWrapper();
    this.storage = new ChromeStorageManager();
    this.walletStatus = {
      isConnected: false,
      isUnlocked: false,
      balance: 0
    };
  }

  /**
   * Initialize wallet with setup options and connect Breez SDK
   */
  async setupWallet(options: WalletSetupOptions): Promise<void> {
    try {
      console.log('WalletManager: Starting wallet setup with Breez SDK');

      // Get user settings
      const settings = await this.storage.getUserSettings();
      console.log('WalletManager: Got user settings:', settings);

      // Generate a proper BIP39 mnemonic if none provided
      const mnemonic = options.mnemonic || this.generateAndValidateMnemonic();
      console.log('WalletManager: Using mnemonic (length):', mnemonic.split(' ').length);

      // Validate mnemonic
      if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error('Invalid mnemonic phrase');
      }

      // Initialize Breez SDK
      console.log('WalletManager: Initializing Breez SDK...');
      await this.breezSDK.initializeSDK();
      console.log('WalletManager: Breez SDK initialized');

      // Prepare Breez SDK configuration
      const breezConfig: BreezConfig = {
        network: options.network || 'mainnet',
        apiKey: options.apiKey || undefined
      };

      // Connect wallet with mnemonic
      console.log('WalletManager: Connecting wallet to Breez SDK...');
      await this.breezSDK.connectWallet(mnemonic, breezConfig);
      console.log('WalletManager: Wallet connected to Breez SDK');

      // Get real balance from Breez SDK
      let balance = 0;
      try {
        balance = await this.breezSDK.getBalance();
        console.log('WalletManager: Retrieved balance:', balance, 'sats');
      } catch (balanceError) {
        console.warn('WalletManager: Could not retrieve balance (new wallet):', balanceError);
        // This is expected for new wallets - balance will be 0
      }

      // Generate LNURL for receiving payments
      let lnurl: string | undefined = undefined;
      try {
        lnurl = await this.breezSDK.receiveLnurlPay();
        console.log('WalletManager: Generated receive LNURL:', lnurl);
      } catch (lnurlError) {
        console.warn('WalletManager: Could not generate LNURL (new wallet):', lnurlError);
        // This may fail for new wallets without channels
      }

      // Create wallet data with real values from Breez SDK
      const walletData: WalletData = {
        mnemonic: mnemonic,
        balance: balance,
        lnurl: lnurl,
        customLNURL: settings.customLNURL,
        transactions: []
      };

      console.log('WalletManager: Saving encrypted wallet data with PIN');

      // Save encrypted wallet data
      await this.storage.saveEncryptedWallet(walletData, options.pin);
      console.log('WalletManager: Wallet data encrypted and saved');

      await this.storage.unlockWallet();
      console.log('WalletManager: Wallet unlocked');

      // Update status with real connection info
      this.walletStatus = {
        isConnected: true,
        isUnlocked: true,
        balance: balance,
        lastSync: Date.now()
      };

      console.log('WalletManager: Wallet setup completed successfully with Breez SDK connected');
    } catch (error) {
      console.error('WalletManager: Wallet setup failed:', error);
      throw new Error(`Wallet setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate and validate a 12-word BIP39 mnemonic with sanity checks.
   * Retries up to 3 times before throwing.
   */
  private generateAndValidateMnemonic(): string {
    const maxAttempts = 3;
    const englishWordSet = new Set(bip39.wordlists.english);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const mnemonic = bip39.generateMnemonic();
      const words = mnemonic.trim().toLowerCase().split(/\s+/);

      const isValid = bip39.validateMnemonic(mnemonic);
      const hasTwelveWords = words.length === 12;
      const hasOnlyEnglishWords = words.every(word => englishWordSet.has(word));
      const hasNoConsecutiveDuplicates = words.every((word, index) => index === 0 || word !== words[index - 1]);

      if (isValid && hasTwelveWords && hasOnlyEnglishWords && hasNoConsecutiveDuplicates) {
        return mnemonic;
      }
    }

    throw new Error('Failed to generate a valid 12-word mnemonic after 3 attempts');
  }

  /**
   * Unlock existing wallet with PIN and optional API key
   */
  async unlockWallet(pin: string, apiKey?: string): Promise<void> {
    try {
      // Load encrypted wallet data
      const walletData = await this.storage.loadEncryptedWallet(pin);
      if (!walletData) {
        throw new Error('Invalid PIN or wallet not found');
      }

      // Connect to Breez SDK with stored mnemonic
      if (walletData.mnemonic) {
        const breezConfig: BreezConfig = {
          network: 'mainnet',
          apiKey: apiKey
        };
        await this.breezSDK.connectWallet(walletData.mnemonic, breezConfig);
      } else {
        throw new Error('No mnemonic found in wallet data');
      }

      // Update wallet status
      await this.updateWalletStatus();
      await this.storage.unlockWallet();

      console.log('Wallet unlocked successfully');
    } catch (error) {
      console.error('Wallet unlock failed:', error);
      throw new Error(`Wallet unlock failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Lock wallet and disconnect
   */
  async lockWallet(): Promise<void> {
    try {
      await this.breezSDK.disconnect();
      await this.storage.lockWallet();
      
      this.walletStatus = {
        isConnected: false,
        isUnlocked: false,
        balance: 0
      };

      console.log('Wallet locked successfully');
    } catch (error) {
      console.error('Wallet lock failed:', error);
      throw new Error(`Wallet lock failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get current wallet status
   */
  async getWalletStatus(): Promise<WalletStatus> {
    try {
      if (this.breezSDK.isWalletConnected()) {
        await this.updateWalletStatus();
      } else {
        // Check if wallet should be unlocked
        const isUnlocked = await this.storage.isWalletUnlocked();
        this.walletStatus.isUnlocked = isUnlocked;
      }

      return { ...this.walletStatus };
    } catch (error) {
      console.error('Failed to get wallet status:', error);
      return { ...this.walletStatus };
    }
  }

  /**
   * Update wallet status from Breez SDK
   */
  private async updateWalletStatus(): Promise<void> {
    try {
      if (!this.breezSDK.isWalletConnected()) {
        this.walletStatus.isConnected = false;
        return;
      }

      const [balance, nodeInfo] = await Promise.all([
        this.breezSDK.getBalance(),
        this.breezSDK.getNodeInfo()
      ]);

      this.walletStatus = {
        isConnected: true,
        isUnlocked: await this.storage.isWalletUnlocked(),
        balance,
        nodeId: nodeInfo.id,
        lastSync: Date.now()
      };
    } catch (error) {
      console.error('Failed to update wallet status:', error);
      this.walletStatus.isConnected = false;
    }
  }

  /**
   * Generate Lightning invoice for receiving payments
   */
  async generateInvoice(amount: number, description: string): Promise<string> {
    this.ensureWalletReady();

    try {
      const settings = await this.storage.getUserSettings();
      const invoice = await this.breezSDK.receivePayment({ amountSats: amount, description, expirySecs: settings.invoiceExpirySecs });
      
      // Update activity timestamp
      await this.storage.updateActivity();
      
      return invoice;
    } catch (error) {
      console.error('Invoice generation failed:', error);
      throw new Error(`Invoice generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Send Lightning payment
   */
  async sendPayment(bolt11: string): Promise<boolean> {
    this.ensureWalletReady();

    try {
      const success = await this.breezSDK.sendPayment({ bolt11 });
      
      if (success) {
        // Update balance and activity
        await this.updateWalletStatus();
        await this.storage.updateActivity();
      }
      
      return success;
    } catch (error) {
      console.error('Payment failed:', error);
      throw new Error(`Payment failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get payment history with caching
   */
  async getPaymentHistory(forceRefresh = false): Promise<Transaction[]> {
    this.ensureWalletReady();

    try {
      const payments = await this.breezSDK.listPayments();
      
      // Update activity timestamp
      await this.storage.updateActivity();
      
      return payments;
    } catch (error) {
      console.error('Failed to get payment history:', error);
      throw new Error(`Payment history retrieval failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get current balance
   */
  async getBalance(): Promise<number> {
    this.ensureWalletReady();

    try {
      const balance = await this.breezSDK.getBalance();
      this.walletStatus.balance = balance;
      
      // Update activity timestamp
      await this.storage.updateActivity();
      
      return balance;
    } catch (error) {
      console.error('Failed to get balance:', error);
      throw new Error(`Balance retrieval failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Parse LNURL for payment information
   */
  async parseLnurl(lnurl: string): Promise<any> {
    this.ensureWalletReady();

    try {
      const parsed = await this.breezSDK.parseLnurl(lnurl);
      
      // Update activity timestamp
      await this.storage.updateActivity();
      
      return parsed;
    } catch (error) {
      console.error('LNURL parsing failed:', error);
      throw new Error(`LNURL parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Pay LNURL with amount and optional comment
   * Returns confirmed payment result - waits for payment to complete before resolving
   */
  async payLnurl(reqData: any, amount: number, comment?: string): Promise<LnurlPayResult> {
    this.ensureWalletReady();

    try {
      const result = await this.breezSDK.payLnurl({ reqData, amountSats: amount, comment });

      if (result.success) {
        // Update balance and activity after confirmed payment
        await this.updateWalletStatus();
        await this.storage.updateActivity();
      }

      return result;
    } catch (error) {
      console.error('LNURL payment failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'LNURL payment failed'
      };
    }
  }

  /**
   * Generate LNURL for receiving payments
   */
  async generateReceiveLnurl(): Promise<string> {
    this.ensureWalletReady();

    try {
      const lnurl = await this.breezSDK.receiveLnurlPay();
      
      // Update activity timestamp
      await this.storage.updateActivity();
      
      return lnurl;
    } catch (error) {
      console.error('LNURL generation failed:', error);
      throw new Error(`LNURL generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate on-chain Bitcoin receive address
   */
  async receiveOnchain(): Promise<string> {
    this.ensureWalletReady();

    try {
      const address = await this.breezSDK.receiveOnchain();
      await this.storage.updateActivity();
      return address;
    } catch (error) {
      console.error('On-chain address generation failed:', error);
      throw new Error(`On-chain address generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Check if wallet has sufficient balance for payment
   */
  async hasSufficientBalance(amount: number): Promise<boolean> {
    try {
      const balance = await this.getBalance();
      return balance >= amount;
    } catch (error) {
      console.error('Failed to check balance:', error);
      return false;
    }
  }

  /**
   * Get node information
   */
  async getNodeInfo(): Promise<any> {
    this.ensureWalletReady();

    try {
      const nodeInfo = await this.breezSDK.getNodeInfo();
      
      // Update activity timestamp
      await this.storage.updateActivity();
      
      return nodeInfo;
    } catch (error) {
      console.error('Failed to get node info:', error);
      throw new Error(`Node info retrieval failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Ensure wallet is ready for operations
   */
  private ensureWalletReady(): void {
    if (!this.breezSDK.isWalletConnected()) {
      throw new Error('Wallet not connected. Please unlock wallet first.');
    }

    if (!this.walletStatus.isUnlocked) {
      throw new Error('Wallet is locked. Please unlock wallet first.');
    }
  }

  /**
   * Get Breez SDK instance (for advanced operations)
   */
  getBreezSDK(): BreezSDKWrapper {
    return this.breezSDK;
  }

  /**
   * Get storage manager instance
   */
  getStorageManager(): ChromeStorageManager {
    return this.storage;
  }

  // ========================================
  // Multi-Wallet Support Methods (Phase 2)
  // ========================================

  /**
   * Create a new wallet with generated mnemonic
   * Generates a 12-word BIP39 mnemonic and adds to wallet storage
   *
   * @param nickname - User-friendly name for the wallet
   * @param pin - User's PIN for encryption
   * @returns Wallet data with mnemonic and initial balance
   */
  async createWallet(nickname: string, pin: string): Promise<WalletData> {
    try {
      console.log('WalletManager: Creating new wallet', { nickname });

      // Generate new BIP39 mnemonic (12 words) with sanity checks
      const mnemonic = this.generateAndValidateMnemonic();
      console.log('WalletManager: Generated new mnemonic');

      // Create wallet data structure
      const walletData: WalletData = {
        mnemonic,
        balance: 0,
        transactions: []
      };

      // Add wallet to storage
      const walletId = await this.storage.addWallet(walletData, nickname, pin);
      console.log('WalletManager: Wallet created successfully', { walletId, nickname });

      return walletData;
    } catch (error) {
      console.error('WalletManager: Wallet creation failed:', error);
      throw new Error(`Wallet creation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Import an existing wallet from mnemonic
   * Validates mnemonic and checks for duplicates before importing
   *
   * @param mnemonic - 12-word BIP39 mnemonic phrase
   * @param nickname - User-friendly name for the wallet
   * @param pin - User's PIN for encryption
   * @returns Wallet data
   */
  async importWallet(mnemonic: string, nickname: string, pin: string): Promise<WalletData> {
    try {
      console.log('WalletManager: Importing wallet', { nickname });

      // Trim and normalize mnemonic
      const normalizedMnemonic = mnemonic.trim().toLowerCase();

      // Validate mnemonic format
      if (!bip39.validateMnemonic(normalizedMnemonic)) {
        throw new Error('Invalid mnemonic phrase. Please check and try again.');
      }

      // Check for duplicate wallet
      const isDuplicate = await this.isDuplicateMnemonic(normalizedMnemonic, pin);
      if (isDuplicate) {
        throw new Error('This wallet has already been imported. Each wallet can only be added once.');
      }

      // Create wallet data structure
      const walletData: WalletData = {
        mnemonic: normalizedMnemonic,
        balance: 0,
        transactions: []
      };

      // Add wallet to storage
      const walletId = await this.storage.addWallet(walletData, nickname, pin);
      console.log('WalletManager: Wallet imported successfully', { walletId, nickname });

      return walletData;
    } catch (error) {
      console.error('WalletManager: Wallet import failed:', error);
      throw new Error(`Wallet import failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Rename a wallet
   * Updates the wallet's nickname in metadata
   *
   * @param walletId - UUID of the wallet to rename
   * @param newNickname - New name for the wallet
   * @param pin - User's PIN for verification
   */
  async renameWallet(walletId: string, newNickname: string, pin: string): Promise<void> {
    try {
      console.log('WalletManager: Renaming wallet', { walletId, newNickname });

      // Validate nickname
      if (!newNickname || newNickname.trim().length === 0) {
        throw new Error('Wallet name cannot be empty');
      }

      if (newNickname.length > 30) {
        throw new Error('Wallet name cannot exceed 30 characters');
      }

      // Load all wallets
      const result = await this.storage.loadWallets(pin);
      if (!result) {
        throw new Error('Failed to load wallets');
      }

      // Find wallet to rename
      const wallet = result.wallets.find(w => w.metadata.id === walletId);
      if (!wallet) {
        throw new Error(`Wallet ${walletId} not found`);
      }

      // Check for duplicate nickname
      const duplicateNickname = result.wallets.some(
        w => w.metadata.id !== walletId && w.metadata.nickname === newNickname.trim()
      );
      if (duplicateNickname) {
        throw new Error(`A wallet named "${newNickname}" already exists`);
      }

      // Update nickname
      const prevNickname = wallet.metadata.nickname;
      wallet.metadata.nickname = newNickname.trim();
      console.log('WalletManager: Nickname updated in-memory', { walletId, prevNickname, newNickname: wallet.metadata.nickname });

      // Save updated wallets
      await this.storage.saveWallets(result.wallets, result.activeId, pin);
      console.log('WalletManager: Wallet renamed successfully', { walletId, newNickname });
    } catch (error) {
      console.error('WalletManager: Wallet rename failed:', error);
      throw new Error(`Wallet rename failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Delete a wallet
   * Removes wallet from storage (prevents deleting the last wallet)
   *
   * @param walletId - UUID of the wallet to delete
   * @param pin - User's PIN for verification
   */
  async deleteWallet(walletId: string, pin: string): Promise<void> {
    try {
      console.log('WalletManager: Deleting wallet', { walletId });

      // Load all wallets to check count
      const result = await this.storage.loadWallets(pin);
      if (!result) {
        throw new Error('Failed to load wallets');
      }

      // Prevent deleting the last wallet
      if (result.wallets.length === 1) {
        throw new Error('Cannot delete the last wallet. At least one wallet must remain.');
      }

      // Remove wallet using storage manager
      await this.storage.removeWallet(walletId, pin);
      console.log('WalletManager: Wallet deleted successfully', { walletId });
    } catch (error) {
      console.error('WalletManager: Wallet deletion failed:', error);
      throw new Error(`Wallet deletion failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Switch to a different wallet
   * Disconnects current SDK, loads new wallet, and prepares for SDK reconnection
   *
   * @param walletId - UUID of the wallet to switch to
   * @param pin - User's PIN to decrypt wallet
   * @returns Wallet data for the new active wallet
   */
  async switchWallet(walletId: string, pin: string): Promise<WalletData> {
    try {
      console.log('WalletManager: Switching to wallet', { walletId });

      // Step 1: Load all wallets to verify walletId exists
      const result = await this.storage.loadWallets(pin);
      if (!result) {
        throw new Error('No wallets found');
      }

      const wallet = result.wallets.find(w => w.metadata.id === walletId);
      if (!wallet) {
        throw new Error(`Wallet ${walletId} not found`);
      }

      // Step 2: Disconnect current SDK if connected
      if (this.breezSDK.isWalletConnected()) {
        console.log('WalletManager: Disconnecting current SDK');
        await this.breezSDK.disconnect();
      }

      // Step 3: Set as active wallet in storage
      await this.storage.setActiveWallet(walletId);

      // Step 4: Get wallet data for SDK reconnection (will be done in popup)
      const walletData = await this.storage.getWalletById(walletId, pin);
      if (!walletData) {
        throw new Error('Failed to load wallet data');
      }

      console.log('WalletManager: Wallet switch prepared', {
        walletId,
        nickname: walletData.metadata.nickname
      });

      // Return wallet data - SDK reconnection will be handled by popup
      return {
        mnemonic: walletData.wallet.mnemonic,
        balance: 0,  // Will be loaded from SDK after reconnection
        transactions: [],
        lnurl: undefined,
        customLNURL: undefined
      };
    } catch (error) {
      console.error('WalletManager: Wallet switch failed:', error);
      throw new Error(`Wallet switch failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get all wallets (metadata only, no mnemonics)
   * Returns wallet metadata for UI display
   *
   * @returns Array of wallet metadata
   */
  async getAllWallets(): Promise<import('../types').WalletMetadata[]> {
    try {
      console.log('WalletManager: Getting all wallets metadata');

      // Load wallets without decrypting mnemonics
      const result = await this.storage.loadWallets('');
      if (!result) {
        console.log('WalletManager: No wallets found');
        return [];
      }

      // Extract metadata only (no mnemonics)
      const metadata = result.wallets.map(w => w.metadata);
      console.log('WalletManager: Retrieved wallet metadata', { count: metadata.length });

      return metadata;
    } catch (error) {
      console.error('WalletManager: Failed to get wallets:', error);
      // Return empty array on error to avoid breaking UI
      return [];
    }
  }

  /**
   * Check if mnemonic already exists (duplicate detection)
   * Derives fingerprint from mnemonic and compares with existing wallets
   *
   * @param mnemonic - Mnemonic to check
   * @param pin - User's PIN to decrypt existing wallets
   * @returns True if duplicate found, false otherwise
   */
  async isDuplicateMnemonic(mnemonic: string, pin: string): Promise<boolean> {
    try {
      console.log('WalletManager: Checking for duplicate mnemonic');

      // Normalize mnemonic for comparison
      const normalizedMnemonic = mnemonic.trim().toLowerCase();

      // Derive fingerprint from input mnemonic
      const inputSeed = await bip39.mnemonicToSeed(normalizedMnemonic);
      const inputHash = await crypto.subtle.digest('SHA-256', inputSeed.slice(0, 32));
      const inputFingerprint = Array.from(new Uint8Array(inputHash.slice(0, 16)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      console.log('WalletManager: Input fingerprint generated', {
        fingerprint: inputFingerprint.substring(0, 8) + '...'
      });

      // Load all wallets
      const result = await this.storage.loadWallets(pin);
      if (!result) {
        console.log('WalletManager: No existing wallets to check');
        return false;
      }

      // Check each wallet for matching fingerprint
      for (const entry of result.wallets) {
        try {
          // Decrypt wallet mnemonic
          const walletData = await this.storage.getWalletById(entry.metadata.id, pin);
          if (!walletData) continue;

          // Derive fingerprint from wallet mnemonic
          const walletSeed = await bip39.mnemonicToSeed(walletData.wallet.mnemonic);
          const walletHash = await crypto.subtle.digest('SHA-256', walletSeed.slice(0, 32));
          const walletFingerprint = Array.from(new Uint8Array(walletHash.slice(0, 16)))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

          // Compare fingerprints
          if (inputFingerprint === walletFingerprint) {
            console.log('WalletManager: Duplicate mnemonic found', {
              walletId: entry.metadata.id,
              nickname: entry.metadata.nickname
            });
            return true;
          }
        } catch (error) {
          console.warn('WalletManager: Failed to check wallet', {
            walletId: entry.metadata.id,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          // Continue checking other wallets
        }
      }

      console.log('WalletManager: No duplicate found');
      return false;
    } catch (error) {
      console.error('WalletManager: Duplicate check failed:', error);
      // Return false to allow operation to proceed (better than blocking on error)
      return false;
    }
  }

  // ========================================
  // Hierarchical Multi-Wallet Methods (v2)
  // ========================================

  /**
   * Get the current wallet storage version
   * @returns 0 = legacy single, 1 = flat multi-wallet, 2 = hierarchical
   */
  async getWalletVersion(): Promise<number> {
    return this.storage.getWalletVersion();
  }

  /**
   * Get all master key metadata (without decryption)
   */
  async getMasterKeyMetadata(): Promise<import('../types').MasterKeyMetadata[]> {
    return this.storage.getMasterKeyMetadata();
  }

  /**
   * Get sub-wallets for a specific master key
   * @param masterKeyId - The master key ID to get sub-wallets for
   * @param includeArchived - Whether to include archived sub-wallets (default: false)
   */
  async getSubWallets(masterKeyId: string, includeArchived: boolean = false): Promise<import('../types').SubWalletEntry[]> {
    return this.storage.getSubWallets(masterKeyId, includeArchived);
  }

  /**
   * Add a new master key with mnemonic
   */
  async addMasterKey(
    mnemonic: string,
    nickname: string,
    pin: string,
    createDefaultSubWallet: boolean = true
  ): Promise<string> {
    return this.storage.addMasterKey(mnemonic, nickname, pin, createDefaultSubWallet);
  }

  /**
   * Add a sub-wallet to an existing master key
   */
  async addSubWallet(masterKeyId: string, nickname: string): Promise<number> {
    return this.storage.addSubWallet(masterKeyId, nickname);
  }

  /**
   * Remove a master key and all its sub-wallets
   */
  async removeMasterKey(masterKeyId: string): Promise<void> {
    return this.storage.removeMasterKey(masterKeyId);
  }

  /**
   * Remove a sub-wallet from a master key
   */
  async removeSubWallet(masterKeyId: string, subWalletIndex: number): Promise<void> {
    return this.storage.removeSubWallet(masterKeyId, subWalletIndex);
  }

  /**
   * Set the active wallet (master key + sub-wallet)
   */
  async setActiveHierarchicalWallet(masterKeyId: string, subWalletIndex: number): Promise<void> {
    return this.storage.setActiveHierarchicalWallet(masterKeyId, subWalletIndex);
  }

  /**
   * Rename a master key
   */
  async renameMasterKey(masterKeyId: string, newNickname: string): Promise<void> {
    return this.storage.renameMasterKey(masterKeyId, newNickname);
  }

  /**
   * Rename a sub-wallet
   */
  async renameSubWallet(masterKeyId: string, subWalletIndex: number, newNickname: string): Promise<void> {
    return this.storage.renameSubWallet(masterKeyId, subWalletIndex, newNickname);
  }

  /**
   * Toggle master key expansion state in UI
   */
  async toggleMasterKeyExpanded(masterKeyId: string): Promise<void> {
    return this.storage.toggleMasterKeyExpanded(masterKeyId);
  }

  /**
   * Check if migration to hierarchical (v2) is needed
   */
  async needsHierarchicalMigration(): Promise<boolean> {
    return this.storage.needsHierarchicalMigration();
  }

  /**
   * Get the derived mnemonic for a specific hierarchical wallet
   * This is used when switching wallets to get the correct mnemonic for SDK connection
   *
   * @param masterKeyId - The master key ID
   * @param subWalletIndex - The sub-wallet index (0-19)
   * @param pin - User's PIN to decrypt the master key
   * @returns Derived mnemonic for the sub-wallet
   */
  async getHierarchicalWalletMnemonic(
    masterKeyId: string,
    subWalletIndex: number,
    pin: string
  ): Promise<string> {
    // Get the master key mnemonic
    const masterMnemonic = await this.storage.getMasterKeyMnemonic(masterKeyId, pin);

    // Derive the sub-wallet mnemonic
    return deriveSubWalletMnemonic(masterMnemonic, subWalletIndex);
  }

  /**
   * Switch to a specific hierarchical wallet (master key + sub-wallet)
   * Returns the derived mnemonic for SDK connection
   *
   * @param masterKeyId - The master key ID
   * @param subWalletIndex - The sub-wallet index (0-19)
   * @param pin - User's PIN to decrypt the master key
   * @returns Object with derived mnemonic and wallet info
   */
  async switchHierarchicalWallet(
    masterKeyId: string,
    subWalletIndex: number,
    pin: string
  ): Promise<{
    mnemonic: string;
    masterKeyNickname: string;
    subWalletNickname: string;
  }> {
    console.log('WalletManager: Switching to hierarchical wallet', { masterKeyId, subWalletIndex });

    try {
      // Step 1: Disconnect current SDK if connected
      if (this.breezSDK.isWalletConnected()) {
        console.log('WalletManager: Disconnecting current SDK');
        await this.breezSDK.disconnect();
      }

      // Step 2: Get derived mnemonic (this validates the PIN)
      const derivedMnemonic = await this.getHierarchicalWalletMnemonic(
        masterKeyId,
        subWalletIndex,
        pin
      );

      // Step 3: Get wallet info for display
      const subWallets = await this.storage.getSubWallets(masterKeyId);
      const masterKeys = await this.storage.getMasterKeyMetadata();
      const masterKey = masterKeys.find(mk => mk.id === masterKeyId);
      const subWallet = subWallets.find(sw => sw.index === subWalletIndex);

      // Step 4: ONLY NOW set as active in storage (after successful PIN validation)
      await this.storage.setActiveHierarchicalWallet(masterKeyId, subWalletIndex);

      console.log('WalletManager: Hierarchical wallet switch prepared', {
        masterKeyId,
        subWalletIndex,
        masterKeyNickname: masterKey?.nickname,
        subWalletNickname: subWallet?.nickname
      });

      return {
        mnemonic: derivedMnemonic,
        masterKeyNickname: masterKey?.nickname || 'Unknown',
        subWalletNickname: subWallet?.nickname || 'Unknown'
      };
    } catch (error) {
      console.error('WalletManager: Hierarchical wallet switch failed:', error);
      throw new Error(
        `Wallet switch failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get the active hierarchical wallet info
   */
  async getActiveHierarchicalWalletInfo(): Promise<{
    masterKeyId: string;
    subWalletIndex: number;
  } | null> {
    return this.storage.getActiveHierarchicalWalletInfo();
  }

  /**
   * Add discovered sub-wallets to a master key
   */
  async addDiscoveredSubWallets(
    masterKeyId: string,
    subWallets: { index: number; nickname: string }[]
  ): Promise<void> {
    return this.storage.addDiscoveredSubWallets(masterKeyId, subWallets);
  }

  /**
   * Discover sub-wallets with transaction history for a master mnemonic
   * Scans sub-wallet indices (1, 2, 3...) until finding one with no transactions
   *
   * @param masterMnemonic - The 12-word master mnemonic
   * @param onProgress - Optional callback for progress updates
   * @returns Array of discovered sub-wallet indices that have transactions
   */
  async discoverSubWallets(
    masterMnemonic: string,
    onProgress?: (index: number, found: number) => void
  ): Promise<{ index: number; transactionCount: number; balanceSats: number }[]> {
    console.log('WalletManager: Starting sub-wallet discovery...');

    const discoveredWallets: { index: number; transactionCount: number; balanceSats: number }[] = [];
    const maxIndex = HIERARCHICAL_WALLET_CONSTANTS.MAX_SUB_WALLETS;
    let consecutiveEmpty = 0;
    const MAX_CONSECUTIVE_EMPTY = 3; // Stop after 3 consecutive empty wallets

    // Start from index 1 (index 0 is the master wallet itself)
    for (let index = 1; index < maxIndex; index++) {
      try {
        // Derive the mnemonic for this sub-wallet index
        const derivedMnemonic = deriveSubWalletMnemonic(masterMnemonic, index);

        console.log(`WalletManager: Checking sub-wallet index ${index}...`);
        onProgress?.(index, discoveredWallets.length);

        // Check if this wallet has any activity (balance or transactions)
        const { hasTransactions, transactionCount, balanceSats } =
          await this.breezSDK.checkWalletHasTransactions(derivedMnemonic);

        console.log(`WalletManager: Sub-wallet ${index} result:`, {
          hasActivity: hasTransactions,
          transactions: transactionCount,
          balance: balanceSats
        });

        if (hasTransactions) {
          console.log(`WalletManager: Found sub-wallet ${index} with activity (balance: ${balanceSats} sats, ${transactionCount} payments)`);
          discoveredWallets.push({ index, transactionCount, balanceSats });
          consecutiveEmpty = 0; // Reset counter
        } else {
          consecutiveEmpty++;
          console.log(`WalletManager: Sub-wallet ${index} has no activity (${consecutiveEmpty}/${MAX_CONSECUTIVE_EMPTY} consecutive empty)`);

          // Stop after N consecutive empty wallets
          if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
            console.log(`WalletManager: Stopping discovery after ${MAX_CONSECUTIVE_EMPTY} consecutive empty wallets`);
            break;
          }
        }
      } catch (error) {
        console.error(`WalletManager: Error checking sub-wallet ${index}:`, error);
        consecutiveEmpty++;
        // Continue to next index instead of stopping immediately
        if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
          console.log('WalletManager: Too many errors, stopping discovery');
          break;
        }
      }
    }

    console.log(`WalletManager: Discovery complete. Found ${discoveredWallets.length} sub-wallets with activity`);
    return discoveredWallets;
  }

  /**
   * Import a master wallet and automatically discover/restore any sub-wallets
   * that have transaction history
   *
   * NOTE: Sub-wallet discovery is currently disabled because Breez SDK WASM
   * requires DOM access which is not available in the background service worker.
   * The wallet will be imported without scanning for sub-wallets.
   *
   * @param mnemonic - The 12-word mnemonic to import
   * @param nickname - Nickname for the master wallet
   * @param pin - PIN for encryption
   * @param onProgress - Optional callback for discovery progress
   * @returns Object with master key ID and discovered sub-wallets count
   */
  async importWalletWithDiscovery(
    mnemonic: string,
    nickname: string,
    pin: string,
    onProgress?: (status: string, index?: number, found?: number) => void
  ): Promise<{ masterKeyId: string; discoveredCount: number }> {
    console.log('WalletManager: Importing wallet...');

    const normalizedMnemonic = mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
    if (!bip39.validateMnemonic(normalizedMnemonic)) {
      throw new Error('Invalid mnemonic phrase. Please check and try again.');
    }

    // Step 1: Add the master key
    onProgress?.('Creating master wallet...');
    const masterKeyId = await this.addMasterKey(normalizedMnemonic, nickname, pin, false);
    console.log(`WalletManager: Master key created: ${masterKeyId}`);

    // NOTE: Sub-wallet discovery is disabled because Breez SDK WASM requires DOM access
    // which is not available in the background service worker context.
    // Users can manually add sub-wallets after import if needed.
    console.log('WalletManager: Sub-wallet discovery skipped (requires DOM - not available in background)');

    onProgress?.('Import complete!');
    return { masterKeyId, discoveredCount: 0 };
  }
}
