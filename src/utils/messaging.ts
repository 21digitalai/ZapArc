// Messaging utilities for Chrome Extension communication
// Handles message passing between background, content scripts, and popup

import { UserSettings, WalletData, Transaction } from '../types';

export interface MessageResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

export class ExtensionMessaging {
  /**
   * Send message to background script
   */
  static async sendToBackground<T = any>(message: any): Promise<MessageResponse<T>> {
    console.log('🔵 [ExtensionMessaging] SENDING MESSAGE', {
      messageType: message.type,
      timestamp: new Date().toISOString()
    });
    
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          console.error('❌ [ExtensionMessaging] CHROME RUNTIME ERROR', {
            error: chrome.runtime.lastError.message,
            messageType: message.type,
            timestamp: new Date().toISOString()
          });
          resolve({
            success: false,
            error: chrome.runtime.lastError.message
          });
        } else {
          console.log('🟢 [ExtensionMessaging] MESSAGE RESPONSE', {
            messageType: message.type,
            timestamp: new Date().toISOString()
          });
          resolve(response || { success: false, error: 'No response' });
        }
      });
    });
  }

  /**
   * Send message to content script
   */
  static async sendToContentScript<T = any>(tabId: number, message: any): Promise<MessageResponse<T>> {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            success: false,
            error: chrome.runtime.lastError.message
          });
        } else {
          resolve(response || { success: false, error: 'No response' });
        }
      });
    });
  }

  /**
   * Generate a new mnemonic phrase
   */
  static async generateMnemonic(): Promise<MessageResponse<string>> {
    return this.sendToBackground({
      type: 'GENERATE_MNEMONIC'
    });
  }

  /**
   * Setup new wallet with mnemonic and PIN
   */
  static async setupWallet(mnemonic: string | undefined, pin: string, network: 'mainnet' | 'testnet' = 'mainnet'): Promise<MessageResponse> {
    return this.sendToBackground({
      type: 'SETUP_WALLET',
      mnemonic,
      pin,
      network
    });
  }

  /**
   * Unlock existing wallet with PIN
   */
  static async unlockWallet(pin: string): Promise<MessageResponse> {
    return this.sendToBackground({
      type: 'UNLOCK_WALLET',
      pin
    });
  }

  /**
   * Get wallet status
   */
  static async getWalletStatus(): Promise<MessageResponse<any>> {
    return this.sendToBackground({
      type: 'GET_WALLET_STATUS'
    });
  }

  /**
   * Get wallet balance
   */
  static async getBalance(): Promise<MessageResponse<number>> {
    return this.sendToBackground({
      type: 'GET_BALANCE'
    });
  }

  /**
   * Generate Lightning invoice
   */
  static async generateInvoice(amount: number, description: string): Promise<MessageResponse<string>> {
    return this.sendToBackground({
      type: 'GENERATE_INVOICE',
      amount,
      description
    });
  }

  /**
   * Send Lightning payment
   */
  static async sendPayment(bolt11: string): Promise<MessageResponse<boolean>> {
    return this.sendToBackground({
      type: 'SEND_PAYMENT',
      bolt11
    });
  }

  /**
   * Get payment history
   */
  static async listPayments(forceRefresh = false): Promise<MessageResponse<Transaction[]>> {
    return this.sendToBackground({
      type: 'LIST_PAYMENTS',
      forceRefresh
    });
  }

  /**
   * Check if wallet has sufficient balance
   */
  static async checkSufficientBalance(amount: number): Promise<MessageResponse<boolean>> {
    return this.sendToBackground({
      type: 'CHECK_SUFFICIENT_BALANCE',
      amount
    });
  }

  /**
   * Parse LNURL
   */
  static async parseLnurl(lnurl: string): Promise<MessageResponse<any>> {
    return this.sendToBackground({
      type: 'PARSE_LNURL',
      lnurl
    });
  }

  /**
   * Pay LNURL - waits for payment confirmation before resolving
   * Returns rich payment result with transaction details
   */
  static async payLnurl(reqData: any, amount: number, comment?: string): Promise<MessageResponse<{
    success: boolean;
    paymentId?: string;
    paymentHash?: string;
    preimage?: string;
    amountSats?: number;
    feeSats?: number;
    successAction?: {
      type: 'message' | 'url' | 'aes';
      message?: string;
      url?: string;
      description?: string;
    };
    error?: string;
  }>> {
    return this.sendToBackground({
      type: 'PAY_LNURL',
      reqData,
      amount,
      comment
    });
  }

  /**
   * Generate LNURL for receiving
   */
  static async generateLnurl(): Promise<MessageResponse<string>> {
    return this.sendToBackground({
      type: 'GENERATE_LNURL'
    });
  }

  /**
   * Get node information
   */
  static async getNodeInfo(): Promise<MessageResponse<any>> {
    return this.sendToBackground({
      type: 'GET_NODE_INFO'
    });
  }

  /**
   * Save encrypted wallet data
   */
  static async saveWallet(walletData: WalletData, pin: string): Promise<MessageResponse> {
    return this.sendToBackground({
      type: 'SAVE_WALLET',
      walletData,
      pin
    });
  }

  /**
   * Load encrypted wallet data
   */
  static async loadWallet(pin: string): Promise<MessageResponse<WalletData>> {
    return this.sendToBackground({
      type: 'LOAD_WALLET',
      pin
    });
  }

  /**
   * Get master mnemonic for a specific wallet by ID
   */
  static async getMasterMnemonic(masterKeyId: string, pin: string): Promise<MessageResponse<{ mnemonic: string }>> {
    return this.sendToBackground({
      type: 'GET_MASTER_MNEMONIC',
      masterKeyId,
      pin
    });
  }

  /**
   * Save domain settings
   */
  static async saveDomainSettings(domain: string, status: string): Promise<MessageResponse> {
    return this.sendToBackground({
      type: 'SAVE_DOMAIN_SETTINGS',
      domain,
      status
    });
  }

  /**
   * Get domain settings
   */
  static async getDomainSettings(): Promise<MessageResponse<any>> {
    return this.sendToBackground({
      type: 'GET_DOMAIN_SETTINGS'
    });
  }

  /**
   * Save LNURL blacklist
   */
  static async saveBlacklist(lnurls: string[]): Promise<MessageResponse> {
    return this.sendToBackground({
      type: 'SAVE_BLACKLIST',
      lnurls
    });
  }

  /**
   * Get LNURL blacklist
   */
  static async getBlacklist(): Promise<MessageResponse<any>> {
    return this.sendToBackground({
      type: 'GET_BLACKLIST'
    });
  }

  /**
   * Get user settings
   */
  static async getUserSettings(): Promise<MessageResponse<UserSettings>> {
    return this.sendToBackground({
      type: 'GET_USER_SETTINGS'
    });
  }

  /**
   * Save user settings
   */
  static async saveUserSettings(settings: UserSettings): Promise<MessageResponse> {
    return this.sendToBackground({
      type: 'SAVE_USER_SETTINGS',
      settings
    });
  }

  /**
   * Check if wallet is unlocked
   */
  static async isWalletUnlocked(): Promise<MessageResponse<boolean>> {
    return this.sendToBackground({
      type: 'IS_WALLET_UNLOCKED'
    });
  }

  /**
   * Lock wallet
   */
  static async lockWallet(): Promise<MessageResponse> {
    return this.sendToBackground({
      type: 'LOCK_WALLET'
    });
  }

  /**
   * Check if wallet is connected
   */
  static async isWalletConnected(): Promise<MessageResponse<boolean>> {
    return this.sendToBackground({
      type: 'IS_WALLET_CONNECTED'
    });
  }

  /**
   * Check if wallet exists (has been set up)
   */
  static async walletExists(): Promise<MessageResponse<boolean>> {
    return this.sendToBackground({
      type: 'WALLET_EXISTS'
    });
  }

  /**
   * Get LNURL payment limits
   */
  static async getLnurlPaymentLimits(lnurl: string): Promise<MessageResponse<any>> {
    return this.sendToBackground({
      type: 'GET_LNURL_PAYMENT_LIMITS',
      lnurl
    });
  }

  /**
   * Check if comment is allowed for LNURL
   */
  static async isCommentAllowed(lnurl: string): Promise<MessageResponse<any>> {
    return this.sendToBackground({
      type: 'IS_COMMENT_ALLOWED',
      lnurl
    });
  }

  /**
   * Extract LNURL from various formats
   */
  static async extractLnurl(input: string): Promise<MessageResponse<string>> {
    return this.sendToBackground({
      type: 'EXTRACT_LNURL',
      input
    });
  }

  /**
   * Add LNURL to blacklist
   */
  static async addToBlacklist(lnurl: string): Promise<MessageResponse> {
    return this.sendToBackground({
      type: 'ADD_TO_BLACKLIST',
      lnurl
    });
  }

  /**
   * Remove LNURL from blacklist
   */
  static async removeFromBlacklist(lnurl: string): Promise<MessageResponse> {
    return this.sendToBackground({
      type: 'REMOVE_FROM_BLACKLIST',
      lnurl
    });
  }

  /**
   * Clear entire blacklist
   */
  static async clearBlacklist(): Promise<MessageResponse> {
    return this.sendToBackground({
      type: 'CLEAR_BLACKLIST'
    });
  }

  /**
   * Set domain status
   */
  static async setDomainStatus(domain: string, status: string): Promise<MessageResponse> {
    return this.sendToBackground({
      type: 'SET_DOMAIN_STATUS',
      domain,
      status
    });
  }

  /**
   * Get domain status
   */
  static async getDomainStatus(domain: string): Promise<MessageResponse<string>> {
    return this.sendToBackground({
      type: 'GET_DOMAIN_STATUS',
      domain
    });
  }

  /**
   * Get all domain settings
   */
  static async getAllDomains(): Promise<MessageResponse<any>> {
    return this.sendToBackground({
      type: 'GET_ALL_DOMAINS'
    });
  }

  /**
   * Process payment with enhanced error handling and retry logic
   */
  static async processPayment(
    lnurlData: any, 
    amount: number, 
    comment?: string
  ): Promise<MessageResponse<{ transactionId?: string; retryable?: boolean }>> {
    return this.sendToBackground({
      type: 'PROCESS_PAYMENT',
      lnurlData,
      amount,
      comment
    });
  }

  /**
   * Generate QR code data for Lightning payment
   */
  static async generateQRCode(
    lnurl: string, 
    amount?: number, 
    comment?: string
  ): Promise<MessageResponse<string>> {
    return this.sendToBackground({
      type: 'GENERATE_QR_CODE',
      lnurl,
      amount,
      comment
    });
  }

  /**
   * Generate Lightning URI for QR codes (works without Breez SDK)
   */
  static generateLightningURI(lnurl: string, amount?: number, comment?: string): string {
    let uri = `lightning:${lnurl.toUpperCase()}`;
    
    const params = [];
    if (amount && amount > 0) {
      params.push(`amount=${amount * 1000}`); // Convert sats to millisats
    }
    if (comment) {
      params.push(`message=${encodeURIComponent(comment)}`);
    }
    
    if (params.length > 0) {
      uri += `?${params.join('&')}`;
    }
    
    return uri;
  }

  // Facebook Group Management Functions

  /**
   * Add Facebook group to allowed list
   */
  static async addFacebookGroup(groupId: string): Promise<MessageResponse> {
    return this.sendToBackground({
      type: 'ADD_FACEBOOK_GROUP',
      groupId
    });
  }

  /**
   * Remove Facebook group from allowed list
   */
  static async removeFacebookGroup(groupId: string): Promise<MessageResponse> {
    return this.sendToBackground({
      type: 'REMOVE_FACEBOOK_GROUP',
      groupId
    });
  }

  /**
   * Get Facebook group settings
   */
  static async getFacebookGroupSettings(): Promise<MessageResponse<{
    postingMode: 'global' | 'selective';
    allowedGroups: string[];
    deniedGroups: string[];
  }>> {
    return this.sendToBackground({
      type: 'GET_FACEBOOK_GROUP_SETTINGS'
    });
  }

  /**
   * Set Facebook posting mode
   */
  static async setFacebookPostingMode(mode: 'global' | 'selective'): Promise<MessageResponse> {
    return this.sendToBackground({
      type: 'SET_FACEBOOK_POSTING_MODE',
      mode
    });
  }

  /**
   * Check if Facebook group is allowed for posting
   */
  static async isFacebookGroupAllowed(groupId: string): Promise<MessageResponse<boolean>> {
    return this.sendToBackground({
      type: 'IS_FACEBOOK_GROUP_ALLOWED',
      groupId
    });
  }

  /**
   * Add Facebook group to denied list (when user clicks "No" on prompt)
   */
  static async denyFacebookGroup(groupId: string): Promise<MessageResponse> {
    return this.sendToBackground({
      type: 'DENY_FACEBOOK_GROUP',
      groupId
    });
  }

  /**
   * Clear all Facebook groups (both allowed and denied)
   */
  static async clearAllFacebookGroups(): Promise<MessageResponse> {
    return this.sendToBackground({
      type: 'CLEAR_ALL_FACEBOOK_GROUPS'
    });
  }

  /**
   * Detect Facebook group ID from current page
   */
  static async detectFacebookGroupId(): Promise<MessageResponse<string | null>> {
    return this.sendToBackground({
      type: 'DETECT_FACEBOOK_GROUP_ID'
    });
  }

  /**
   * Show Facebook group prompt for new group
   */
  static async showFacebookGroupPrompt(groupId: string): Promise<MessageResponse<'allow' | 'deny' | 'cancel'>> {
    return this.sendToBackground({
      type: 'SHOW_FACEBOOK_GROUP_PROMPT',
      groupId
    });
  }

  // ========================================
  // Multi-Wallet Support Methods (Phase 2)
  // ========================================

  /**
   * Create a new wallet with generated mnemonic
   * Generates a new 12-word BIP39 mnemonic and adds to wallet storage
   *
   * @param nickname - User-friendly name for the wallet
   * @param pin - User's PIN for encryption
   * @returns Wallet data with mnemonic and initial balance
   */
  static async createWallet(nickname: string, pin: string): Promise<MessageResponse<WalletData>> {
    return this.sendToBackground({
      type: 'CREATE_WALLET',
      nickname,
      pin
    });
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
  static async importWallet(mnemonic: string, nickname: string, pin: string): Promise<MessageResponse<WalletData>> {
    return this.sendToBackground({
      type: 'IMPORT_WALLET',
      mnemonic,
      nickname,
      pin
    });
  }

  /**
   * Get all wallets (metadata only, no mnemonics)
   * Returns wallet metadata for UI display
   *
   * @returns Array of wallet metadata
   */
  static async getAllWallets(): Promise<MessageResponse<import('../types').WalletMetadata[]>> {
    return this.sendToBackground({
      type: 'GET_ALL_WALLETS'
    });
  }

  /**
   * Switch to a different wallet
   * Disconnects current SDK, loads new wallet, and prepares for SDK reconnection
   *
   * @param walletId - UUID of the wallet to switch to
   * @param pin - User's PIN to decrypt wallet
   * @returns Wallet data for the new active wallet
   */
  static async switchWallet(walletId: string, pin: string): Promise<MessageResponse<WalletData>> {
    return this.sendToBackground({
      type: 'SWITCH_WALLET',
      walletId,
      pin
    });
  }

  /**
   * Rename a wallet
   * Updates the wallet's nickname in metadata
   *
   * @param walletId - UUID of the wallet to rename
   * @param newNickname - New name for the wallet
   * @param pin - User's PIN for verification
   */
  static async renameWallet(walletId: string, newNickname: string, pin: string): Promise<MessageResponse<void>> {
    console.log('?? [ExtensionMessaging] RENAME_WALLET request', {
      walletId,
      newNickname,
      timestamp: new Date().toISOString()
    });
    return this.sendToBackground({
      type: 'RENAME_WALLET',
      walletId,
      newNickname,
      pin
    });
  }

  /**
   * Delete a wallet
   * Removes wallet from storage (prevents deleting the last wallet)
   *
   * @param walletId - UUID of the wallet to delete
   * @param pin - User's PIN for verification
   */
  static async deleteWallet(walletId: string, pin: string): Promise<MessageResponse<void>> {
    return this.sendToBackground({
      type: 'DELETE_WALLET',
      walletId,
      pin
    });
  }

  /**
   * Check if mnemonic already exists (duplicate detection)
   * Derives fingerprint from mnemonic and compares with existing wallets
   *
   * @param mnemonic - Mnemonic to check
   * @param pin - User's PIN to decrypt existing wallets
   * @returns True if duplicate found, false otherwise
   */
  static async checkDuplicateMnemonic(mnemonic: string, pin: string): Promise<MessageResponse<boolean>> {
    return this.sendToBackground({
      type: 'CHECK_DUPLICATE_MNEMONIC',
      mnemonic,
      pin
    });
  }

  // ========================================
  // Hierarchical Multi-Wallet Support (v2)
  // ========================================

  /**
   * Get the current wallet storage version
   * @returns 0 = legacy single, 1 = flat multi-wallet, 2 = hierarchical
   */
  static async getWalletVersion(): Promise<MessageResponse<number>> {
    return this.sendToBackground({
      type: 'GET_WALLET_VERSION'
    });
  }

  /**
   * Get all master key metadata (without decryption)
   * @returns Array of master key metadata for UI display
   */
  static async getMasterKeyMetadata(): Promise<MessageResponse<import('../types').MasterKeyMetadata[]>> {
    return this.sendToBackground({
      type: 'GET_MASTER_KEY_METADATA'
    });
  }

  /**
   * Get sub-wallets for a specific master key
   * @param masterKeyId - UUID of the master key
   * @returns Array of sub-wallet entries
   */
  static async getSubWallets(masterKeyId: string, includeArchived: boolean = false): Promise<MessageResponse<import('../types').SubWalletEntry[]>> {
    return this.sendToBackground({
      type: 'GET_SUB_WALLETS',
      masterKeyId,
      includeArchived
    });
  }

  /**
   * Add a new master key with mnemonic
   * @param mnemonic - 12-word BIP39 mnemonic
   * @param nickname - User-friendly name
   * @param pin - User's PIN for encryption
   * @param createDefaultSubWallet - Whether to create a default sub-wallet (index 0)
   * @returns The new master key ID
   */
  static async addMasterKey(
    mnemonic: string,
    nickname: string,
    pin: string,
    createDefaultSubWallet: boolean = true
  ): Promise<MessageResponse<string>> {
    return this.sendToBackground({
      type: 'ADD_MASTER_KEY',
      mnemonic,
      nickname,
      pin,
      createDefaultSubWallet
    });
  }

  /**
   * Add a sub-wallet to an existing master key
   * @param masterKeyId - UUID of the master key
   * @param nickname - User-friendly name for the sub-wallet
   * @returns The new sub-wallet index
   */
  static async addSubWallet(masterKeyId: string, nickname: string): Promise<MessageResponse<number>> {
    return this.sendToBackground({
      type: 'ADD_SUB_WALLET',
      masterKeyId,
      nickname
    });
  }

  /**
   * Import a wallet with automatic sub-wallet discovery
   * Scans for sub-wallets with transaction history and restores them
   * @param mnemonic - 12-word mnemonic phrase
   * @param nickname - User-friendly name for the wallet
   * @param pin - User's PIN for encryption
   * @returns Object with master key ID and count of discovered sub-wallets
   */
  static async importWalletWithDiscovery(
    mnemonic: string,
    nickname: string,
    pin: string
  ): Promise<MessageResponse<{ masterKeyId: string; discoveredCount: number }>> {
    return this.sendToBackground({
      type: 'IMPORT_WALLET_WITH_DISCOVERY',
      mnemonic,
      nickname,
      pin
    });
  }

  /**
   * Remove a master key and all its sub-wallets
   * @param masterKeyId - UUID of the master key to remove
   * @param pin - User's PIN for verification
   */
  static async removeMasterKey(masterKeyId: string, pin: string): Promise<MessageResponse<void>> {
    return this.sendToBackground({
      type: 'REMOVE_MASTER_KEY',
      masterKeyId,
      pin
    });
  }

  /**
   * Remove a sub-wallet from a master key
   * @param masterKeyId - UUID of the master key
   * @param subWalletIndex - Index of the sub-wallet to remove
   * @param pin - User's PIN for verification
   */
  static async removeSubWallet(masterKeyId: string, subWalletIndex: number, pin: string): Promise<MessageResponse<void>> {
    return this.sendToBackground({
      type: 'REMOVE_SUB_WALLET',
      masterKeyId,
      subWalletIndex,
      pin
    });
  }

  /**
   * Set the active wallet (master key + sub-wallet)
   * @param masterKeyId - UUID of the master key
   * @param subWalletIndex - Index of the sub-wallet
   */
  static async setActiveHierarchicalWallet(masterKeyId: string, subWalletIndex: number): Promise<MessageResponse<void>> {
    return this.sendToBackground({
      type: 'SET_ACTIVE_HIERARCHICAL_WALLET',
      masterKeyId,
      subWalletIndex
    });
  }

  /**
   * Rename a master key
   * @param masterKeyId - UUID of the master key
   * @param newNickname - New name for the master key
   */
  static async renameMasterKey(masterKeyId: string, newNickname: string): Promise<MessageResponse<void>> {
    return this.sendToBackground({
      type: 'RENAME_MASTER_KEY',
      masterKeyId,
      newNickname
    });
  }

  /**
   * Rename a sub-wallet
   * @param masterKeyId - UUID of the master key
   * @param subWalletIndex - Index of the sub-wallet
   * @param newNickname - New name for the sub-wallet
   */
  static async renameSubWallet(masterKeyId: string, subWalletIndex: number, newNickname: string): Promise<MessageResponse<void>> {
    return this.sendToBackground({
      type: 'RENAME_SUB_WALLET',
      masterKeyId,
      subWalletIndex,
      newNickname
    });
  }

  /**
   * Toggle master key expansion state in UI
   * @param masterKeyId - UUID of the master key
   */
  static async toggleMasterKeyExpanded(masterKeyId: string): Promise<MessageResponse<void>> {
    return this.sendToBackground({
      type: 'TOGGLE_MASTER_KEY_EXPANDED',
      masterKeyId
    });
  }

  /**
   * Check if migration to hierarchical (v2) is needed
   * @returns True if v1 exists and v2 doesn't
   */
  static async needsHierarchicalMigration(): Promise<MessageResponse<boolean>> {
    return this.sendToBackground({
      type: 'NEEDS_HIERARCHICAL_MIGRATION'
    });
  }

  /**
   * Switch to a specific hierarchical wallet (master key + sub-wallet)
   * Returns the derived mnemonic for SDK connection
   *
   * @param masterKeyId - UUID of the master key
   * @param subWalletIndex - Index of the sub-wallet (0-19)
   * @param pin - User's PIN to decrypt the master key
   * @returns Object with derived mnemonic and wallet info
   */
  static async switchHierarchicalWallet(
    masterKeyId: string,
    subWalletIndex: number,
    pin: string
  ): Promise<MessageResponse<{
    mnemonic: string;
    masterKeyNickname: string;
    subWalletNickname: string;
    masterKeyId: string;
    subWalletIndex: number;
  }>> {
    return this.sendToBackground({
      type: 'SWITCH_HIERARCHICAL_WALLET',
      masterKeyId,
      subWalletIndex,
      pin
    });
  }

  /**
   * Get the derived mnemonic for a specific hierarchical wallet
   * Useful when needing to reconnect SDK for a specific wallet
   *
   * @param masterKeyId - UUID of the master key
   * @param subWalletIndex - Index of the sub-wallet (0-19)
   * @param pin - User's PIN to decrypt the master key
   * @returns The derived mnemonic for the sub-wallet
   */
  static async getHierarchicalWalletMnemonic(
    masterKeyId: string,
    subWalletIndex: number,
    pin: string
  ): Promise<MessageResponse<string>> {
    return this.sendToBackground({
      type: 'GET_HIERARCHICAL_WALLET_MNEMONIC',
      masterKeyId,
      subWalletIndex,
      pin
    });
  }

  /**
   * Get the active hierarchical wallet info
   * @returns Object with masterKeyId and subWalletIndex, or null if not hierarchical
   */
  static async getActiveHierarchicalWalletInfo(): Promise<MessageResponse<{
    masterKeyId: string;
    subWalletIndex: number;
  } | null>> {
    return this.sendToBackground({
      type: 'GET_ACTIVE_HIERARCHICAL_WALLET_INFO'
    });
  }

  /**
   * Add discovered sub-wallets to a master key
   * Used after sub-wallet discovery to add multiple sub-wallets at once
   *
   * @param masterKeyId - UUID of the master key
   * @param subWallets - Array of { index, nickname } for discovered wallets
   * @returns Success status
   */
  static async addDiscoveredSubWallets(
    masterKeyId: string,
    subWallets: { index: number; nickname: string }[]
  ): Promise<MessageResponse<void>> {
    return this.sendToBackground({
      type: 'ADD_DISCOVERED_SUB_WALLETS',
      masterKeyId,
      subWallets
    });
  }

  /**
   * Update the hasActivity flag for a sub-wallet
   * Called when we detect transactions on a sub-wallet
   *
   * @param masterKeyId - UUID of the master key
   * @param subWalletIndex - Index of the sub-wallet
   * @param hasActivity - Whether the sub-wallet has transaction activity
   * @returns Success status
   */
  static async updateSubWalletActivity(
    masterKeyId: string,
    subWalletIndex: number,
    hasActivity: boolean
  ): Promise<MessageResponse<void>> {
    return this.sendToBackground({
      type: 'UPDATE_SUB_WALLET_ACTIVITY',
      masterKeyId,
      subWalletIndex,
      hasActivity
    });
  }

  // ========================================
  // Wallet Archive/Restore Methods
  // ========================================

  /**
   * Archive a master key (move to archived list)
   * Does NOT require PIN - used when user forgot PIN
   *
   * @param masterKeyId - UUID of the master key to archive
   * @returns Success status
   */
  static async archiveMasterKey(masterKeyId: string): Promise<MessageResponse<void>> {
    return this.sendToBackground({
      type: 'ARCHIVE_MASTER_KEY',
      masterKeyId
    });
  }

  /**
   * Restore an archived master key back to active list
   *
   * @param masterKeyId - UUID of the archived master key
   * @returns Success status
   */
  static async restoreArchivedMasterKey(masterKeyId: string): Promise<MessageResponse<void>> {
    return this.sendToBackground({
      type: 'RESTORE_ARCHIVED_MASTER_KEY',
      masterKeyId
    });
  }

  /**
   * Get all archived wallets (metadata only)
   *
   * @returns Array of archived wallet metadata
   */
  static async getArchivedWallets(): Promise<MessageResponse<(import('../types').WalletMetadata & { archivedAt?: number })[]>> {
    return this.sendToBackground({
      type: 'GET_ARCHIVED_WALLETS'
    });
  }

  /**
   * Permanently delete an archived master key
   * This is irreversible - the wallet data will be lost
   *
   * @param masterKeyId - UUID of the archived master key
   * @returns Success status
   */
  static async deleteArchivedMasterKey(masterKeyId: string): Promise<MessageResponse<void>> {
    return this.sendToBackground({
      type: 'DELETE_ARCHIVED_MASTER_KEY',
      masterKeyId
    });
  }

  /**
   * Verify PIN against an archived wallet
   * Used to confirm PIN before permanent deletion
   *
   * @param masterKeyId - UUID of the archived master key
   * @param pin - PIN to verify
   * @returns True if PIN is correct
   */
  static async verifyArchivedWalletPin(masterKeyId: string, pin: string): Promise<MessageResponse<boolean>> {
    return this.sendToBackground({
      type: 'VERIFY_ARCHIVED_WALLET_PIN',
      masterKeyId,
      pin
    });
  }

  // ========================================
  // Sub-Wallet Archive/Restore Methods
  // ========================================

  /**
   * Archive a sub-wallet
   *
   * @param masterKeyId - UUID of the parent master key
   * @param subWalletIndex - Index of the sub-wallet to archive
   * @returns Success status
   */
  static async archiveSubWallet(masterKeyId: string, subWalletIndex: number): Promise<MessageResponse<void>> {
    return this.sendToBackground({
      type: 'ARCHIVE_SUB_WALLET',
      masterKeyId,
      subWalletIndex
    });
  }

  /**
   * Restore an archived sub-wallet
   *
   * @param masterKeyId - UUID of the parent master key
   * @param subWalletIndex - Index of the sub-wallet to restore
   * @returns Success status
   */
  static async restoreSubWallet(masterKeyId: string, subWalletIndex: number): Promise<MessageResponse<void>> {
    return this.sendToBackground({
      type: 'RESTORE_SUB_WALLET',
      masterKeyId,
      subWalletIndex
    });
  }

  /**
   * Permanently delete an archived sub-wallet
   *
   * @param masterKeyId - UUID of the parent master key
   * @param subWalletIndex - Index of the sub-wallet to delete
   * @returns Success status
   */
  static async deleteArchivedSubWallet(masterKeyId: string, subWalletIndex: number): Promise<MessageResponse<void>> {
    return this.sendToBackground({
      type: 'DELETE_ARCHIVED_SUB_WALLET',
      masterKeyId,
      subWalletIndex
    });
  }

  /**
   * Get all archived sub-wallets across all master keys
   *
   * @returns Array of archived sub-wallet info with parent master key details
   */
  static async getArchivedSubWallets(): Promise<MessageResponse<{
    masterKeyId: string;
    masterKeyNickname: string;
    subWalletIndex: number;
    subWalletNickname: string;
    archivedAt: number;
  }[]>> {
    return this.sendToBackground({
      type: 'GET_ARCHIVED_SUB_WALLETS'
    });
  }
}
