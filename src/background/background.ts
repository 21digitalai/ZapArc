// Background service worker for ZapArc wallet extension
// Handles Breez SDK operations, storage management, and message passing

import { WalletData, UserSettings } from '../types';
import { WalletManager } from '../utils/wallet-manager';
import { ChromeStorageManager } from '../utils/storage';
import { LnurlManager, convertToLnurl } from '../utils/lnurl';
import * as bip39 from 'bip39';

// Breez SDK API key (client certificate for Spark implementation)
// This is a client certificate provided by Breez for authentication
const BREEZ_API_KEY = 'MIIBfjCCATCgAwIBAgIHPoqCRCUxZzAFBgMrZXAwEDEOMAwGA1UEAxMFQnJlZXowHhcNMjUxMDEzMTY0NzQ0WhcNMzUxMDExMTY0NzQ0WjAwMRUwEwYDVQQKEwxCVEMgSE9ETCBMdGQxFzAVBgNVBAMTDlBsYW1lbiBBbmRvbm92MCowBQYDK2VwAyEA0IP1y98gPByiIMoph1P0G6cctLb864rNXw1LRLOpXXejgYgwgYUwDgYDVR0PAQH/BAQDAgWgMAwGA1UdEwEB/wQCMAAwHQYDVR0OBBYEFNo5o+5ea0sNMlW/75VgGJCv2AcJMB8GA1UdIwQYMBaAFN6q1pJW843ndJIW/Ey2ILJrKJhrMCUGA1UdEQQeMByBGnBsYW1lbkBjcnlwdG9yZXZvbHV0aW9uLmJnMAUGAytlcANBAOxPxCDCzt/batCHrDuIMNsZL0lqBpk/dG+MzqseJRS8UjhJsSpOO4jTtsMqS7DWJE64THyIV+FTCbt1XhUM2A4=';

console.log('ZapArc background service worker loaded');

// Global instances
const walletManager = new WalletManager();
const storageManager = new ChromeStorageManager();
const lnurlManager = new LnurlManager(walletManager);

/**
 * Generate and validate a 12-word BIP39 mnemonic with sanity checks.
 * Retries up to 3 times before throwing.
 */
function generateAndValidateMnemonic(): string {
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
 * Validate a mnemonic against extension seed phrase sanity rules.
 */
function validateMnemonicSanity(mnemonic: string): boolean {
  const normalizedMnemonic = mnemonic.trim().toLowerCase();
  const words = normalizedMnemonic.split(/\s+/);
  const englishWordSet = new Set(bip39.wordlists.english);

  const isValid = bip39.validateMnemonic(normalizedMnemonic);
  const hasTwelveWords = words.length === 12;
  const hasOnlyEnglishWords = words.every(word => englishWordSet.has(word));
  const hasNoConsecutiveDuplicates = words.every((word, index) => index === 0 || word !== words[index - 1]);

  return isValid && hasTwelveWords && hasOnlyEnglishWords && hasNoConsecutiveDuplicates;
}

function formatLockoutDuration(remainingMs: number): string {
  const totalSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

// Message handler for communication with other components
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true; // Keep message channel open for async responses
});

async function handleMessage(message: any, sender: any, sendResponse: (response: any) => void) {
  try {
    const isExtensionSender = sender?.id === chrome.runtime.id;
    if (!isExtensionSender) {
      sendResponse({ success: false, error: 'Unauthorized sender' });
      return;
    }

    // Update activity timestamp for auto-lock
    await storageManager.updateActivity();

    switch (message.type) {
      case 'GENERATE_MNEMONIC':
        try {
          // Generate a new mnemonic phrase
          const mnemonic = generateAndValidateMnemonic();
          console.log('Background: Generated wallet seed');
          sendResponse({ success: true, data: mnemonic });
        } catch (error) {
          console.error('Background: Mnemonic generation failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Mnemonic generation failed'
          });
        }
        break;

      case 'SETUP_WALLET':
        try {
          console.log('Background: Starting wallet setup (storage only)');

          // Validate mnemonic
          if (!validateMnemonicSanity(message.mnemonic)) {
            throw new Error('Invalid mnemonic phrase');
          }

          // Get user settings
          const settings = await storageManager.getUserSettings();

          // Create wallet data WITHOUT Breez SDK (SDK runs in popup)
          const walletData: WalletData = {
            mnemonic: message.mnemonic,
            balance: 0,  // Will be updated by popup after SDK initialization
            lnurl: undefined,  // Will be generated by popup after SDK initialization
            customLNURL: settings.customLNURL,
            transactions: []
          };

          // Save to multi-wallet storage (works for first wallet and additional wallets)
          const walletId = await storageManager.addWallet(walletData, 'Wallet 1', message.pin);
          await storageManager.unlockWallet();

          console.log('Background: Wallet added successfully to multi-wallet storage', { walletId });
          sendResponse({
            success: true,
            message: 'Wallet created. SDK will be initialized in popup.'
          });
        } catch (setupError) {
          console.error('Background: Wallet setup failed:', setupError);
          sendResponse({
            success: false,
            error: setupError instanceof Error ? setupError.message : 'Wallet setup failed'
          });
        }
        break;

      case 'UNLOCK_WALLET':
        // Don't try to connect SDK in background - just update storage flags
        await chrome.storage.local.set({
          isUnlocked: true,
          lastActivity: Date.now()
        });
        console.log('[Background] Wallet marked as unlocked in storage');
        sendResponse({ success: true });
        break;

      case 'LOCK_WALLET':
        // Storage-only operation
        await chrome.storage.local.set({
          isUnlocked: false
        });
        console.log('[Background] Wallet locked');
        sendResponse({ success: true });
        break;

      case 'GET_WALLET_STATUS':
        const status = await walletManager.getWalletStatus();
        sendResponse({ success: true, status });
        break;

      case 'GET_BALANCE':
        // Return cached balance from storage
        const cachedData = await chrome.storage.local.get(['cachedBalance']);
        sendResponse({
          success: true,
          data: cachedData.cachedBalance || 0,
          cached: true
        });
        break;

      case 'GENERATE_INVOICE':
        // Invoice generation now happens in popup context (SDK requires DOM/WASM)
        // This case is kept for backward compatibility but should not be used
        console.warn('GENERATE_INVOICE called in background - should be handled in popup');
        sendResponse({
            success: false,
            error: 'Invoice generation must be done in popup. Please ensure popup is open.',
            requiresPopup: true
        });
        break;

      case 'SEND_PAYMENT':
        // SDK operation - must be done in popup
        console.warn('[Background] SEND_PAYMENT requires popup SDK');
        sendResponse({
          success: false,
          error: 'Sending payments requires popup context. Please open extension popup.',
          requiresPopup: true
        });
        break;

      case 'LIST_PAYMENTS':
        // SDK operation - must be done in popup
        console.warn('[Background] LIST_PAYMENTS requires popup SDK - returning empty array');
        sendResponse({
          success: false,
          error: 'Payment history requires popup context. Please open extension popup.',
          data: []
        });
        break;

      case 'PARSE_LNURL':
        // Convert Lightning address to LNURL endpoint if needed
        const resolvedLnurl = convertToLnurl(message.lnurl);
        const parsed = await walletManager.parseLnurl(resolvedLnurl);
        sendResponse({ success: true, data: parsed });
        break;

      case 'PAY_LNURL':
        const payResult = await walletManager.payLnurl(message.reqData, message.amount, message.comment);
        sendResponse({
          success: payResult.success,
          data: payResult,
          error: payResult.error
        });
        break;

      case 'PROCESS_PAYMENT':
        try {
          // Process payment and wait for confirmed result
          const paymentResult = await walletManager.payLnurl(
            message.lnurlData,
            message.amount,
            message.comment
          );

          if (paymentResult.success) {
            sendResponse({
              success: true,
              data: {
                transactionId: paymentResult.paymentId,
                paymentHash: paymentResult.paymentHash,
                preimage: paymentResult.preimage,
                amountSats: paymentResult.amountSats,
                feeSats: paymentResult.feeSats,
                successAction: paymentResult.successAction
              }
            });
          } else {
            sendResponse({
              success: false,
              error: paymentResult.error || 'Payment failed',
              retryable: true
            });
          }
        } catch (error) {
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Payment processing failed',
            retryable: true
          });
        }
        break;

      case 'GENERATE_QR_CODE':
        try {
          // For QR code generation, we return the LNURL or bolt11 invoice
          // The frontend will handle the actual QR image generation
          let qrData = message.lnurl;
          
          if (message.amount && message.amount > 0) {
            // If amount is specified, we could generate a bolt11 invoice
            // For now, return the LNURL with amount parameter
            qrData = `lightning:${message.lnurl.toUpperCase()}?amount=${message.amount * 1000}`;
            if (message.comment) {
              qrData += `&message=${encodeURIComponent(message.comment)}`;
            }
          }
          
          sendResponse({ success: true, qrData });
        } catch (error) {
          sendResponse({ 
            success: false, 
            error: error instanceof Error ? error.message : 'QR generation failed'
          });
        }
        break;

      case 'GENERATE_LNURL':
        const lnurl = await walletManager.generateReceiveLnurl();
        sendResponse({ success: true, lnurl });
        break;

      case 'GET_NODE_INFO':
        const nodeInfo = await walletManager.getNodeInfo();
        sendResponse({ success: true, nodeInfo });
        break;

      case 'CHECK_SUFFICIENT_BALANCE':
        const hasSufficientBalance = await walletManager.hasSufficientBalance(message.amount);
        sendResponse({ success: true, hasSufficientBalance });
        break;

      case 'GET_LNURL_PAYMENT_LIMITS':
        const limits = await lnurlManager.getLnurlPaymentLimits(message.lnurl);
        sendResponse({ success: true, limits });
        break;

      case 'IS_COMMENT_ALLOWED':
        const commentInfo = await lnurlManager.isCommentAllowed(message.lnurl);
        sendResponse({ success: true, commentInfo });
        break;

      case 'EXTRACT_LNURL':
        const extractedLnurl = lnurlManager.extractLnurl(message.input);
        sendResponse({ success: true, lnurl: extractedLnurl });
        break;

      case 'ADD_TO_BLACKLIST':
        const blacklistArray = await storageManager.getBlacklist();
        if (!blacklistArray.lnurls.includes(message.lnurl)) {
          blacklistArray.lnurls.push(message.lnurl);
          blacklistArray.lastUpdated = Date.now();
          await storageManager.saveBlacklist(blacklistArray.lnurls);
        }
        sendResponse({ success: true });
        break;

      case 'REMOVE_FROM_BLACKLIST':
        const currentBlacklist = await storageManager.getBlacklist();
        const filteredLnurls = currentBlacklist.lnurls.filter(lnurl => lnurl !== message.lnurl);
        await storageManager.saveBlacklist(filteredLnurls);
        sendResponse({ success: true });
        break;

      case 'CLEAR_BLACKLIST':
        await storageManager.saveBlacklist([]);
        sendResponse({ success: true });
        break;

      case 'SET_DOMAIN_STATUS':
        await storageManager.saveDomainSettings(message.domain, message.status);
        sendResponse({ success: true });
        break;

      case 'GET_DOMAIN_STATUS':
        const currentDomainSettings = await storageManager.getDomainSettings();
        const domainStatus = currentDomainSettings[message.domain] || 'unmanaged';
        sendResponse({ success: true, status: domainStatus });
        break;

      case 'GET_ALL_DOMAINS':
        const allDomainSettings = await storageManager.getDomainSettings();
        sendResponse({ success: true, domains: allDomainSettings });
        break;

      case 'SAVE_WALLET':
        await storageManager.saveEncryptedWallet(message.walletData, message.pin);
        sendResponse({ success: true });
        break;

      case 'LOAD_WALLET':
        console.log('🔵 [Background] LOAD_WALLET');

        const lockout = await storageManager.checkPinLockout();
        if (lockout.locked) {
          sendResponse({
            success: false,
            error: `Too many failed attempts. Try again in ${formatLockoutDuration(lockout.remainingMs || 0)}.`
          });
          break;
        }

        // Try to unlock any wallet (v1 flat or v2 hierarchical) with the given PIN
        // For v2, this returns the derived sub-wallet mnemonic based on activeSubWalletIndex
        const unlockedWallet = await storageManager.tryUnlockAnyWalletUnified(message.pin);

        if (!unlockedWallet) {
          console.error('❌ [Background] LOAD_WALLET - No wallet matched the PIN');
          const updatedLockout = await storageManager.checkPinLockout();
          sendResponse({
            success: false,
            error: updatedLockout.locked
              ? `Too many failed attempts. Try again in ${formatLockoutDuration(updatedLockout.remainingMs || 0)}.`
              : 'Incorrect PIN'
          });
          break;
        }

        console.log('✅ [Background] LOAD_WALLET - Wallet unlocked successfully');
        console.log('🔍 [Background] LOAD_WALLET - Response data:', {
          hasWallet: !!unlockedWallet.wallet,
          walletId: unlockedWallet.metadata.id,
          nickname: unlockedWallet.metadata.nickname,
          isHierarchical: unlockedWallet.isHierarchical,
          hierarchicalInfo: unlockedWallet.hierarchicalInfo
        });

        sendResponse({
          success: true,
          data: unlockedWallet.wallet,
          metadata: unlockedWallet.metadata,
          isHierarchical: unlockedWallet.isHierarchical,
          hierarchicalInfo: unlockedWallet.hierarchicalInfo
        });
        break;

      case 'GET_MASTER_MNEMONIC':
        try {
          const lockout = await storageManager.checkPinLockout();
          if (lockout.locked) {
            sendResponse({
              success: false,
              error: `Too many failed attempts. Try again in ${formatLockoutDuration(lockout.remainingMs || 0)}.`
            });
            break;
          }

          const masterMnemonic = await storageManager.getMasterKeyMnemonic(message.masterKeyId, message.pin);
          await storageManager.resetPinAttempts();
          sendResponse({ success: true, data: { mnemonic: masterMnemonic } });
        } catch (error) {
          await storageManager.recordFailedPin();
          const updatedLockout = await storageManager.checkPinLockout();
          console.error('[Background] GET_MASTER_MNEMONIC failed:', error);
          sendResponse({
            success: false,
            error: updatedLockout.locked
              ? `Too many failed attempts. Try again in ${formatLockoutDuration(updatedLockout.remainingMs || 0)}.`
              : (error instanceof Error ? error.message : 'Failed to get mnemonic')
          });
        }
        break;

      case 'SAVE_DOMAIN_SETTINGS':
        await storageManager.saveDomainSettings(message.domain, message.status);
        sendResponse({ success: true });
        break;

      case 'GET_DOMAIN_SETTINGS':
        const domainSettings = await storageManager.getDomainSettings();
        sendResponse({ success: true, domainSettings });
        break;

      case 'SAVE_BLACKLIST':
        await storageManager.saveBlacklist(message.lnurls);
        sendResponse({ success: true });
        break;

      case 'GET_BLACKLIST':
        const blacklist = await storageManager.getBlacklist();
        sendResponse({ success: true, blacklist });
        break;

      case 'GET_USER_SETTINGS':
        const settings = await storageManager.getUserSettings();
        sendResponse({ success: true, data: settings });
        break;

      case 'SAVE_USER_SETTINGS':
        await storageManager.saveUserSettings(message.settings);
        sendResponse({ success: true });
        break;

      case 'IS_WALLET_UNLOCKED':
        const isUnlocked = await storageManager.isWalletUnlocked();
        // Return 'data' to match popup expectation (popup.ts:158)
        sendResponse({ success: true, data: isUnlocked });
        break;



      case 'IS_WALLET_CONNECTED':
        const isConnected = walletManager.getBreezSDK().isWalletConnected();
        sendResponse({ success: true, data: isConnected });
        break;

      case 'WALLET_EXISTS':
        const walletExists = await storageManager.walletExists();
        sendResponse({ success: true, data: walletExists });
        break;

      case 'OPEN_POPUP':
        // Open extension popup
        try {
          await chrome.action.openPopup();
          sendResponse({ success: true });
        } catch (error) {
          // Fallback: open popup in new tab if openPopup fails
          const popupUrl = chrome.runtime.getURL('popup.html');
          await chrome.tabs.create({ url: popupUrl });
          sendResponse({ success: true });
        }
        break;

      case 'OPEN_POPUP_DEPOSIT':
        // Open extension popup with deposit focus
        try {
          await chrome.action.openPopup();
          // Send message to popup to focus on deposit
          setTimeout(() => {
            chrome.runtime.sendMessage({ type: 'FOCUS_DEPOSIT' });
          }, 100);
          sendResponse({ success: true });
        } catch (error) {
          // Fallback: open popup in new tab
          const popupUrl = chrome.runtime.getURL('popup.html?action=deposit');
          await chrome.tabs.create({ url: popupUrl });
          sendResponse({ success: true });
        }
        break;

      case 'OPEN_POPUP_WITHDRAW':
        // Open extension popup with withdraw focus
        try {
          await chrome.action.openPopup();
          // Send message to popup to focus on withdraw
          setTimeout(() => {
            chrome.runtime.sendMessage({ type: 'FOCUS_WITHDRAW' });
          }, 100);
          sendResponse({ success: true });
        } catch (error) {
          // Fallback: open popup in new tab
          const popupUrl = chrome.runtime.getURL('popup.html?action=withdraw');
          await chrome.tabs.create({ url: popupUrl });
          sendResponse({ success: true });
        }
        break;

      // ========================================
      // Multi-Wallet Support Message Handlers (Phase 2)
      // ========================================

      case 'CREATE_WALLET':
        try {
          console.log('[Background] CREATE_WALLET - Creating new wallet');
          let { nickname, pin } = message;

          // Validate PIN
          if (!pin || typeof pin !== 'string') {
            throw new Error('PIN is required');
          }

          // Auto-generate nickname if not provided
          if (!nickname || typeof nickname !== 'string' || !nickname.trim()) {
            const wallets = await walletManager.getAllWallets();
            const walletCount = wallets.length;
            nickname = `Wallet ${walletCount + 1}`;
            console.log(`[Background] CREATE_WALLET - Auto-generated nickname: "${nickname}"`);
          }

          const newWallet = await walletManager.createWallet(nickname, pin);
          console.log('[Background] CREATE_WALLET - Wallet created successfully');
          sendResponse({ success: true, data: newWallet });
        } catch (error) {
          console.error('[Background] CREATE_WALLET - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Wallet creation failed'
          });
        }
        break;

      case 'IMPORT_WALLET':
        try {
          console.log('[Background] IMPORT_WALLET - Importing wallet as master key');
          let { mnemonic, nickname, pin } = message;

          // Validate parameters
          if (!mnemonic || typeof mnemonic !== 'string') {
            throw new Error('Mnemonic is required');
          }
          if (!pin || typeof pin !== 'string') {
            throw new Error('PIN is required');
          }

          // Auto-generate nickname if not provided
          if (!nickname || typeof nickname !== 'string' || !nickname.trim()) {
            const masterKeys = await storageManager.getMasterKeyMetadata();
            const masterKeyCount = masterKeys.length;
            nickname = masterKeyCount === 0 ? 'Main Wallet' : `Wallet ${masterKeyCount + 1}`;
            console.log(`[Background] IMPORT_WALLET - Auto-generated nickname: "${nickname}"`);
          }

          // Always create as master key with default sub-wallet (index 0)
          // This ensures all wallets are in hierarchical format from the start
          const masterKeyId = await storageManager.addMasterKey(mnemonic.trim().toLowerCase(), nickname, pin, true);
          console.log('[Background] IMPORT_WALLET - Created as master key:', masterKeyId);

          // Set as active wallet
          await storageManager.setActiveHierarchicalWallet(masterKeyId, 0);

          // Return wallet data for compatibility
          const walletData = {
            mnemonic: mnemonic.trim().toLowerCase(),
            balance: 0,
            transactions: []
          };

          console.log('[Background] IMPORT_WALLET - Wallet imported successfully (hierarchical)');
          sendResponse({ success: true, data: walletData });
        } catch (error) {
          console.error('[Background] IMPORT_WALLET - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Wallet import failed'
          });
        }
        break;

      case 'GET_ALL_WALLETS':
        try {
          console.log('[Background] GET_ALL_WALLETS - Fetching wallet metadata');
          const wallets = await walletManager.getAllWallets();
          console.log('[Background] GET_ALL_WALLETS - Retrieved wallets:', { count: wallets.length });
          sendResponse({ success: true, data: wallets });
        } catch (error) {
          console.error('[Background] GET_ALL_WALLETS - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to retrieve wallets'
          });
        }
        break;

      case 'SWITCH_WALLET':
        try {
          console.log('[Background] SWITCH_WALLET - Switching wallet');
          const { walletId, pin } = message;

          // Validate parameters
          if (!walletId || typeof walletId !== 'string') {
            throw new Error('Wallet ID is required');
          }
          // PIN validation relaxed - allow empty PIN when wallet is already unlocked
          // Actual decryption in storage layer will validate PIN if needed
          if (typeof pin !== 'string') {
            throw new Error('PIN must be a string');
          }

          const switchedWallet = await walletManager.switchWallet(walletId, pin);
          console.log('[Background] SWITCH_WALLET - Wallet switched successfully');
          sendResponse({ success: true, data: switchedWallet });
        } catch (error) {
          console.error('[Background] SWITCH_WALLET - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Wallet switch failed'
          });
        }
        break;

      case 'RENAME_WALLET':
        try {
          console.log('[Background] RENAME_WALLET - Renaming wallet');
          const { walletId, newNickname, pin } = message;
          console.log('[Background] RENAME_WALLET - Payload received', {
            walletId,
            newNickname
          });

          // Validate parameters
          if (!walletId || typeof walletId !== 'string') {
            throw new Error('Wallet ID is required');
          }
          if (!newNickname || typeof newNickname !== 'string') {
            throw new Error('New wallet name is required');
          }
          if (!pin || typeof pin !== 'string') {
            throw new Error('PIN is required');
          }

          await walletManager.renameWallet(walletId, newNickname, pin);
          console.log('[Background] RENAME_WALLET - Wallet renamed successfully');
          sendResponse({ success: true });
          console.log('[Background] RENAME_WALLET - Response sent: success');
        } catch (error) {
          console.error('[Background] RENAME_WALLET - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Wallet rename failed'
          });
          console.log('[Background] RENAME_WALLET - Response sent: failure');
        }
        break;

      case 'DELETE_WALLET':
        try {
          console.log('[Background] DELETE_WALLET - Deleting wallet');
          const { walletId, pin } = message;

          // Validate parameters
          if (!walletId || typeof walletId !== 'string') {
            throw new Error('Wallet ID is required');
          }
          if (!pin || typeof pin !== 'string') {
            throw new Error('PIN is required');
          }

          await walletManager.deleteWallet(walletId, pin);
          console.log('[Background] DELETE_WALLET - Wallet deleted successfully');
          sendResponse({ success: true });
        } catch (error) {
          console.error('[Background] DELETE_WALLET - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Wallet deletion failed'
          });
        }
        break;

      case 'CHECK_DUPLICATE_MNEMONIC':
        try {
          console.log('[Background] CHECK_DUPLICATE_MNEMONIC - Checking for duplicate');
          const { mnemonic, pin } = message;

          // Validate parameters
          if (!mnemonic || typeof mnemonic !== 'string') {
            throw new Error('Mnemonic is required');
          }
          if (!pin || typeof pin !== 'string') {
            throw new Error('PIN is required');
          }

          const isDuplicate = await walletManager.isDuplicateMnemonic(mnemonic, pin);
          console.log('[Background] CHECK_DUPLICATE_MNEMONIC - Check complete');
          sendResponse({ success: true, data: isDuplicate });
        } catch (error) {
          console.error('[Background] CHECK_DUPLICATE_MNEMONIC - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Duplicate check failed'
          });
        }
        break;

      // ========================================
      // Hierarchical Multi-Wallet Messages (v2)
      // ========================================

      case 'GET_WALLET_VERSION':
        try {
          const version = await walletManager.getWalletVersion();
          sendResponse({ success: true, data: version });
        } catch (error) {
          console.error('[Background] GET_WALLET_VERSION - Failed:', error);
          sendResponse({ success: false, error: 'Failed to get wallet version' });
        }
        break;

      case 'GET_MASTER_KEY_METADATA':
        try {
          const metadata = await walletManager.getMasterKeyMetadata();
          sendResponse({ success: true, data: metadata });
        } catch (error) {
          console.error('[Background] GET_MASTER_KEY_METADATA - Failed:', error);
          sendResponse({ success: false, error: 'Failed to get master key metadata' });
        }
        break;

      case 'GET_SUB_WALLETS':
        try {
          const { masterKeyId, includeArchived } = message;
          if (!masterKeyId) {
            throw new Error('Master key ID is required');
          }
          const subWallets = await walletManager.getSubWallets(masterKeyId, includeArchived);
          sendResponse({ success: true, data: subWallets });
        } catch (error) {
          console.error('[Background] GET_SUB_WALLETS - Failed:', error);
          sendResponse({ success: false, error: 'Failed to get sub-wallets' });
        }
        break;

      case 'ADD_MASTER_KEY':
        try {
          const { mnemonic, nickname, pin, createDefaultSubWallet } = message;
          if (!mnemonic || !nickname || !pin) {
            throw new Error('Mnemonic, nickname, and PIN are required');
          }
          const masterKeyId = await walletManager.addMasterKey(
            mnemonic,
            nickname,
            pin,
            createDefaultSubWallet !== false
          );
          sendResponse({ success: true, data: masterKeyId });
        } catch (error) {
          console.error('[Background] ADD_MASTER_KEY - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to add master key'
          });
        }
        break;

      case 'ADD_SUB_WALLET':
        try {
          const { masterKeyId, nickname } = message;
          if (!masterKeyId || !nickname) {
            throw new Error('Master key ID and nickname are required');
          }
          const subWalletIndex = await walletManager.addSubWallet(masterKeyId, nickname);
          sendResponse({ success: true, data: subWalletIndex });
        } catch (error) {
          console.error('[Background] ADD_SUB_WALLET - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to add sub-wallet'
          });
        }
        break;

      case 'IMPORT_WALLET_WITH_DISCOVERY':
        try {
          const { mnemonic, nickname, pin } = message;
          if (!mnemonic || !nickname || !pin) {
            throw new Error('Mnemonic, nickname, and PIN are required');
          }
          console.log('[Background] IMPORT_WALLET_WITH_DISCOVERY - Starting import with sub-wallet discovery');
          const result = await walletManager.importWalletWithDiscovery(
            mnemonic,
            nickname,
            pin
          );
          console.log(`[Background] IMPORT_WALLET_WITH_DISCOVERY - Complete: ${result.discoveredCount} sub-wallets found`);
          sendResponse({ success: true, data: result });
        } catch (error) {
          console.error('[Background] IMPORT_WALLET_WITH_DISCOVERY - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to import wallet'
          });
        }
        break;

      case 'REMOVE_MASTER_KEY':
        try {
          const { masterKeyId } = message;
          if (!masterKeyId) {
            throw new Error('Master key ID is required');
          }
          await walletManager.removeMasterKey(masterKeyId);
          sendResponse({ success: true });
        } catch (error) {
          console.error('[Background] REMOVE_MASTER_KEY - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to remove master key'
          });
        }
        break;

      case 'REMOVE_SUB_WALLET':
        try {
          const { masterKeyId, subWalletIndex } = message;
          if (!masterKeyId || subWalletIndex === undefined) {
            throw new Error('Master key ID and sub-wallet index are required');
          }
          await walletManager.removeSubWallet(masterKeyId, subWalletIndex);
          sendResponse({ success: true });
        } catch (error) {
          console.error('[Background] REMOVE_SUB_WALLET - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to remove sub-wallet'
          });
        }
        break;

      case 'SET_ACTIVE_HIERARCHICAL_WALLET':
        try {
          const { masterKeyId, subWalletIndex } = message;
          if (!masterKeyId || subWalletIndex === undefined) {
            throw new Error('Master key ID and sub-wallet index are required');
          }
          await walletManager.setActiveHierarchicalWallet(masterKeyId, subWalletIndex);
          sendResponse({ success: true });
        } catch (error) {
          console.error('[Background] SET_ACTIVE_HIERARCHICAL_WALLET - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to set active wallet'
          });
        }
        break;

      case 'RENAME_MASTER_KEY':
        try {
          const { masterKeyId, newNickname } = message;
          if (!masterKeyId || !newNickname) {
            throw new Error('Master key ID and new nickname are required');
          }
          await walletManager.renameMasterKey(masterKeyId, newNickname);
          sendResponse({ success: true });
        } catch (error) {
          console.error('[Background] RENAME_MASTER_KEY - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to rename master key'
          });
        }
        break;

      case 'RENAME_SUB_WALLET':
        try {
          const { masterKeyId, subWalletIndex, newNickname } = message;
          if (!masterKeyId || subWalletIndex === undefined || !newNickname) {
            throw new Error('Master key ID, sub-wallet index, and new nickname are required');
          }
          await walletManager.renameSubWallet(masterKeyId, subWalletIndex, newNickname);
          sendResponse({ success: true });
        } catch (error) {
          console.error('[Background] RENAME_SUB_WALLET - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to rename sub-wallet'
          });
        }
        break;

      case 'TOGGLE_MASTER_KEY_EXPANDED':
        try {
          const { masterKeyId } = message;
          if (!masterKeyId) {
            throw new Error('Master key ID is required');
          }
          await walletManager.toggleMasterKeyExpanded(masterKeyId);
          sendResponse({ success: true });
        } catch (error) {
          console.error('[Background] TOGGLE_MASTER_KEY_EXPANDED - Failed:', error);
          sendResponse({ success: false, error: 'Failed to toggle expansion' });
        }
        break;


      case 'SWITCH_HIERARCHICAL_WALLET':
        try {
          const { masterKeyId, subWalletIndex, pin } = message;
          if (!masterKeyId || subWalletIndex === undefined || !pin) {
            throw new Error('Master key ID, sub-wallet index, and PIN are required');
          }
          console.log('[Background] SWITCH_HIERARCHICAL_WALLET', { masterKeyId, subWalletIndex });

          const switchResult = await walletManager.switchHierarchicalWallet(
            masterKeyId,
            subWalletIndex,
            pin
          );

          sendResponse({
            success: true,
            data: {
              mnemonic: switchResult.mnemonic,
              masterKeyNickname: switchResult.masterKeyNickname,
              subWalletNickname: switchResult.subWalletNickname,
              masterKeyId,
              subWalletIndex
            }
          });
        } catch (error) {
          console.error('[Background] SWITCH_HIERARCHICAL_WALLET - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to switch wallet'
          });
        }
        break;

      case 'GET_HIERARCHICAL_WALLET_MNEMONIC':
        try {
          const { masterKeyId, subWalletIndex, pin } = message;
          if (!masterKeyId || subWalletIndex === undefined || !pin) {
            throw new Error('Master key ID, sub-wallet index, and PIN are required');
          }
          console.log('[Background] GET_HIERARCHICAL_WALLET_MNEMONIC');

          const lockout = await storageManager.checkPinLockout();
          if (lockout.locked) {
            sendResponse({
              success: false,
              error: `Too many failed attempts. Try again in ${formatLockoutDuration(lockout.remainingMs || 0)}.`
            });
            break;
          }

          const mnemonic = await walletManager.getHierarchicalWalletMnemonic(
            masterKeyId,
            subWalletIndex,
            pin
          );

          await storageManager.resetPinAttempts();
          sendResponse({ success: true, data: mnemonic });
        } catch (error) {
          await storageManager.recordFailedPin();
          const updatedLockout = await storageManager.checkPinLockout();
          console.error('[Background] GET_HIERARCHICAL_WALLET_MNEMONIC - Failed:', error);
          sendResponse({
            success: false,
            error: updatedLockout.locked
              ? `Too many failed attempts. Try again in ${formatLockoutDuration(updatedLockout.remainingMs || 0)}.`
              : (error instanceof Error ? error.message : 'Failed to get wallet mnemonic')
          });
        }
        break;

      case 'GET_ACTIVE_HIERARCHICAL_WALLET_INFO':
        try {
          const info = await walletManager.getActiveHierarchicalWalletInfo();
          sendResponse({ success: true, data: info });
        } catch (error) {
          console.error('[Background] GET_ACTIVE_HIERARCHICAL_WALLET_INFO - Failed:', error);
          sendResponse({ success: false, error: 'Failed to get active wallet info' });
        }
        break;

      case 'ADD_DISCOVERED_SUB_WALLETS':
        try {
          const { masterKeyId, subWallets } = message;
          if (!masterKeyId || !subWallets || !Array.isArray(subWallets)) {
            throw new Error('Master key ID and sub-wallets array are required');
          }
          console.log('[Background] ADD_DISCOVERED_SUB_WALLETS', {
            masterKeyId,
            count: subWallets.length
          });

          await walletManager.addDiscoveredSubWallets(masterKeyId, subWallets);
          sendResponse({ success: true });
        } catch (error) {
          console.error('[Background] ADD_DISCOVERED_SUB_WALLETS - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to add discovered sub-wallets'
          });
        }
        break;

      case 'UPDATE_SUB_WALLET_ACTIVITY':
        try {
          const { masterKeyId, subWalletIndex, hasActivity } = message;
          if (!masterKeyId || subWalletIndex === undefined || hasActivity === undefined) {
            throw new Error('Master key ID, sub-wallet index, and hasActivity are required');
          }
          console.log('[Background] UPDATE_SUB_WALLET_ACTIVITY', {
            masterKeyId,
            subWalletIndex,
            hasActivity
          });

          await storageManager.updateSubWalletActivity(masterKeyId, subWalletIndex, hasActivity);
          sendResponse({ success: true });
        } catch (error) {
          console.error('[Background] UPDATE_SUB_WALLET_ACTIVITY - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update sub-wallet activity'
          });
        }
        break;

      // ========================================
      // Wallet Archive/Restore Handlers
      // ========================================

      case 'ARCHIVE_MASTER_KEY':
        try {
          const { masterKeyId } = message;
          if (!masterKeyId) {
            throw new Error('Master key ID is required');
          }
          console.log('[Background] ARCHIVE_MASTER_KEY', { masterKeyId });

          await storageManager.archiveMasterKey(masterKeyId);
          console.log('[Background] ARCHIVE_MASTER_KEY - Wallet archived successfully');
          sendResponse({ success: true });
        } catch (error) {
          console.error('[Background] ARCHIVE_MASTER_KEY - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to archive wallet'
          });
        }
        break;

      case 'RESTORE_ARCHIVED_MASTER_KEY':
        try {
          const { masterKeyId } = message;
          if (!masterKeyId) {
            throw new Error('Master key ID is required');
          }
          console.log('[Background] RESTORE_ARCHIVED_MASTER_KEY', { masterKeyId });

          await storageManager.restoreArchivedMasterKey(masterKeyId);
          console.log('[Background] RESTORE_ARCHIVED_MASTER_KEY - Wallet restored successfully');
          sendResponse({ success: true });
        } catch (error) {
          console.error('[Background] RESTORE_ARCHIVED_MASTER_KEY - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to restore wallet'
          });
        }
        break;

      case 'GET_ARCHIVED_WALLETS':
        try {
          console.log('[Background] GET_ARCHIVED_WALLETS');
          const archivedWallets = await storageManager.getArchivedWallets();
          console.log('[Background] GET_ARCHIVED_WALLETS - Retrieved:', { count: archivedWallets.length });
          sendResponse({ success: true, data: archivedWallets });
        } catch (error) {
          console.error('[Background] GET_ARCHIVED_WALLETS - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get archived wallets'
          });
        }
        break;

      case 'DELETE_ARCHIVED_MASTER_KEY':
        try {
          const { masterKeyId } = message;
          if (!masterKeyId) {
            throw new Error('Master key ID is required');
          }
          console.log('[Background] DELETE_ARCHIVED_MASTER_KEY', { masterKeyId });

          await storageManager.deleteArchivedMasterKey(masterKeyId);
          console.log('[Background] DELETE_ARCHIVED_MASTER_KEY - Wallet permanently deleted');
          sendResponse({ success: true });
        } catch (error) {
          console.error('[Background] DELETE_ARCHIVED_MASTER_KEY - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to delete archived wallet'
          });
        }
        break;

      case 'VERIFY_ARCHIVED_WALLET_PIN':
        try {
          const { masterKeyId, pin } = message;
          if (!masterKeyId || !pin) {
            throw new Error('Master key ID and PIN are required');
          }
          console.log('[Background] VERIFY_ARCHIVED_WALLET_PIN', { masterKeyId });

          const lockout = await storageManager.checkPinLockout();
          if (lockout.locked) {
            sendResponse({
              success: false,
              error: `Too many failed attempts. Try again in ${formatLockoutDuration(lockout.remainingMs || 0)}.`
            });
            break;
          }

          const isValid = await storageManager.verifyArchivedWalletPin(masterKeyId, pin);
          if (!isValid) {
            await storageManager.recordFailedPin();
          } else {
            await storageManager.resetPinAttempts();
          }
          console.log('[Background] VERIFY_ARCHIVED_WALLET_PIN - Result:', isValid);
          sendResponse({ success: true, data: isValid });
        } catch (error) {
          await storageManager.recordFailedPin();
          const updatedLockout = await storageManager.checkPinLockout();
          console.error('[Background] VERIFY_ARCHIVED_WALLET_PIN - Failed:', error);
          sendResponse({
            success: false,
            error: updatedLockout.locked
              ? `Too many failed attempts. Try again in ${formatLockoutDuration(updatedLockout.remainingMs || 0)}.`
              : (error instanceof Error ? error.message : 'Failed to verify PIN')
          });
        }
        break;

      // ========================================
      // Sub-Wallet Archive/Restore Handlers
      // ========================================

      case 'ARCHIVE_SUB_WALLET':
        try {
          const { masterKeyId, subWalletIndex } = message;
          if (!masterKeyId || subWalletIndex === undefined) {
            throw new Error('Master key ID and sub-wallet index are required');
          }
          console.log('[Background] ARCHIVE_SUB_WALLET', { masterKeyId, subWalletIndex });

          await storageManager.archiveSubWallet(masterKeyId, subWalletIndex);
          console.log('[Background] ARCHIVE_SUB_WALLET - Sub-wallet archived successfully');
          sendResponse({ success: true });
        } catch (error) {
          console.error('[Background] ARCHIVE_SUB_WALLET - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to archive sub-wallet'
          });
        }
        break;

      case 'RESTORE_SUB_WALLET':
        try {
          const { masterKeyId, subWalletIndex } = message;
          if (!masterKeyId || subWalletIndex === undefined) {
            throw new Error('Master key ID and sub-wallet index are required');
          }
          console.log('[Background] RESTORE_SUB_WALLET', { masterKeyId, subWalletIndex });

          await storageManager.restoreSubWallet(masterKeyId, subWalletIndex);
          console.log('[Background] RESTORE_SUB_WALLET - Sub-wallet restored successfully');
          sendResponse({ success: true });
        } catch (error) {
          console.error('[Background] RESTORE_SUB_WALLET - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to restore sub-wallet'
          });
        }
        break;

      case 'DELETE_ARCHIVED_SUB_WALLET':
        try {
          const { masterKeyId, subWalletIndex } = message;
          if (!masterKeyId || subWalletIndex === undefined) {
            throw new Error('Master key ID and sub-wallet index are required');
          }
          console.log('[Background] DELETE_ARCHIVED_SUB_WALLET', { masterKeyId, subWalletIndex });

          await storageManager.deleteArchivedSubWallet(masterKeyId, subWalletIndex);
          console.log('[Background] DELETE_ARCHIVED_SUB_WALLET - Sub-wallet permanently deleted');
          sendResponse({ success: true });
        } catch (error) {
          console.error('[Background] DELETE_ARCHIVED_SUB_WALLET - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to delete archived sub-wallet'
          });
        }
        break;

      case 'GET_ARCHIVED_SUB_WALLETS':
        try {
          console.log('[Background] GET_ARCHIVED_SUB_WALLETS');
          const archivedSubWallets = await storageManager.getArchivedSubWallets();
          console.log('[Background] GET_ARCHIVED_SUB_WALLETS - Retrieved:', { count: archivedSubWallets.length });
          sendResponse({ success: true, data: archivedSubWallets });
        } catch (error) {
          console.error('[Background] GET_ARCHIVED_SUB_WALLETS - Failed:', error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get archived sub-wallets'
          });
        }
        break;

      default:
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  } catch (error) {
    console.error('Message handler error:', error);
    sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
}

// Skip Breez SDK initialization in background service worker
// (WASM modules need DOM context which isn't available here)
console.log('Background service worker ready - Breez SDK will be initialized when needed');

// Auto-lock check on service worker activation
chrome.runtime.onStartup.addListener(async () => {
  try {
    const isUnlocked = await storageManager.isWalletUnlocked();
    if (!isUnlocked) {
      // Just ensure wallet is locked in storage
      await storageManager.lockWallet();
    }
  } catch (error) {
    console.error('Failed to check auto-lock on startup:', error);
  }
});

// ========== AUTO-LOCK TIMER USING CHROME.ALARMS ==========
// Chrome extension Manifest V3 service workers cannot use persistent setTimeout/setInterval
// Must use chrome.alarms API which survives service worker sleep cycles

const ALARM_NAME = 'wallet-auto-lock';

// Create alarm when wallet is unlocked
async function startAutoLockAlarm() {
  console.log('[AutoLock] Starting alarm - will check every minute');

  // Create alarm that fires every 1 minute
  await chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: 1 // Check every minute
  });
}

// Clear alarm when wallet is locked
async function stopAutoLockAlarm() {
  console.log('[AutoLock] Stopping alarm');
  await chrome.alarms.clear(ALARM_NAME);
}

// Handle alarm events - check if wallet should be auto-locked
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  try {
    // Get current unlock status and last activity
    const data = await chrome.storage.local.get(['isUnlocked', 'lastActivity']);

    if (!data.isUnlocked) {
      // Wallet is already locked, stop the alarm
      await stopAutoLockAlarm();
      console.log('[AutoLock] Alarm stopped - wallet already locked');
      return;
    }

    // Get user's configured auto-lock timeout from settings
    const settings = await storageManager.getUserSettings();
    const autoLockTimeoutSeconds = settings.autoLockTimeout || 900; // Default to 15 minutes if not set
    const AUTO_LOCK_DELAY_MS = autoLockTimeoutSeconds * 1000; // Convert seconds to milliseconds

    const lastActivity = data.lastActivity || 0;
    const elapsed = Date.now() - lastActivity;

    console.log(`[AutoLock] Alarm check - elapsed: ${Math.floor(elapsed / 1000)}s / ${AUTO_LOCK_DELAY_MS / 1000}s (configured: ${autoLockTimeoutSeconds}s)`);

    // Check if configured timeout has elapsed since last activity
    if (elapsed > AUTO_LOCK_DELAY_MS) {
      console.log(`⏰ [AutoLock] ${autoLockTimeoutSeconds}s TIMEOUT ELAPSED - locking wallet`);

      // Lock the wallet
      await chrome.storage.local.set({ isUnlocked: false });

      // Stop the alarm
      await stopAutoLockAlarm();

      // Send message to popup if it's open to update UI
      try {
        await chrome.runtime.sendMessage({ type: 'WALLET_LOCKED_AUTO' });
      } catch (error) {
        // Popup not open, that's fine
        console.log('[AutoLock] Popup not open, wallet locked in storage only');
      }
    }
  } catch (error) {
    console.error('[AutoLock] Alarm check error:', error);
  }
});

// Listen for wallet unlock to start alarm
// NOTE: This needs to return false for unhandled messages so main handler can process them
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_AUTO_LOCK_ALARM') {
    startAutoLockAlarm();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'STOP_AUTO_LOCK_ALARM') {
    stopAutoLockAlarm();
    sendResponse({ success: true });
    return true;
  }
  
  // Return false to indicate we're not handling this message
  // This allows the main message handler to process it
  return false;
});
