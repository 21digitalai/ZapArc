// Popup Main Entry Point
// Coordinates all popup modules and handles initialization

// CSS import - required for webpack to bundle the styles
import './popup.css';

// State imports
import {
    breezSDK,
    setBreezSDK,
    isWalletUnlocked,
    setIsWalletUnlocked,
    currentBalance,
    setCurrentBalance,
    generatedMnemonic,
    setGeneratedMnemonic,
    mnemonicWords,
    setMnemonicWords,
    selectedWords,
    setSelectedWords,
    userPin,
    setUserPin,
    clearSensitiveWizardState,
    sessionPin,
    setSessionPin,
    isAddingWallet,
    setIsAddingWallet,
    isImportingWallet,
    setIsImportingWallet,
    currentWallets,
    setCurrentWallets,
    BIP39_WORDS,
    setIsSDKInitialized,
    getMasterKeys,
    setActiveMasterKeyId,
    setActiveSubWalletIndex,
} from './state';

// SDK imports
import { connectBreezSDK, disconnectBreezSDK, setSdkEventCallbacks, claimPendingDepositsNow } from './sdk';

// Notification imports
import { showNotification, showError, showSuccess, showInfo } from './notifications';

// UI helper imports
import { showBalanceLoading, hideBalanceLoading, showTransactionsLoading, clearWalletDisplay } from './ui-helpers';

// Modal imports
import { setupModalListeners, showPINModal, promptForPIN, promptForText } from './modals';

// Utility imports
import { createDebounce, PIN_AUTO_CONFIRM_DELAY_MS } from '../utils/debounce';

// Wallet Management imports
import {
    initializeMultiWalletUI,
    showWalletSwitchingIndicator,
    showWalletManagementInterface,
    hideWalletManagementInterface,
    loadWalletManagementList,
    handleRenameSave,
    hideRenameInterface,
    setWalletManagementCallbacks,
    startSubWalletDiscovery,
    markWalletForDiscovery,
    resumePendingDiscovery,
} from './wallet-management';

// Wallet Selection imports
import { showWalletSelectionInterface } from './wallet-selection';

// Deposit imports
import {
    showDepositInterface,
    hideDepositInterface,
    setDepositCallbacks,
    handlePaymentReceivedFromSDK
} from './deposit';
import { getClaimKey, getProvisionalClaims, mergeClaimRows, removeProvisionalClaim } from './onchain-claim-lifecycle';
import { extractLnurlPaymentComment, loadPaymentComment, renderPaymentCommentDetailRow } from './payment-comment';

// Withdrawal imports
import {
    showWithdrawalInterface,
    hideWithdrawInterface,
    setWithdrawalCallbacks,
} from './withdrawal';

// Contacts imports
import { initializeContactsUI, showContactsInterface } from './contacts';
import { hideAllViews } from './view-manager';

// Utility imports
import { ExtensionMessaging } from '../utils/messaging';
import { ChromeStorageManager } from '../utils/storage';
import * as bip39 from 'bip39';
import type { LightningAddressInfo, UserSettings } from '../types';
import { satsToFiat, formatFiat, type FiatCurrency } from '../utils/currency';

// Helper to generate mnemonic
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


// ========================================
// Balance & Transaction Functions
// ========================================

// Transaction data storage for detail view
interface StoredTransaction {
    id: string;
    type: 'receive' | 'send';
    amount: number;
    timestamp: number;
    status: string;
    description?: string;
    method?: string;
    feeSats?: number;
    onchainFeeSats?: number;
    paymentHash?: string;
    preimage?: string;
    bolt11?: string;
    txid?: string;
    vout?: number;
    confirmations?: number;
    claimStatus?: 'confirming' | 'claiming' | 'retrying' | 'too-small';
    claimMessage?: string;
    requiredConfirmations?: number;
    comment?: string;
}

let storedTransactions: StoredTransaction[] = [];

function getTransactionEmptyStateHtml(message: string = 'No transactions yet', subtitle: string = 'Send or receive your first payment'): string {
    return `<div class="no-transactions"><div class="empty-icon">⚡</div><div class="empty-title">${message}</div><div class="empty-subtitle">${subtitle}</div></div>`;
}

const lightningAddressStorage = new ChromeStorageManager();
const LIGHTNING_ADDRESS_USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/;
let currentLightningAddressInfo: LightningAddressInfo | null = null;
let lastDepositClaimCheckAt = 0;
const DEPOSIT_CLAIM_CHECK_INTERVAL_MS = 30_000;

async function getActiveWalletId(): Promise<string | null> {
    const result = await chrome.storage.local.get(['multiWalletData']);
    if (!result.multiWalletData) return null;

    try {
        const multiWalletData = JSON.parse(result.multiWalletData);
        return typeof multiWalletData.activeWalletId === 'string' ? multiWalletData.activeWalletId : null;
    } catch (error) {
        console.warn('[Popup] Failed to parse multiWalletData for active wallet id:', error);
        return null;
    }
}

import { getUserFiatCurrency, getDisplayCurrency, setFiatCurrencyCache, persistFiatCurrency } from './currency-pref';

/** Get wallet cache key that includes sub-wallet index to avoid cross-wallet cache hits */
function walletCacheKey(prefix: string, walletId: string, subIndex?: number): string {
    const idx = subIndex ?? 0;
    return idx > 0 ? `${prefix}_${walletId}_sub${idx}` : `${prefix}_${walletId}`;
}

function validateLightningAddressUsername(username: string): { isValid: boolean; error?: string; normalized: string } {
    const normalized = username.trim().toLowerCase();

    if (!normalized) {
        return { isValid: false, error: 'Username cannot be empty', normalized };
    }

    if (normalized.length < 3) {
        return { isValid: false, error: 'Username must be at least 3 characters', normalized };
    }

    if (normalized.length > 32) {
        return { isValid: false, error: 'Username must be 32 characters or less', normalized };
    }

    if (!LIGHTNING_ADDRESS_USERNAME_PATTERN.test(normalized)) {
        if (!/^[a-z0-9]/.test(normalized)) {
            return { isValid: false, error: 'Username must start with a letter or number', normalized };
        }
        if (!/[a-z0-9]$/.test(normalized)) {
            return { isValid: false, error: 'Username must end with a letter or number', normalized };
        }
        if (/[^a-z0-9_-]/.test(normalized)) {
            return { isValid: false, error: 'Only letters, numbers, hyphens, and underscores are allowed', normalized };
        }
        return { isValid: false, error: 'Invalid username format', normalized };
    }

    return { isValid: true, normalized };
}

function renderHomeLightningAddress(): void {
    const container = document.getElementById('home-ln-address');
    const textEl = document.getElementById('home-ln-address-text');
    if (!container || !textEl) return;

    if (currentLightningAddressInfo?.lightningAddress) {
        textEl.textContent = currentLightningAddressInfo.lightningAddress;
        container.classList.remove('hidden');
    } else {
        container.classList.add('hidden');
    }
}

function renderLightningAddressUI(): void {
    const section = document.getElementById('lightning-address-section');
    const unregistered = document.getElementById('lightning-address-unregistered');
    const registered = document.getElementById('lightning-address-registered');
    const addressValue = document.getElementById('lightning-address-value');
    const status = document.getElementById('lightning-address-status');

    if (!section || !unregistered || !registered || !addressValue || !status) {
        return;
    }

    status.classList.add('hidden');
    status.textContent = '';

    if (currentLightningAddressInfo?.lightningAddress) {
        unregistered.classList.add('hidden');
        registered.classList.remove('hidden');
        addressValue.textContent = currentLightningAddressInfo.lightningAddress;
    } else {
        registered.classList.add('hidden');
        unregistered.classList.remove('hidden');
        addressValue.textContent = '';
    }

    // Also update home screen LN address display
    renderHomeLightningAddress();
}

function setLightningAddressStatus(message: string): void {
    const status = document.getElementById('lightning-address-status');
    if (!status) return;
    status.textContent = message;
    status.classList.remove('hidden');
}

async function refreshLightningAddress(forceSDK: boolean = false): Promise<void> {
    const section = document.getElementById('lightning-address-section');
    if (!section) return;

    const activeWalletId = await getActiveWalletId();
    if (!activeWalletId) {
        currentLightningAddressInfo = null;
        renderLightningAddressUI();
        return;
    }

    if (!forceSDK) {
        const cached = await lightningAddressStorage.getCachedLightningAddress(activeWalletId);
        if (cached) {
            currentLightningAddressInfo = cached;
            renderLightningAddressUI();
        }
    }

    if (!breezSDK) {
        renderLightningAddressUI();
        return;
    }

    try {
        const sdkAny = breezSDK as any;
        const result = await sdkAny.getLightningAddress();

        if (result?.lightningAddress) {
            currentLightningAddressInfo = {
                lightningAddress: result.lightningAddress,
                username: result.username || result.lightningAddress.split('@')[0] || '',
                description: result.description || '',
                lnurl: result.lnurl || ''
            };
            await lightningAddressStorage.cacheLightningAddress(activeWalletId, currentLightningAddressInfo);
        } else {
            currentLightningAddressInfo = null;
            await lightningAddressStorage.clearCachedLightningAddress(activeWalletId);
        }
    } catch (error) {
        console.warn('[Popup] getLightningAddress failed (likely unavailable on current SDK):', error);
    }

    renderLightningAddressUI();
}

async function handleRegisterLightningAddress(): Promise<void> {
    if (!breezSDK) {
        showError('Wallet not connected');
        return;
    }

    const input = document.getElementById('lightning-address-username-input') as HTMLInputElement | null;
    const registerBtn = document.getElementById('lightning-address-register-btn') as HTMLButtonElement | null;
    if (!input || !registerBtn) return;

    const { isValid, error, normalized } = validateLightningAddressUsername(input.value);
    if (!isValid) {
        showError(error || 'Invalid username');
        return;
    }

    try {
        registerBtn.disabled = true;
        registerBtn.textContent = 'Checking...';
        setLightningAddressStatus('Checking username availability...');

        const sdkAny = breezSDK as any;
        const available = await sdkAny.checkLightningAddressAvailable({ username: normalized });
        if (!available) {
            showError('This username is already taken');
            setLightningAddressStatus('Username is not available');
            return;
        }

        registerBtn.textContent = 'Registering...';
        const result = await sdkAny.registerLightningAddress({ username: normalized, description: '' });

        currentLightningAddressInfo = {
            lightningAddress: result?.lightningAddress || `${normalized}@breez.tips`,
            username: result?.username || normalized,
            description: result?.description || '',
            lnurl: result?.lnurl || ''
        };

        const activeWalletId = await getActiveWalletId();
        if (activeWalletId) {
            await lightningAddressStorage.cacheLightningAddress(activeWalletId, currentLightningAddressInfo);
        }

        input.value = '';
        renderLightningAddressUI();
        showSuccess(`Lightning Address registered: ${currentLightningAddressInfo.lightningAddress}`);
    } catch (error) {
        console.error('[Popup] Failed to register Lightning Address:', error);
        showError(error instanceof Error ? error.message : 'Failed to register Lightning Address');
    } finally {
        registerBtn.disabled = false;
        registerBtn.textContent = 'Register';
    }
}

async function handleUnregisterLightningAddress(): Promise<void> {
    if (!breezSDK || !currentLightningAddressInfo?.lightningAddress) {
        return;
    }

    try {
        const sdkAny = breezSDK as any;
        if (typeof sdkAny.unregisterLightningAddress === 'function') {
            await sdkAny.unregisterLightningAddress();
        } else {
            await sdkAny.deleteLightningAddress();
        }

        const activeWalletId = await getActiveWalletId();
        if (activeWalletId) {
            await lightningAddressStorage.clearCachedLightningAddress(activeWalletId);
        }

        currentLightningAddressInfo = null;
        renderLightningAddressUI();
        showSuccess('Lightning Address unregistered');
    } catch (error) {
        console.error('[Popup] Failed to unregister Lightning Address:', error);
        showError(error instanceof Error ? error.message : 'Failed to unregister Lightning Address');
    }
}

function setBalanceLoading(loading: boolean): void {
    const balanceLoading = document.getElementById('balance-loading');
    const balanceEl = document.getElementById('balance');
    if (balanceLoading) {
        if (loading) balanceLoading.classList.remove('hidden');
        else balanceLoading.classList.add('hidden');
    }
    if (balanceEl) {
        // Keep numeric text untouched; just visually soften while loading.
        balanceEl.classList.toggle('loading', loading);
    }
}

async function updateBalanceDisplay(forceClaimCheck: boolean = false) {
    console.log('🔍 [Popup] Updating balance display...');

    const balanceElement = document.getElementById('balance');
    const balanceFiatElement = document.getElementById('balance-fiat');
    const shouldShowLoader = balanceElement?.textContent?.includes('--') ?? false;
    if (shouldShowLoader) setBalanceLoading(true);

    try {
        if (!breezSDK) {
            console.warn('[Popup] SDK not connected - cannot update balance');
            setBalanceLoading(false);
            return;
        }

        // Proactively claim on-chain deposits (covers cases where event misses)
        const now = Date.now();
        const shouldClaim = forceClaimCheck || (now - lastDepositClaimCheckAt > DEPOSIT_CLAIM_CHECK_INTERVAL_MS);
        if (shouldClaim) {
            lastDepositClaimCheckAt = now;
            void claimPendingDepositsNow(breezSDK, forceClaimCheck ? 'manual refresh' : 'periodic balance refresh');
        }

        // Get fresh balance from SDK (ensure synced for accurate total)
        const walletInfo = await breezSDK.getInfo({ ensureSynced: true });
        const balance = walletInfo?.balanceSats || 0;

        console.log('💰 [Popup] Fresh balance from SDK:', balance);

        // Update state
        setCurrentBalance(balance);

        // Update UI according to display currency
        if (balanceElement && balanceFiatElement) {
            const displayCurrency = await getDisplayCurrency();

            if (displayCurrency === 'sats') {
                balanceElement.textContent = `${balance.toLocaleString()} sats`;
                balanceFiatElement.classList.add('hidden');
            } else {
                const fiatAmount = await satsToFiat(balance, displayCurrency);
                if (fiatAmount !== null) {
                    const fiatDisplay = formatFiat(fiatAmount, displayCurrency);
                    balanceElement.textContent = `${balance.toLocaleString()} sats`;
                    balanceFiatElement.textContent = fiatDisplay;
                    balanceFiatElement.classList.remove('hidden');

                    const fiatCacheUpdate: Record<string, any> = {
                        cachedBalanceFiat: {
                            currency: displayCurrency,
                            balanceSats: balance,
                            display: fiatDisplay,
                            updatedAt: Date.now()
                        }
                    };
                    try {
                        const mw = await chrome.storage.local.get(['multiWalletData']);
                        if (mw.multiWalletData) {
                            const mwd = JSON.parse(mw.multiWalletData);
                            if (mwd.activeWalletId) {
                                const subIdx = mwd.activeSubWalletIndex || 0;
                                fiatCacheUpdate[walletCacheKey('cachedBalanceFiat', mwd.activeWalletId, subIdx)] = fiatCacheUpdate.cachedBalanceFiat;
                            }
                        }
                        await chrome.storage.local.set(fiatCacheUpdate);
                    } catch (e) { /* ignore cache errors */ }
                } else {
                    balanceElement.textContent = `${balance.toLocaleString()} sats`;
                    balanceFiatElement.classList.add('hidden');
                }
            }
        }

        setBalanceLoading(false);

        // Also update withdraw balance display if visible
        const withdrawBalanceElement = document.getElementById('withdraw-balance-display');
        if (withdrawBalanceElement) {
            withdrawBalanceElement.textContent = balance.toLocaleString();
        }

        // Cache balance for faster loading next time (wallet-specific + legacy key)
        const balanceCacheUpdate: Record<string, any> = { cachedBalance: balance };
        const mwResult = await chrome.storage.local.get(['multiWalletData']);
        if (mwResult.multiWalletData) {
            try {
                const mwd = JSON.parse(mwResult.multiWalletData);
                if (mwd.activeWalletId) {
                    const subIdx = mwd.activeSubWalletIndex || 0;
                    balanceCacheUpdate[walletCacheKey('cachedBalance', mwd.activeWalletId, subIdx)] = balance;
                }
            } catch (e) { /* ignore */ }
        }
        await chrome.storage.local.set(balanceCacheUpdate);

    } catch (error) {
        console.error('❌ [Popup] Error updating balance:', error);
        setBalanceLoading(false);
    }
}

async function loadTransactionHistory() {
    console.log('🔍 [Popup] Loading transaction history...');

    const transactionList = document.getElementById('transaction-list');
    if (!transactionList) {
        console.warn('[Popup] Transaction list element not found');
        return;
    }

    try {
        if (!breezSDK) {
            transactionList.innerHTML = getTransactionEmptyStateHtml('Wallet not connected', 'Unlock your wallet to view activity');
            storedTransactions = [];
            return;
        }

        // Show cached transactions instantly while SDK fetches fresh data
        try {
            const mwResult = await chrome.storage.local.get(['multiWalletData']);
            if (mwResult.multiWalletData) {
                const mwd = JSON.parse(mwResult.multiWalletData);
                const wid = mwd.activeWalletId;
                const subIdx = mwd.activeSubWalletIndex || 0;
                if (wid) {
                    const txCacheKey = walletCacheKey('cachedTransactions', wid, subIdx);
                    const cachedData = await chrome.storage.local.get([txCacheKey]);
                    const cached = cachedData[txCacheKey];
                    if (cached && cached.length > 0 && storedTransactions.length === 0) {
                        storedTransactions = cached as StoredTransaction[];
                        renderTransactionList(transactionList, storedTransactions.slice(0, 5));
                    }
                }
            }
        } catch (e) { /* ignore cache errors */ }

        // Get payments from SDK
        const response = await breezSDK.listPayments({});
        const payments = response?.payments || [];

        console.log(`📋 [Popup] Loaded ${payments.length} transactions`);
        if (payments.length > 0) {
            console.log('🔍 [Popup] Raw first payment keys:', Object.keys(payments[0]));
            console.log('🔍 [Popup] Raw first payment:', JSON.stringify(payments[0], (_, v) => typeof v === 'bigint' ? v.toString() : v));
        }

        // Debug helper for Breez support: log all payments with IDs/status/age
        const supportDump = payments.slice(0, 100).map((p: any) => {
            const tsSec = Number(p?.timestamp || 0);
            const ageSec = tsSec > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - tsSec) : -1;
            return {
                id: p?.id,
                paymentType: p?.paymentType,
                status: p?.status,
                amountSats: Number(p?.amount ?? 0),
                feesSats: Number(p?.fees ?? 0),
                method: p?.method,
                timestamp: tsSec,
                ageSec,
            };
        });

        console.warn(`🧾 [Support] Full payment dump count: ${supportDump.length}/${payments.length}`);
        console.warn('🧾 [Support] Payment debug dump:\n' + JSON.stringify(supportDump, null, 2));

        if (payments.length === 0 && getProvisionalClaims().length === 0) {
            transactionList.innerHTML = getTransactionEmptyStateHtml();
            storedTransactions = [];

            // Cache the empty state so we don't show loading on next open
            const multiWalletResult = await chrome.storage.local.get(['multiWalletData']);
            if (multiWalletResult.multiWalletData) {
                try {
                    const multiWalletData = JSON.parse(multiWalletResult.multiWalletData);
                    const activeWalletId = multiWalletData.activeWalletId;
                    const activeSubWalletIndex = multiWalletData.activeSubWalletIndex || 0;
                    if (activeWalletId) {
                        const cacheCheckedKey = walletCacheKey('cachedTransactionsChecked', activeWalletId, activeSubWalletIndex);
                        await chrome.storage.local.set({ [cacheCheckedKey]: true });
                    }
                } catch (e) {
                    // Ignore cache errors
                }
            }
            return;
        }

        // Sort by timestamp (most recent first)
        const sortedPayments = [...payments].sort((a: any, b: any) =>
            (b.timestamp || 0) - (a.timestamp || 0)
        );

        // Store full transaction data for detail view
        const walletContext = JSON.parse((await chrome.storage.local.get(['multiWalletData'])).multiWalletData || '{}');
        const commentWalletId = walletContext.activeWalletId || null;
        const commentSubWalletIndex = Number(walletContext.activeSubWalletIndex || 0);
        storedTransactions = await Promise.all(sortedPayments.map(async (payment: any, index: number) => {
            const isReceive = payment.paymentType === 'receive';
            const method = payment.method || payment.paymentMethod?.type || payment.details?.type || undefined;
            const confirmations =
                payment.confirmationCount ??
                payment.confirmations ??
                payment.details?.confirmationCount ??
                payment.details?.confirmations ??
                undefined;

            const rawStatus = String(payment.status || '').toLowerCase();
            const methodLower = method ? String(method).toLowerCase() : '';
            const isOnchain = methodLower === 'withdraw' || methodLower === 'deposit' ||
                methodLower.includes('bitcoin') || methodLower.includes('onchain') ||
                !!(payment.details?.txId || payment.details?.txid || payment.txid || payment.details?.txHash);

            // If SDK omits status for on-chain sends, treat as pending/confirming by default.
            let normalizedStatus = rawStatus || (isOnchain && !isReceive ? 'pending' : 'completed');

            // On-chain SENDS: SDK marks as "completed" immediately (internal Spark transfer done),
            // but the actual L1 tx may still be unconfirmed. Show as pending for first 2 hours.
            if (isOnchain && !isReceive && normalizedStatus === 'completed') {
                const txTimestamp = (payment.timestamp || 0) * 1000;
                const ageMs = txTimestamp > 0 ? Date.now() - txTimestamp : 0;
                const TWO_HOURS = 2 * 60 * 60 * 1000;
                if (ageMs < TWO_HOURS || ageMs === 0) {
                    normalizedStatus = 'pending';
                }
            }

            const senderComment = await loadPaymentComment(commentWalletId, commentSubWalletIndex, payment.id);
            return {
                id: payment.id || `tx-${index}`,
                type: isReceive ? 'receive' : 'send',
                amount: Number(payment.amount ?? payment.amountSats ?? 0),
                timestamp: (payment.timestamp || 0) * 1000,
                status: normalizedStatus,
                description: payment.description || undefined,
                method,
                feeSats: Number(payment.fees ?? payment.feeSats ?? 0) || undefined,
                onchainFeeSats: payment.details?.onchainFeeSats || payment.details?.feeSats || undefined,
                paymentHash: payment.paymentHash || payment.details?.paymentHash || undefined,
                preimage: payment.preimage || payment.details?.preimage || undefined,
                bolt11: payment.bolt11 || payment.details?.bolt11 || undefined,
                txid: payment.details?.txId || payment.details?.txid || payment.txid || payment.details?.txHash || undefined,
                confirmations: typeof confirmations === 'number' ? confirmations : undefined,
                vout: typeof (payment.details?.vout ?? payment.vout) === 'number' ? (payment.details?.vout ?? payment.vout) : undefined,
                comment: senderComment || extractLnurlPaymentComment(payment),
            } as StoredTransaction;
        }));

        const completedClaimKeys = new Set<string>();
        storedTransactions.forEach((transaction) => {
            if (transaction.txid && transaction.vout !== undefined) {
                completedClaimKeys.add(getClaimKey(transaction.txid, transaction.vout));
            }
        });
        mergeClaimRows(getProvisionalClaims(), completedClaimKeys).forEach((claim) => {
            storedTransactions.unshift({
                id: `claim-${claim.key}`,
                type: 'receive',
                amount: claim.amountSats,
                timestamp: Date.now(),
                status: 'pending',
                method: 'deposit',
                txid: claim.txid,
                vout: claim.vout,
                confirmations: claim.confirmations,
                requiredConfirmations: claim.requiredConfirmations,
                claimStatus: claim.status === 'claimed' ? 'claiming' : claim.status,
                claimMessage: claim.message,
            });
        });
        completedClaimKeys.forEach(removeProvisionalClaim);

        // Cache for faster loading (wallet-specific)
        const multiWalletResult = await chrome.storage.local.get(['multiWalletData']);
        let activeWalletId = null;
        let activeSubWalletIndex = 0;

        if (multiWalletResult.multiWalletData) {
            try {
                const multiWalletData = JSON.parse(multiWalletResult.multiWalletData);
                activeWalletId = multiWalletData.activeWalletId;
                activeSubWalletIndex = multiWalletData.activeSubWalletIndex || 0;
            } catch (e) {
                console.error('⚠️ [Popup] Failed to parse multiWalletData for caching:', e);
            }
        }

        if (activeWalletId) {
            const cacheKey = walletCacheKey('cachedTransactions', activeWalletId, activeSubWalletIndex);
            await chrome.storage.local.set({ [cacheKey]: storedTransactions.slice(0, 10) });

            if (activeSubWalletIndex > 0) {
                const hasTransactions = payments.length > 0;
                ExtensionMessaging.updateSubWalletActivity(activeWalletId, activeSubWalletIndex, hasTransactions).catch(e =>
                    console.warn('[Popup] Failed to update hasActivity flag:', e)
                );
            }
        }

        // Render to UI (only first 10)
        renderTransactionList(transactionList, storedTransactions.slice(0, 5));

    } catch (error) {
        console.error('❌ [Popup] Error loading transactions:', error);
        transactionList.innerHTML = getTransactionEmptyStateHtml('Error loading transactions', 'Please try refreshing');
        storedTransactions = [];
    }
}

function isOnchainTransaction(tx: Pick<StoredTransaction, 'method' | 'txid'>): boolean {
    const method = (tx.method || '').toLowerCase();
    return !!tx.txid || method.includes('bitcoin') || method.includes('onchain') || method.includes('btc') || method.includes('deposit') || method.includes('withdraw');
}

function getTransactionStatus(tx: StoredTransaction): { label: string; className: string } {
    if (tx.claimStatus === 'too-small') return { label: 'Too small to claim', className: 'tx-status-failed' };
    if (tx.claimStatus === 'retrying') return { label: 'Retrying', className: 'tx-status-pending' };
    if (tx.claimStatus === 'claiming') return { label: 'Claiming', className: 'tx-status-pending' };
    if (tx.claimStatus === 'confirming') {
        const progress = tx.confirmations !== undefined ? ` ${tx.confirmations}/${tx.requiredConfirmations || 3}` : '';
        return { label: `Confirming${progress}`, className: 'tx-status-pending' };
    }
    const status = (tx.status || '').toLowerCase();
    if (status === 'failed' || status === 'error') return { label: 'Failed', className: 'tx-status-failed' };
    if (status.includes('complete') || status.includes('success')) return { label: '', className: '' };
    // For on-chain sends, keep visible as confirming/pending until confirmations appear.
    if (status === 'pending') {
        if (tx.confirmations !== undefined && tx.confirmations >= 1) return { label: '', className: '' };
        const isOnchain = isOnchainTransaction(tx);
        return { label: isOnchain ? 'Confirming' : 'Pending', className: 'tx-status-pending' };
    }
    if (status === 'confirming' || status === 'mempool') return { label: 'Confirming', className: 'tx-status-pending' };
    if (tx.confirmations !== undefined && tx.confirmations === 0) return { label: 'Confirming', className: 'tx-status-pending' };
    return { label: '', className: '' };
}

function renderTransactionList(container: HTMLElement, transactions: StoredTransaction[]): void {
    container.innerHTML = transactions.map((tx, index) => {
        const isReceive = tx.type === 'receive';
        const isOnchain = isOnchainTransaction(tx);
        const timestamp = new Date(tx.timestamp).toLocaleString();
        const txStatus = getTransactionStatus(tx);

        return `<div class="transaction-item ${isReceive ? 'receive' : 'send'}" data-tx-index="${index}">
<div class="transaction-icon">${isOnchain ? '⛓️' : '⚡'}</div>
<div class="transaction-details">
<div class="transaction-type">${isReceive ? 'Received' : 'Sent'}${txStatus.label ? ` · <span class="${txStatus.className}">${txStatus.label}</span>` : ''}</div>
<div class="transaction-time">${timestamp}</div>
</div>
<div class="transaction-amount-col">
<div class="transaction-amount ${isReceive ? 'positive' : 'negative'}">
${isReceive ? '+' : '-'}${tx.amount.toLocaleString()} sats
</div>
<div class="transaction-fiat" data-sats="${tx.amount}"></div>
</div>
</div>`;
    }).join('');

    // Populate secondary amount display according to global display currency
    getDisplayCurrency().then(displayCurrency => {
        container.querySelectorAll('.transaction-fiat').forEach(async (el) => {
            const sats = parseInt((el as HTMLElement).dataset.sats || '0', 10);
            if (sats <= 0) return;

            if (displayCurrency === 'sats') {
                (el as HTMLElement).textContent = '';
                return;
            }

            const fiatAmount = await satsToFiat(sats, displayCurrency);
            if (fiatAmount !== null) {
                (el as HTMLElement).textContent = `≈ ${formatFiat(fiatAmount, displayCurrency)}`;
            }
        });
    });

    // Add click handlers to transaction items
    container.querySelectorAll('.transaction-item').forEach((item) => {
        item.addEventListener('click', () => {
            const index = parseInt(item.getAttribute('data-tx-index') || '0', 10);
            const tx = transactions[index];
            if (tx) {
                showTransactionDetail(tx);
            }
        });
    });
}

// ========================================
// Transaction Detail & History Functions
// ========================================

function showTransactionDetail(tx: StoredTransaction): void {
    console.log('[Popup] Showing transaction detail:', tx.id);

    const modal = document.getElementById('transaction-detail-modal');
    const content = document.getElementById('tx-detail-content');
    const overlay = document.getElementById('modal-overlay');

    if (!modal || !content || !overlay) return;

    const isReceive = tx.type === 'receive';
    const isOnchain = isOnchainTransaction(tx);
    const date = new Date(tx.timestamp);
    const dateStr = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    // Build status display
    let statusClass = 'completed';
    let statusIcon = '✓';
    let statusText = 'Completed';
    if (tx.claimStatus === 'too-small') {
        statusClass = 'failed';
        statusIcon = '⚠';
        statusText = 'Too small to claim';
    } else if (tx.claimStatus === 'retrying') {
        statusClass = 'pending';
        statusIcon = '⏳';
        statusText = 'Retrying';
    } else if (tx.claimStatus === 'claiming') {
        statusClass = 'pending';
        statusIcon = '⏳';
        statusText = 'Claiming';
    } else if (tx.claimStatus === 'confirming') {
        statusClass = 'pending';
        statusIcon = '⏳';
        statusText = tx.confirmations !== undefined ? `Confirming ${tx.confirmations}/${tx.requiredConfirmations || 3}` : 'Confirming';
    } else if (tx.status === 'pending' || tx.status === 'confirming' || tx.status === 'mempool') {
        statusClass = 'pending';
        statusIcon = '⏳';
        statusText = isOnchain ? 'Confirming' : 'Pending';
    } else if (tx.status === 'failed') {
        statusClass = 'failed';
        statusIcon = '✗';
        statusText = 'Failed';
    }

    // Build detail rows
    let detailRows = `
        <div class="tx-detail-row">
            <span class="tx-detail-label">Type</span>
            <span class="tx-detail-value">${isReceive ? 'Received' : 'Sent'} (${isOnchain ? 'On-chain' : 'Lightning'})</span>
        </div>
        <div class="tx-detail-row">
            <span class="tx-detail-label">Date</span>
            <span class="tx-detail-value">${dateStr}</span>
        </div>
        <div class="tx-detail-row">
            <span class="tx-detail-label">Time</span>
            <span class="tx-detail-value">${timeStr}</span>
        </div>
    `;

    if (tx.description) {
        detailRows += `
            <div class="tx-detail-row">
                <span class="tx-detail-label">Description</span>
                <span class="tx-detail-value">${escapeHtml(tx.description)}</span>
            </div>
        `;
    }

    if (tx.comment && tx.comment.trim() !== (tx.description || '').trim()) {
        detailRows += renderPaymentCommentDetailRow(tx.comment, escapeHtml);
    }

    if (tx.feeSats !== undefined && tx.feeSats > 0) {
        detailRows += `
            <div class="tx-detail-row">
                <span class="tx-detail-label">Fee</span>
                <span class="tx-detail-value">${tx.feeSats.toLocaleString()} sats</span>
            </div>
        `;
    }

    if (isOnchain && tx.onchainFeeSats !== undefined && tx.onchainFeeSats > 0) {
        detailRows += `
            <div class="tx-detail-row">
                <span class="tx-detail-label">On-chain Fee</span>
                <span class="tx-detail-value">${tx.onchainFeeSats.toLocaleString()} sats</span>
            </div>
        `;
    }

    if (isOnchain && tx.confirmations !== undefined) {
        detailRows += `
            <div class="tx-detail-row">
                <span class="tx-detail-label">Confirmations</span>
                <span class="tx-detail-value">${tx.confirmations}${tx.requiredConfirmations ? `/${tx.requiredConfirmations}` : ''}</span>
            </div>
        `;
    }

    if (isOnchain && tx.txid) {
        const truncatedTxid = tx.txid.slice(0, 16) + '...' + tx.txid.slice(-8);
        const explorerUrl = `https://mempool.space/tx/${tx.txid}`;
        detailRows += `
            <div class="tx-detail-row">
                <span class="tx-detail-label">Transaction ID</span>
                <span class="tx-detail-value">
                    <span class="tx-detail-value-with-copy">
                        <span>${truncatedTxid}</span>
                        <button class="tx-copy-btn" data-copy="${tx.txid}">Copy</button>
                    </span>
                </span>
            </div>
            <div class="tx-detail-row">
                <span class="tx-detail-label">Explorer</span>
                <span class="tx-detail-value"><a href="${explorerUrl}" target="_blank" rel="noopener noreferrer">View on Explorer</a></span>
            </div>
        `;
    } else if (tx.paymentHash) {
        const truncatedHash = tx.paymentHash.slice(0, 16) + '...' + tx.paymentHash.slice(-8);
        detailRows += `
            <div class="tx-detail-row">
                <span class="tx-detail-label">Payment Hash</span>
                <span class="tx-detail-value">
                    <span class="tx-detail-value-with-copy">
                        <span>${truncatedHash}</span>
                        <button class="tx-copy-btn" data-copy="${tx.paymentHash}">Copy</button>
                    </span>
                </span>
            </div>
        `;
    }

    content.innerHTML = `
        <div class="tx-detail-amount-section">
            <div class="tx-detail-icon ${isReceive ? 'receive' : 'send'}">
                ${isReceive ? '⬇️' : '⬆️'}
            </div>
            <div class="tx-detail-amount ${isReceive ? 'positive' : 'negative'}">
                ${isReceive ? '+' : '-'}${tx.amount.toLocaleString()} sats
            </div>
            <div class="tx-detail-fiat-estimate" id="tx-detail-fiat"></div>
            <div class="tx-detail-status ${statusClass}">
                ${statusIcon} ${statusText}
            </div>
        </div>
        <div class="tx-detail-rows">
            ${detailRows}
        </div>
    `;

    // Async: populate secondary estimate for fiat display modes
    getDisplayCurrency().then(displayCurrency => {
        const fiatEl = document.getElementById('tx-detail-fiat');
        if (!fiatEl) return;

        if (displayCurrency === 'sats') {
            fiatEl.textContent = '';
            return;
        }

        satsToFiat(tx.amount, displayCurrency).then(fiatAmount => {
            if (fiatAmount !== null) {
                fiatEl.textContent = `≈ ${formatFiat(fiatAmount, displayCurrency)}`;
            }
        });
    });

    // Add copy button handlers
    content.querySelectorAll('.tx-copy-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const textToCopy = (btn as HTMLElement).getAttribute('data-copy');
            if (textToCopy) {
                await copyToClipboard(textToCopy);
                (btn as HTMLElement).textContent = 'Copied!';
                setTimeout(() => {
                    (btn as HTMLElement).textContent = 'Copy';
                }, 2000);
            }
        });
    });

    // Show modal
    overlay.classList.remove('hidden');
    modal.classList.remove('hidden');

    // Setup close handlers
    const closeBtn = document.getElementById('tx-detail-close');
    const closeFooterBtn = document.getElementById('tx-detail-close-btn');

    const closeModal = () => {
        modal.classList.add('hidden');
        overlay.classList.add('hidden');
    };

    closeBtn?.addEventListener('click', closeModal, { once: true });
    closeFooterBtn?.addEventListener('click', closeModal, { once: true });
}

function showTransactionHistoryView(): void {
    console.log('[Popup] Showing transaction history view');

    const historyView = document.getElementById('transaction-history-view');
    const mainInterface = document.getElementById('main-interface');
    const historyList = document.getElementById('history-list');

    if (!historyView || !mainInterface || !historyList) return;

    // Hide wallet interface, show history view
    mainInterface.classList.add('hidden');
    historyView.classList.remove('hidden');

    // Render all transactions grouped by date
    if (storedTransactions.length === 0) {
        historyList.innerHTML = `
            <div class="history-empty">
                <div class="history-empty-icon">📋</div>
                <div class="history-empty-text">No transactions yet</div>
            </div>
        `;
        return;
    }

    // Group transactions by date
    const groups: { [key: string]: StoredTransaction[] } = {};
    storedTransactions.forEach(tx => {
        const date = new Date(tx.timestamp);
        const key = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        if (!groups[key]) {
            groups[key] = [];
        }
        groups[key].push(tx);
    });

    // Render grouped transactions
    historyList.innerHTML = Object.entries(groups).map(([date, txs]) => {
        const txItems = txs.map((tx, idx) => {
            const isReceive = tx.type === 'receive';
            const time = new Date(tx.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            const globalIdx = storedTransactions.indexOf(tx);

            return `
                <div class="history-transaction-item" data-tx-index="${globalIdx}">
                    <div class="history-tx-icon ${isReceive ? 'receive' : 'send'}">
                        ${isReceive ? '⬇️' : '⬆️'}
                    </div>
                    <div class="history-tx-info">
                        <div class="history-tx-type">${isReceive ? 'Received' : 'Sent'}</div>
                        ${tx.description ? `<div class="history-tx-description">${escapeHtml(tx.description)}</div>` : ''}
                        <div class="history-tx-time">${time}</div>
                    </div>
                    <div class="history-tx-amount ${isReceive ? 'positive' : 'negative'}">
                        ${isReceive ? '+' : '-'}${tx.amount.toLocaleString()} sats
                    </div>
                </div>
            `;
        }).join('');

        return `
            <div class="history-date-group">
                <div class="history-date-header">${date}</div>
                ${txItems}
            </div>
        `;
    }).join('');

    // Add click handlers
    historyList.querySelectorAll('.history-transaction-item').forEach(item => {
        item.addEventListener('click', () => {
            const index = parseInt(item.getAttribute('data-tx-index') || '0', 10);
            const tx = storedTransactions[index];
            if (tx) {
                showTransactionDetail(tx);
            }
        });
    });
}

function hideTransactionHistoryView(): void {
    console.log('[Popup] Hiding transaction history view');

    const historyView = document.getElementById('transaction-history-view');
    const mainInterface = document.getElementById('main-interface');

    if (historyView) historyView.classList.add('hidden');
    if (mainInterface) mainInterface.classList.remove('hidden');
}

async function copyToClipboard(text: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
        showSuccess('Copied to clipboard!');
    } catch (err) {
        console.error('[Popup] Failed to copy:', err);
        showError('Failed to copy');
    }
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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

function clearSensitiveState(clearSession: boolean = false): void {
    clearSensitiveWizardState();

    if (clearSession) {
        setSessionPin(null);
        chrome.storage.session.remove('walletSessionPin').catch(() => undefined);
    }
}

// ========================================
// Wizard Functions (kept in popup.ts as they're complex and state-heavy)
// ========================================

function showWizardStep(stepId: string) {
    console.log(`[Wizard] Showing step: ${stepId}`);

    const steps = [
        'welcome-step',
        'setup-choice-step',
        'create-step',
        'mnemonic-step',
        'confirm-step',
        'import-wallet-step',
        'pin-step',
        'setup-complete-step'
    ];

    steps.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.classList.toggle('hidden', id !== stepId);
        }
    });

    // Show/hide "Add Sub-Wallet" button
    // Show when: 1) on setup-choice-step, 2) adding a wallet (not initial setup), 3) at least one wallet exists
    // Disable when: current sub-wallet has no transactions (must use wallet before adding another)
    if (stepId === 'setup-choice-step') {
        const addSubWalletBtn = document.getElementById('add-sub-wallet-btn') as HTMLButtonElement;
        if (addSubWalletBtn) {
            const currentMasterKeys = getMasterKeys();
            const shouldShow = isAddingWallet && currentMasterKeys.length > 0;
            addSubWalletBtn.classList.toggle('hidden', !shouldShow);
            console.log(`[Wizard] Add Sub-Wallet button: ${shouldShow ? 'visible' : 'hidden'} (${currentMasterKeys.length} wallets)`);

            // Check if we should disable based on transaction history
            if (shouldShow) {
                updateAddSubWalletButtonState(addSubWalletBtn);
            }
        }
    }
}

/**
 * Check if the last sub-wallet has transactions and update button state accordingly
 * Logic: The LAST sub-wallet (or main wallet if no sub-wallets) must have transactions
 * before a new sub-wallet can be added. This ensures users don't create empty wallets.
 * 
 * We only check that the correct MASTER WALLET is selected - we don't require the user
 * to switch to a specific sub-wallet. We check the last sub-wallet's status regardless
 * of which sub-wallet is currently active.
 */
async function updateAddSubWalletButtonState(btn: HTMLButtonElement): Promise<void> {
    // Get the hint elements
    const hint = document.getElementById('add-sub-wallet-hint');
    const hintText = document.getElementById('add-sub-wallet-hint-text');

    // Helper to show/hide hint
    const updateHint = (show: boolean, message: string = '') => {
        if (hint && hintText) {
            hint.classList.toggle('hidden', !show);
            hintText.textContent = message;
        }
    };

    try {
        if (!breezSDK) {
            btn.disabled = true;
            btn.setAttribute('title', 'Wallet not connected');
            updateHint(true, 'Wallet not connected');
            return;
        }

        // Get active wallet info
        const activeData = await chrome.storage.local.get(['multiWalletData']);
        let activeMasterKeyId = '';
        let activeSubWalletIndex = 0;

        if (activeData.multiWalletData) {
            try {
                const data = JSON.parse(activeData.multiWalletData);
                activeMasterKeyId = data.activeWalletId || '';
                activeSubWalletIndex = data.activeSubWalletIndex || 0;
            } catch (e) {
                console.error('[Wizard] Failed to parse active wallet data');
            }
        }

        // Get all sub-wallets to find the last one
        let lastSubWalletIndex = 0;
        let lastSubWalletName = 'Main Wallet';
        let subWalletCount = 0;

        if (activeMasterKeyId) {
            const subWalletsResponse = await ExtensionMessaging.getSubWallets(activeMasterKeyId, true);
            if (subWalletsResponse.success && subWalletsResponse.data) {
                subWalletCount = subWalletsResponse.data.length;
                if (subWalletCount > 0) {
                    const lastSubWallet = subWalletsResponse.data.reduce((max, sw) =>
                        sw.index > max.index ? sw : max
                    );
                    lastSubWalletIndex = lastSubWallet.index;
                    lastSubWalletName = lastSubWallet.nickname || `Sub-wallet ${lastSubWallet.index}`;
                }
            }
        }

        // First sub-wallet is always allowed
        if (subWalletCount === 0) {
            btn.disabled = false;
            btn.removeAttribute('title');
            updateHint(false);
            console.log('[Wizard] No sub-wallets exist - first sub-wallet always allowed');
            return;
        }

        // For additional sub-wallets, check if the last one has activity
        const isOnLastSubWallet = activeSubWalletIndex === lastSubWalletIndex;
        let hasActivity = false;

        if (isOnLastSubWallet) {
            // We're on the last sub-wallet - check directly via SDK
            const [paymentsResponse, info] = await Promise.all([
                breezSDK.listPayments({}).catch(() => ({ payments: [] })),
                breezSDK.getInfo({ ensureSynced: false }).catch(() => ({ balanceSats: 0 }))
            ]);

            const payments = paymentsResponse?.payments || [];
            const balance = info?.balanceSats || 0;
            hasActivity = payments.length > 0 || balance > 0;
        } else {
            // Not on the last sub-wallet - check persisted hasActivity flag
            const subWalletsResponse = await ExtensionMessaging.getSubWallets(activeMasterKeyId, true);
            let lastSubWalletHasActivity: boolean | undefined = undefined;
            if (subWalletsResponse.success && subWalletsResponse.data && subWalletsResponse.data.length > 0) {
                const lastSubWallet = subWalletsResponse.data.reduce((max, sw) =>
                    sw.index > max.index ? sw : max
                );
                lastSubWalletHasActivity = lastSubWallet.hasActivity;
            }
            
            // Only allow if hasActivity is explicitly true
            hasActivity = lastSubWalletHasActivity === true;
        }

        btn.disabled = !hasActivity;
        if (!hasActivity) {
            const reason = `${lastSubWalletName} must have transactions before adding another`;
            btn.setAttribute('title', reason);
            updateHint(true, reason);
        } else {
            btn.removeAttribute('title');
            updateHint(false);
        }
    } catch (error) {
        console.warn('[Wizard] Could not check transaction history for sub-wallet button:', error);
        // On error, disable to be safe
        const reason = 'Could not verify transaction history';
        btn.disabled = true;
        btn.setAttribute('title', reason);
        updateHint(true, reason);
    }
}

function setupWizardListeners() {
    console.log('[Wizard] Setting up wizard listeners');

    // Welcome Step
    const startBtn = document.getElementById('start-setup-btn');
    if (startBtn) {
        startBtn.onclick = () => showWizardStep('setup-choice-step');
    }

    // Skip Setup - show QR-only interface for external wallet mode
    const skipSetupBtn = document.getElementById('skip-setup-btn');
    if (skipSetupBtn) {
        skipSetupBtn.onclick = async () => {
            await chrome.storage.local.set({ walletSkipped: true });
            showQROnlyInterface();
        };
    }

    // Setup Choice Step
    const choiceBackBtn = document.getElementById('choice-back-btn');
    const createWalletBtn = document.getElementById('create-new-wallet-btn');
    const importWalletBtn = document.getElementById('import-wallet-btn');

    if (choiceBackBtn) {
        choiceBackBtn.onclick = () => {
            // If adding wallet (already have one), return to main interface
            if (isAddingWallet) {
                const wizard = document.getElementById('onboarding-wizard');
                const mainInterface = document.getElementById('main-interface');
                
                if (wizard) wizard.classList.add('hidden');
                if (mainInterface) mainInterface.classList.remove('hidden');
                
                setIsAddingWallet(false);
            } else {
                // Initial setup - go back to welcome
                showWizardStep('welcome-step');
            }
        };
    }

    if (createWalletBtn) {
        createWalletBtn.onclick = () => {
            handleCreateWallet();
        };
    }

    if (importWalletBtn) {
        importWalletBtn.onclick = () => {
            setIsImportingWallet(true); // Importing, not creating
            initializeImportWallet();
            showWizardStep('import-wallet-step');
        };
    }

    // Add Sub-Wallet button (only visible in hierarchical mode when adding wallet)
    const addSubWalletBtn = document.getElementById('add-sub-wallet-btn');
    if (addSubWalletBtn) {
        addSubWalletBtn.onclick = () => {
            handleAddSubWalletFromWizard();
        };
    }

    // Mnemonic Step
    const mnemonicBackBtn = document.getElementById('mnemonic-back-btn');
    const wizardCopyMnemonicBtn = document.getElementById('wizard-copy-mnemonic-btn');
    const mnemonicContinueBtn = document.getElementById('mnemonic-continue-btn');

    if (mnemonicBackBtn) {
        mnemonicBackBtn.onclick = () => showWizardStep('setup-choice-step');
    }

    if (wizardCopyMnemonicBtn) {
        wizardCopyMnemonicBtn.onclick = async () => {
            if (generatedMnemonic) {
                await navigator.clipboard.writeText(generatedMnemonic);
                showSuccess('Recovery phrase copied to clipboard!');
                wizardCopyMnemonicBtn.textContent = '✓ Copied!';
                setTimeout(() => {
                    wizardCopyMnemonicBtn.textContent = '📋 Copy to Clipboard';
                }, 2000);
            }
        };
    }

    if (mnemonicContinueBtn) {
        mnemonicContinueBtn.onclick = () => {
            showWizardStep('confirm-step');
            setupWordConfirmation();
        };
    }

    // Confirm Step
    const confirmBackBtn = document.getElementById('confirm-back-btn');
    const confirmContinueBtn = document.getElementById('confirm-continue-btn');

    if (confirmBackBtn) {
        confirmBackBtn.onclick = () => showWizardStep('mnemonic-step');
    }

    if (confirmContinueBtn) {
        confirmContinueBtn.onclick = () => {
             showWizardStep('pin-step');
        };
    }

    // Import Step
    const importBackBtn = document.getElementById('import-back-btn');
    const importConfirmBtn = document.getElementById('import-confirm-btn');

    if (importBackBtn) {
        importBackBtn.onclick = () => showWizardStep('setup-choice-step');
    }

    if (importConfirmBtn) {
        importConfirmBtn.onclick = () => handleImportContinue();
    }

    // PIN Step
    const pinBackBtn = document.getElementById('pin-back-btn');
    const pinContinueBtn = document.getElementById('pin-continue-btn');

    if (pinBackBtn) {
        pinBackBtn.onclick = () => {
            // Go back to appropriate step based on flow
            if (isAddingWallet) {
                showWizardStep('setup-choice-step');
            } else {
                showWizardStep('confirm-step');
            }
        };
    }

    if (pinContinueBtn) {
        pinContinueBtn.onclick = () => handlePinConfirm();
    }

    // PIN Input listeners
    const pinInput = document.getElementById('pin-input') as HTMLInputElement;
    const confirmPinInput = document.getElementById('pin-confirm') as HTMLInputElement;

    if (pinInput) {
        pinInput.oninput = validatePinInputs;
    }
    if (confirmPinInput) {
        confirmPinInput.oninput = validatePinInputs;
    }

    // Completion Step
    const completeSetupBtn = document.getElementById('complete-setup-btn');
    if (completeSetupBtn) {
        completeSetupBtn.onclick = async () => {
            await finalizeWalletSetup();
        };
    }

    // Rename interface buttons
    const renameSaveBtn = document.getElementById('rename-save-btn');
    const renameBackBtn = document.getElementById('rename-back-btn');

    if (renameSaveBtn) {
        renameSaveBtn.onclick = () => handleRenameSave();
    }
    if (renameBackBtn) {
        renameBackBtn.onclick = () => hideRenameInterface();
    }
}

/**
 * Handle adding a sub-wallet from the wizard (when user clicks "Add Sub-Wallet" card)
 * Directly creates a new sub-wallet under the currently active wallet with auto-generated name
 */
async function handleAddSubWalletFromWizard(): Promise<void> {
    console.log('[Wizard] Adding sub-wallet from wizard');

    try {
        // Get the currently active wallet ID from storage
        const multiWalletResult = await chrome.storage.local.get(['multiWalletData']);
        if (!multiWalletResult.multiWalletData) {
            showError('No wallet found. Please create a wallet first.');
            return;
        }

        const multiWalletData = JSON.parse(multiWalletResult.multiWalletData);
        const activeWalletId = multiWalletData.activeWalletId;
        
        if (!activeWalletId) {
            showError('No active wallet. Please unlock a wallet first.');
            return;
        }

        // Find the active wallet to get sub-wallet count for auto-naming
        const activeWallet = multiWalletData.wallets?.find((w: any) => w.metadata.id === activeWalletId);
        const existingSubWalletCount = activeWallet?.subWallets?.length || 0;
        
        // Auto-generate default name: "Sub-wallet 1", "Sub-wallet 2", etc.
        const defaultName = `Sub-wallet ${existingSubWalletCount + 1}`;

        // Prompt for wallet name using modal
        const walletName = await promptForText(
            'Enter a name for the new sub-wallet:',
            defaultName,
            'e.g., Savings, Trading'
        );

        if (!walletName) {
            return; // User cancelled
        }



        // Add the sub-wallet to the currently active wallet
        const response = await ExtensionMessaging.addSubWallet(activeWalletId, walletName.trim());

        if (response.success && response.data !== undefined) {
            const newSubWalletIndex = Number(response.data);
            
            // Switch to the newly created sub-wallet
            if (sessionPin) {
                // Clear UI first
                const transactionList = document.getElementById('transaction-list');
                if (transactionList) {
                    transactionList.innerHTML = getTransactionEmptyStateHtml('Loading history...', 'Please wait a moment');
                }
                const balanceDisplay = document.getElementById('balance');
                if (balanceDisplay) {
                    balanceDisplay.textContent = '-- sats';
                }

                const switchResponse = await ExtensionMessaging.switchHierarchicalWallet(
                    activeWalletId,
                    newSubWalletIndex,
                    sessionPin
                );

                const wizard = document.getElementById('onboarding-wizard');
                const mainInterface = document.getElementById('main-interface');

                if (switchResponse.success && switchResponse.data) {
                    // Update Active State
                    setActiveMasterKeyId(activeWalletId);
                    setActiveSubWalletIndex(newSubWalletIndex);

                    // Clear old wallet data before connecting to new wallet
                    clearWalletDisplay();

                    // Reconnect SDK
                    const sdk = await connectBreezSDK(switchResponse.data.mnemonic);
                    setBreezSDK(sdk);

                    showSuccess(`${walletName} created and activated!`);

                    if (wizard) wizard.classList.add('hidden');
                    if (mainInterface) mainInterface.classList.remove('hidden');

                    setIsAddingWallet(false);

                    // Refresh wallet UI fully
                    await initializeMultiWalletUI();
                    await updateBalanceDisplay();
                    await loadTransactionHistory();
                } else {
                    showSuccess(`${walletName} created!`);
                    console.warn('[Wizard] Could not switch to new sub-wallet:', switchResponse.error);
                    
                    if (wizard) wizard.classList.add('hidden');
                    if (mainInterface) mainInterface.classList.remove('hidden');
                    setIsAddingWallet(false);
                }
            } else {
                showSuccess(`${walletName} created! Please unlock to use it.`);
                
                const wizard = document.getElementById('onboarding-wizard');
                const mainInterface = document.getElementById('main-interface');
                
                if (wizard) wizard.classList.add('hidden');
                if (mainInterface) mainInterface.classList.remove('hidden');
                setIsAddingWallet(false);
            }
        } else {
            showError(response.error || 'Failed to create sub-wallet');
        }
    } catch (error) {
        console.error('[Wizard] Error adding sub-wallet:', error);
        showError('Failed to create sub-wallet');
    }
}

async function handleCreateWallet() {
    console.log('[Wizard] Creating new wallet');

    try {
        // Generate mnemonic
        let mnemonic = generateAndValidateMnemonic();
        let words = mnemonic.trim().split(/\s+/);

        if (words.length !== 12 || !bip39.validateMnemonic(words.join(' '))) {
            console.error('[Wizard] Generated mnemonic display verification failed, regenerating');
            mnemonic = generateAndValidateMnemonic();
            words = mnemonic.trim().split(/\s+/);

            if (words.length !== 12 || !bip39.validateMnemonic(words.join(' '))) {
                throw new Error('Mnemonic display verification failed after regeneration');
            }
        }

        setGeneratedMnemonic(mnemonic);
        setMnemonicWords(words);

        // Display mnemonic
        const mnemonicDisplay = document.getElementById('mnemonic-display');
        if (mnemonicDisplay) {
            mnemonicDisplay.innerHTML = words.map((word, index) => `
                <div class="mnemonic-word">
                    <span class="word-number">${index + 1}.</span> ${word}
                </div>
            `).join('');
        }

        showWizardStep('mnemonic-step');
    } catch (error) {
        console.error('[Wizard] Error creating wallet:', error);
        showError('Failed to generate recovery phrase');
    }
}

// Setup Confirmation Step with Shuffled Words
function setupWordConfirmation() {
    // Reset selected words
    setSelectedWords([]);

    // Shuffle words
    const shuffledWords = [...mnemonicWords].sort(() => Math.random() - 0.5);

    // Display selected words area with paste input
    const selectedWordsDiv = document.getElementById('selected-words');
    if (selectedWordsDiv) {
        selectedWordsDiv.innerHTML = `
            <p style="color: rgba(255,255,255,0.6); font-size: 14px; margin-bottom: 8px;">Select words in order or paste your phrase:</p>
            <input type="text" id="confirm-paste-input" placeholder="Paste your 12-word phrase here..."
                style="width: 100%; padding: 10px; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; font-size: 13px; margin-bottom: 12px; box-sizing: border-box; background: rgba(255,255,255,0.08); color: #fff;"
            />
        `;

        // Add paste handler
        const pasteInput = document.getElementById('confirm-paste-input') as HTMLInputElement;
        if (pasteInput) {
            pasteInput.addEventListener('paste', handleConfirmPaste);
            pasteInput.addEventListener('input', () => {
                // Also handle direct typing/paste via input event
                const value = pasteInput.value.trim();
                if (value.split(/\s+/).length === 12) {
                    validatePastedPhrase(value);
                }
            });
        }
    }

    // Display word options
    const wordOptionsDiv = document.getElementById('word-options');
    if (!wordOptionsDiv) return;

    wordOptionsDiv.innerHTML = '';

    shuffledWords.forEach((word, index) => {
        const wordBtn = document.createElement('button');
        wordBtn.className = 'word-button';
        wordBtn.textContent = word;
        wordBtn.dataset.word = word;

        wordBtn.onclick = () => {
            handleWordSelection(word, wordBtn);
        };

        wordOptionsDiv.appendChild(wordBtn);
    });

    // Disable continue button initially
    const confirmContinueBtn = document.getElementById('confirm-continue-btn') as HTMLButtonElement;
    if (confirmContinueBtn) {
        confirmContinueBtn.disabled = true;
    }
}

// Handle paste event in confirmation step
function handleConfirmPaste(e: ClipboardEvent) {
    e.preventDefault();
    const pastedText = e.clipboardData?.getData('text');
    if (pastedText) {
        validatePastedPhrase(pastedText);
    }
}

// Validate pasted phrase against the generated mnemonic
function validatePastedPhrase(pastedText: string) {
    const words = pastedText.trim().toLowerCase().split(/\s+/);

    if (words.length !== 12) {
        showError(`Expected 12 words, got ${words.length}`);
        return;
    }

    // Check if pasted words match the generated mnemonic
    const isCorrect = words.every((word, index) => word === mnemonicWords[index].toLowerCase());

    if (isCorrect) {
        // Set all words as selected
        setSelectedWords([...mnemonicWords]);

        // Disable all word buttons
        const wordOptionsDiv = document.getElementById('word-options');
        if (wordOptionsDiv) {
            const buttons = wordOptionsDiv.querySelectorAll('button');
            buttons.forEach(btn => {
                btn.disabled = true;
                btn.style.opacity = '0.5';
            });
        }

        // Update display and enable continue
        updateSelectedWordsDisplay();

        const confirmContinueBtn = document.getElementById('confirm-continue-btn') as HTMLButtonElement;
        if (confirmContinueBtn) {
            confirmContinueBtn.disabled = false;
        }

        // Show success message
        const selectedWordsDiv = document.getElementById('selected-words');
        if (selectedWordsDiv) {
            const successMsg = document.createElement('p');
            successMsg.style.color = '#28a745';
            successMsg.style.fontWeight = 'bold';
            successMsg.style.marginTop = '10px';
            successMsg.textContent = '✓ Correct! You can continue.';
            selectedWordsDiv.appendChild(successMsg);
        }

        showSuccess('Recovery phrase verified!');
    } else {
        showError('Phrase does not match. Please try again.');
        // Clear the input
        const pasteInput = document.getElementById('confirm-paste-input') as HTMLInputElement;
        if (pasteInput) {
            pasteInput.value = '';
        }
    }
}

// Handle Word Selection
function handleWordSelection(word: string, button: HTMLButtonElement) {
    // Add word to selected list
    const newSelectedWords = [...selectedWords, word];
    setSelectedWords(newSelectedWords);

    // Disable the button
    button.disabled = true;
    button.style.opacity = '0.5';

    // Update selected words display
    updateSelectedWordsDisplay();

    // Check if all words selected
    if (selectedWords.length === mnemonicWords.length) {
        checkConfirmation();
    }
}

// Update Selected Words Display
function updateSelectedWordsDisplay() {
    const selectedWordsDiv = document.getElementById('selected-words');
    if (!selectedWordsDiv) return;

    // If no words selected, show the paste input
    if (selectedWords.length === 0) {
        selectedWordsDiv.innerHTML = `
            <p style="color: rgba(255,255,255,0.6); font-size: 14px; margin-bottom: 8px;">Select words in order or paste your phrase:</p>
            <input type="text" id="confirm-paste-input" placeholder="Paste your 12-word phrase here..."
                style="width: 100%; padding: 10px; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; font-size: 13px; margin-bottom: 12px; box-sizing: border-box; background: rgba(255,255,255,0.08); color: #fff;"
            />
        `;

        // Re-add paste handler
        const pasteInput = document.getElementById('confirm-paste-input') as HTMLInputElement;
        if (pasteInput) {
            pasteInput.addEventListener('paste', handleConfirmPaste);
            pasteInput.addEventListener('input', () => {
                const value = pasteInput.value.trim();
                if (value.split(/\s+/).length === 12) {
                    validatePastedPhrase(value);
                }
            });
        }
        return;
    }

    selectedWordsDiv.innerHTML = '<p style="color: rgba(255,255,255,0.6); font-size: 14px; margin-bottom: 10px;">Selected words:</p>';

    const wordsContainer = document.createElement('div');
    wordsContainer.style.display = 'flex';
    wordsContainer.style.flexWrap = 'wrap';
    wordsContainer.style.gap = '8px';
    wordsContainer.style.marginBottom = '16px';

    selectedWords.forEach((word, index) => {
        const wordSpan = document.createElement('span');
        wordSpan.style.padding = '6px 8px 6px 12px';
        wordSpan.style.background = 'rgba(255, 255, 255, 0.1)';
        wordSpan.style.border = '1px solid rgba(255, 255, 255, 0.15)';
        wordSpan.style.borderRadius = '4px';
        wordSpan.style.fontSize = '14px';
        wordSpan.style.color = '#ffffff';
        wordSpan.style.display = 'inline-flex';
        wordSpan.style.alignItems = 'center';
        wordSpan.style.gap = '6px';

        const textSpan = document.createElement('span');
        textSpan.textContent = `${index + 1}. ${word}`;

        const removeBtn = document.createElement('span');
        removeBtn.textContent = '×';
        removeBtn.style.cursor = 'pointer';
        removeBtn.style.color = 'rgba(255,255,255,0.5)';
        removeBtn.style.fontSize = '16px';
        removeBtn.style.fontWeight = 'bold';
        removeBtn.style.lineHeight = '1';
        removeBtn.title = 'Remove';
        removeBtn.onmouseover = () => removeBtn.style.color = '#dc3545';
        removeBtn.onmouseout = () => removeBtn.style.color = 'rgba(255,255,255,0.5)';
        removeBtn.onclick = () => removeSelectedWord(index);

        wordSpan.appendChild(textSpan);
        wordSpan.appendChild(removeBtn);
        wordsContainer.appendChild(wordSpan);
    });

    selectedWordsDiv.appendChild(wordsContainer);
}

// Remove a selected word and re-enable its button
function removeSelectedWord(indexToRemove: number) {
    const wordToRemove = selectedWords[indexToRemove];

    // Remove from selected words array
    const newSelectedWords = selectedWords.filter((_, i) => i !== indexToRemove);
    setSelectedWords(newSelectedWords);

    // Re-enable the corresponding word button
    const wordOptionsDiv = document.getElementById('word-options');
    if (wordOptionsDiv) {
        const buttons = wordOptionsDiv.querySelectorAll('button');
        buttons.forEach(btn => {
            if (btn.dataset.word === wordToRemove) {
                btn.disabled = false;
                btn.style.opacity = '1';
            }
        });
    }

    // Update display
    updateSelectedWordsDisplay();

    // Disable continue button since order changed
    const confirmContinueBtn = document.getElementById('confirm-continue-btn') as HTMLButtonElement;
    if (confirmContinueBtn) {
        confirmContinueBtn.disabled = true;
    }
}

// Check if confirmation is correct
function checkConfirmation() {
    const isCorrect = selectedWords.every((word, index) => word === mnemonicWords[index]);

    const confirmContinueBtn = document.getElementById('confirm-continue-btn') as HTMLButtonElement;
    const selectedWordsDiv = document.getElementById('selected-words');

    if (isCorrect) {
        if (confirmContinueBtn) {
            confirmContinueBtn.disabled = false;
        }

        if (selectedWordsDiv) {
            const successMsg = document.createElement('p');
            successMsg.style.color = '#28a745';
            successMsg.style.fontWeight = 'bold';
            successMsg.style.marginTop = '10px';
            successMsg.textContent = '✓ Correct! You can continue.';
            selectedWordsDiv.appendChild(successMsg);
        }
    } else {
        if (selectedWordsDiv) {
            const errorMsg = document.createElement('p');
            errorMsg.style.color = '#dc3545';
            errorMsg.style.fontWeight = 'bold';
            errorMsg.style.marginTop = '10px';
            errorMsg.textContent = 'Incorrect order. Please try again.';
            selectedWordsDiv.appendChild(errorMsg);

            // Reset after 2 seconds
            setTimeout(() => {
                setupWordConfirmation();
            }, 2000);
        }
    }
}

function validatePinInputs() {
    const pinInput = document.getElementById('pin-input') as HTMLInputElement;
    const confirmPinInput = document.getElementById('pin-confirm') as HTMLInputElement;
    const pinConfirmBtn = document.getElementById('pin-continue-btn') as HTMLButtonElement;
    const pinError = document.getElementById('pin-strength');

    if (!pinInput || !confirmPinInput || !pinConfirmBtn) return;

    const pin = pinInput.value;
    const confirmPin = confirmPinInput.value;

    // Clear previous errors
    if (pinError) pinError.classList.add('hidden');

    // Validate PIN is exactly 6 digits
    if (pin.length !== 6) {
        pinConfirmBtn.disabled = true;
        if (pinError && pin.length > 0) {
            pinError.textContent = 'PIN must be exactly 6 digits';
            pinError.classList.remove('hidden');
        }
        return;
    }

    // Validate PIN contains only numbers
    if (!/^\d{6}$/.test(pin)) {
        pinConfirmBtn.disabled = true;
        if (pinError) {
            pinError.textContent = 'PIN must contain only numbers';
            pinError.classList.remove('hidden');
        }
        return;
    }

    // Check if PINs match
    if (pin !== confirmPin) {
        pinConfirmBtn.disabled = true;
        if (confirmPin.length > 0 && pinError) {
            pinError.textContent = 'PINs do not match';
            pinError.classList.remove('hidden');
        }
        return;
    }

    // All valid
    if (pinError) {
        pinError.textContent = '✓ PIN is valid';
        pinError.classList.remove('hidden');
    }
    pinConfirmBtn.disabled = false;
}

async function handlePinConfirm() {
    const pinInput = document.getElementById('pin-input') as HTMLInputElement;
    const pinContinueBtn = document.getElementById('pin-continue-btn') as HTMLButtonElement;

    if (!pinInput) return;

    const pin = pinInput.value;
    setUserPin(pin);

    try {
        if (pinContinueBtn) {
            pinContinueBtn.disabled = true;
            pinContinueBtn.textContent = 'Creating wallet...';
        }

        // Determine if we're adding a wallet or creating initial one
        // Fetch the actual wallet count from storage (currentWallets state may not be populated yet)
        const walletsResponse = await ExtensionMessaging.getAllWallets();
        const existingWalletCount = walletsResponse.success && walletsResponse.data 
            ? walletsResponse.data.length 
            : 0;
        
        const nickname = existingWalletCount === 0 ? 'Main Wallet' : `Wallet ${existingWalletCount + 1}`;
        console.log(`[Wizard] Creating wallet with nickname: ${nickname} (existing count: ${existingWalletCount})`);

        // Create the master wallet via background
        const response = await ExtensionMessaging.importWalletWithDiscovery(generatedMnemonic, nickname, pin);

        if (!response.success || !response.data) {
            throw new Error(response.error || 'Failed to save wallet');
        }

        const { masterKeyId } = response.data;
        console.log(`[Wizard] Master wallet created: ${masterKeyId}`);

        // Update session PIN to the new wallet's PIN
        setSessionPin(pin);
        await chrome.storage.session.set({ walletSessionPin: pin });

        // Set the newly created wallet as the active wallet
        console.log(`[Wizard] Setting newly created wallet ${masterKeyId} as active`);
        setActiveMasterKeyId(masterKeyId);
        setActiveSubWalletIndex(0);
        await ExtensionMessaging.setActiveHierarchicalWallet(masterKeyId, 0);

        // Mark wallet for discovery BEFORE finalizing setup
        // This ensures the UI shows the loading spinner when it renders
        markWalletForDiscovery(masterKeyId);

        // Skip the completion screen and directly finalize setup
        // This avoids the "Opening..." button getting stuck
        console.log('[Wizard] Skipping completion screen, opening wallet directly');
        await finalizeWalletSetup();

        // Start sub-wallet discovery in the background (non-blocking)
        // This runs after the main UI is shown, scanning for existing sub-wallets
        console.log('[Wizard] Starting background sub-wallet discovery...');
        startSubWalletDiscovery(masterKeyId, generatedMnemonic).catch(err => {
            console.warn('[Wizard] Background discovery error (non-fatal):', err);
        });
        
    } catch (error) {
        console.error('[Wizard] Error saving wallet:', error);
        clearSensitiveState();
        const errorMessage = error instanceof Error ? error.message : 'Failed to create wallet';
        showError(errorMessage);
        if (pinContinueBtn) {
            pinContinueBtn.disabled = false;
            pinContinueBtn.textContent = 'Create Wallet';
        }
    }
}

async function finalizeWalletSetup() {
    console.log('[Wizard] Finalizing wallet setup');

    const completeSetupBtn = document.getElementById('complete-setup-btn') as HTMLButtonElement;
    if (completeSetupBtn) {
        completeSetupBtn.disabled = true;
        completeSetupBtn.textContent = 'Opening...';
    }

    try {
        // Load and connect wallet
        const walletResponse = await ExtensionMessaging.loadWallet(userPin);

        if (!walletResponse.success || !walletResponse.data) {
            throw new Error(walletResponse.error || 'Failed to load wallet');
        }

        // Clear old wallet display data before connecting new wallet
        clearWalletDisplay();

        // Show cached transactions immediately while SDK connects
        const transactionList = document.getElementById('transaction-list');
        let shownCachedTx = false;
        try {
            const multiWalletResult = await chrome.storage.local.get(['multiWalletData']);
            if (multiWalletResult.multiWalletData) {
                const mwd = JSON.parse(multiWalletResult.multiWalletData);
                const wid = mwd.activeWalletId;
                const subIdx = mwd.activeSubWalletIndex || 0;
                if (wid) {
                    const cacheKey = walletCacheKey('cachedTransactions', wid, subIdx);
                    const cached = await chrome.storage.local.get([cacheKey]);
                    if (cached[cacheKey]?.length > 0 && transactionList) {
                        console.log('💾 [Popup] Showing cached transactions on unlock');
                        storedTransactions = cached[cacheKey] as StoredTransaction[];
                        renderTransactionList(transactionList, storedTransactions.slice(0, 5));
                        shownCachedTx = true;
                    }
                }
            }
        } catch (e) {
            console.warn('⚠️ [Popup] Cache read failed:', e);
        }
        if (!shownCachedTx) showTransactionsLoading();

        // Connect SDK
        const sdk = await connectBreezSDK(walletResponse.data.mnemonic);
        setBreezSDK(sdk);

        // Store PIN in session
        setSessionPin(userPin);
        await chrome.storage.session.set({ walletSessionPin: userPin });

        // Mark as unlocked
        setIsWalletUnlocked(true);
        await chrome.storage.local.set({ isUnlocked: true, lastActivity: Date.now() });

        // Clear adding wallet flag
        setIsAddingWallet(false);

        // Hide wizard, show main interface
        const wizard = document.getElementById('onboarding-wizard');
        const mainInterface = document.getElementById('main-interface');

        if (wizard) wizard.classList.add('hidden');
        if (mainInterface) mainInterface.classList.remove('hidden');

        // Initialize UI
        await updateBalanceDisplay();
        await loadTransactionHistory();
        await initializeMultiWalletUI();

        showSuccess('Wallet setup complete!');

        // Start auto-lock alarm
        await chrome.runtime.sendMessage({ type: 'START_AUTO_LOCK_ALARM' });
        clearSensitiveState();

    } catch (error) {
        console.error('[Wizard] Error finalizing setup:', error);
        clearSensitiveState();
        showError('Failed to open wallet');
        if (completeSetupBtn) {
            completeSetupBtn.disabled = false;
            completeSetupBtn.textContent = 'Start Using Wallet';
        }
    }
}


// ========================================
// Import Functions
// ========================================

// Initialize Import Wallet Step
function initializeImportWallet() {
    const container = document.getElementById('import-words-container');
    if (!container) return;

    // Clear existing inputs
    container.innerHTML = '';

    // Create 12 input fields
    for (let i = 1; i <= 12; i++) {
        const wrapper = document.createElement('div');
        wrapper.className = 'word-input-wrapper';
        wrapper.innerHTML = `
            <span class="word-number">${i}</span>
            <input
                type="text"
                id="import-word-${i}"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                data-word-index="${i-1}"
                placeholder="word ${i}"
            />
        `;
        container.appendChild(wrapper);

        const input = wrapper.querySelector('input') as HTMLInputElement;
        setupWordAutocomplete(input, document.getElementById('word-suggestions') as HTMLElement);
        setupWordEnterHandler(input, document.getElementById('word-suggestions') as HTMLElement);
        setupWordPasteHandler(input);
    }
}

function setupImportWordInputs() {
    const container = document.getElementById('import-words-container');
    const suggestionsDiv = document.getElementById('word-suggestions');

    if (!container || !suggestionsDiv) return;

    container.innerHTML = '';

    for (let i = 1; i <= 12; i++) {
        const wrapper = document.createElement('div');
        wrapper.className = 'word-input-wrapper';
        wrapper.innerHTML = `
            <span class="word-number">${i}</span>
            <input
                type="text"
                id="import-word-${i}"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                data-word-index="${i - 1}"
                placeholder="word ${i}"
            />
        `;
        container.appendChild(wrapper);

        const input = wrapper.querySelector('input') as HTMLInputElement;
        setupWordAutocomplete(input, suggestionsDiv);
        setupWordPasteHandler(input);
        setupWordEnterHandler(input, suggestionsDiv);
    }
}

function setupWordAutocomplete(input: HTMLInputElement, suggestionsDiv: HTMLElement) {
    input.addEventListener('input', () => {
        const value = input.value.toLowerCase().trim();

        if (value.length < 2) {
            suggestionsDiv.style.display = 'none';
            validateWordInput(input);
            checkImportComplete();
            return;
        }

        const matches = BIP39_WORDS.filter(word => word.startsWith(value)).slice(0, 10);

        if (matches.length === 0) {
            suggestionsDiv.style.display = 'none';
            validateWordInput(input);
            checkImportComplete();
            return;
        }

        // Show suggestions
        suggestionsDiv.innerHTML = '';
        matches.forEach(word => {
            const div = document.createElement('div');
            div.className = 'word-suggestion';
            div.textContent = word;
            div.addEventListener('click', () => {
                input.value = word;
                suggestionsDiv.style.display = 'none';
                validateWordInput(input);

                // Focus next input
                const wordIndex = parseInt(input.dataset.wordIndex || '0');
                if (wordIndex < 11) {
                    const nextInput = document.getElementById(`import-word-${wordIndex + 2}`) as HTMLInputElement;
                    if (nextInput) nextInput.focus();
                }

                checkImportComplete();
            });
            suggestionsDiv.appendChild(div);
        });

        // Position suggestions
        const rect = input.getBoundingClientRect();
        suggestionsDiv.style.display = 'block';
        suggestionsDiv.style.left = rect.left + 'px';
        suggestionsDiv.style.top = (rect.bottom + 4) + 'px';
        suggestionsDiv.style.width = rect.width + 'px';

        validateWordInput(input);
        checkImportComplete();
    });

    // Hide suggestions on blur
    input.addEventListener('blur', () => {
        setTimeout(() => {
            suggestionsDiv.style.display = 'none';
        }, 200);
    });
}

function setupWordEnterHandler(input: HTMLInputElement, suggestionsDiv: HTMLElement) {
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const firstSuggestion = suggestionsDiv.querySelector('.word-suggestion') as HTMLElement;
            if (firstSuggestion && suggestionsDiv.style.display === 'block') {
                firstSuggestion.click();
            } else {
                // Move to next field if word is valid
                const value = input.value.toLowerCase().trim();
                if (BIP39_WORDS.includes(value)) {
                    const wordIndex = parseInt(input.dataset.wordIndex || '0');
                    if (wordIndex < 11) {
                        const nextInput = document.getElementById(`import-word-${wordIndex + 2}`) as HTMLInputElement;
                        if (nextInput) nextInput.focus();
                    }
                }
            }
        }
    });
}

function setupWordPasteHandler(input: HTMLInputElement) {
    input.addEventListener('paste', (e: ClipboardEvent) => {
        e.preventDefault();

        const pastedText = e.clipboardData?.getData('text');
        if (!pastedText) return;

        console.log('[Import] Paste detected:', pastedText.substring(0, 50));

        const words = pastedText.trim().split(/\s+/).filter(word => word.length > 0);

        if (words.length !== 12) {
            showError(`Invalid paste: Expected 12 words, got ${words.length}`);
            return;
        }

        // Validate words
        const lowerWords = words.map(w => w.toLowerCase());
        const invalidWords = lowerWords.filter(w => !BIP39_WORDS.includes(w));

        if (invalidWords.length > 0) {
            showError(`Invalid words: ${invalidWords.join(', ')}`);
            return;
        }

        // Fill all inputs
        lowerWords.forEach((word, index) => {
            const wordInput = document.getElementById(`import-word-${index + 1}`) as HTMLInputElement;
            if (wordInput) {
                wordInput.value = word;
                validateWordInput(wordInput);
            }
        });

        checkImportComplete();
        showSuccess('Recovery phrase pasted successfully!');
    });
}

function validateWordInput(input: HTMLInputElement) {
    const value = input.value.toLowerCase().trim();

    if (value === '') {
        input.classList.remove('valid', 'invalid');
    } else if (BIP39_WORDS.includes(value)) {
        input.classList.add('valid');
        input.classList.remove('invalid');
    } else {
        input.classList.add('invalid');
        input.classList.remove('valid');
    }
}

function checkImportComplete() {
    const allWords: string[] = [];
    let allValid = true;

    for (let i = 1; i <= 12; i++) {
        const input = document.getElementById(`import-word-${i}`) as HTMLInputElement;
        if (!input) {
            allValid = false;
            break;
        }

        const word = input.value.toLowerCase().trim();
        if (!word || !BIP39_WORDS.includes(word)) {
            allValid = false;
            break;
        }

        allWords.push(word);
    }

    if (allValid && !bip39.validateMnemonic(allWords.join(' '))) {
        allValid = false;
    }

    const importConfirmBtn = document.getElementById('import-confirm-btn') as HTMLButtonElement;
    if (importConfirmBtn) {
        importConfirmBtn.disabled = !allValid;
    }

    if (allValid) {
        setGeneratedMnemonic(allWords.join(' '));
        setMnemonicWords(allWords);
    }
}

function handleImportContinue() {
    showWizardStep('pin-step');
}

// ========================================
// Unlock & Lock Functions
// ========================================

function showUnlockPrompt() {
    console.log('🔵 [Unlock] showUnlockPrompt ENTRY');

    hideAllViews();

    const unlockInterface = document.getElementById('unlock-interface');
    if (unlockInterface) {
        unlockInterface.classList.remove('hidden');
    } else {
        console.error('❌ [Unlock] unlock-interface not found!');
        return;
    }

    const pinInput = document.getElementById('unlock-pin') as HTMLInputElement;
    const unlockBtn = document.getElementById('unlock-btn') as HTMLButtonElement;
    const unlockError = document.getElementById('unlock-error');

    if (!pinInput || !unlockBtn) return;

    // Reset state
    pinInput.value = '';
    pinInput.focus();
    unlockBtn.disabled = false;
    unlockBtn.textContent = 'Unlock';
    if (unlockError) {
        unlockError.classList.add('hidden');
        unlockError.textContent = '';
    }

    // Clone button to remove old listeners
    const newUnlockBtn = unlockBtn.cloneNode(true) as HTMLButtonElement;
    unlockBtn.parentNode?.replaceChild(newUnlockBtn, unlockBtn);

    // Track if unlock is in progress to prevent multiple attempts
    let isUnlocking = false;

    // Core unlock logic - extracted so it can be called from button or auto-unlock
    async function attemptUnlock(pin: string, isAutoAttempt: boolean = false): Promise<boolean> {
        if (isUnlocking) return false;

        if (!pin || pin.length < 4) {
            if (!isAutoAttempt) {
                showError('Please enter your PIN');
                if (unlockError) {
                    unlockError.textContent = 'Please enter your PIN';
                    unlockError.classList.remove('hidden');
                }
            }
            return false;
        }

        try {
            isUnlocking = true;
            newUnlockBtn.disabled = true;
            newUnlockBtn.textContent = 'Unlocking...';
            if (unlockError) unlockError.classList.add('hidden');

            const storage = new ChromeStorageManager();
            const lockoutStatus = await storage.checkPinLockout();
            if (lockoutStatus.locked) {
                const message = `Too many failed attempts. Try again in ${formatLockoutDuration(lockoutStatus.remainingMs || 0)}.`;
                showError(message);
                if (unlockError) {
                    unlockError.textContent = message;
                    unlockError.classList.remove('hidden');
                }
                newUnlockBtn.disabled = false;
                newUnlockBtn.textContent = 'Unlock';
                isUnlocking = false;
                return false;
            }

            // Check for migration
            if (await storage.needsMigration()) {
                console.log('🔄 [Unlock] Migrating to multi-wallet format...');
                await storage.migrateToMultiWallet(pin);
            }

            // Load wallet
            const walletResponse = await ExtensionMessaging.loadWallet(pin);

            if (!walletResponse.success || !walletResponse.data) {
                // Show error for manual attempts OR auto-attempts with complete PIN (6+ digits)
                const shouldShowError = !isAutoAttempt || pin.length >= 6;
                if (shouldShowError) {
                    const updatedLockout = await storage.checkPinLockout();
                    const errorMsg = updatedLockout.locked
                        ? `Too many failed attempts. Try again in ${formatLockoutDuration(updatedLockout.remainingMs || 0)}.`
                        : (walletResponse.error || 'Invalid PIN');
                    showError(errorMsg);
                    if (unlockError) {
                        unlockError.textContent = errorMsg;
                        unlockError.classList.remove('hidden');
                    }
                }
                newUnlockBtn.disabled = false;
                newUnlockBtn.textContent = 'Unlock';
                isUnlocking = false;
                return false;
            }

            // Disconnect existing SDK if any
            if (breezSDK) {
                await breezSDK.disconnect();
                setBreezSDK(null);
            }
            // Clear stale Lightning Address from previous wallet
            currentLightningAddressInfo = null;
            renderLightningAddressUI();

            // Connect SDK
            const sdk = await connectBreezSDK(walletResponse.data.mnemonic);
            setBreezSDK(sdk);
            setIsWalletUnlocked(true);

            // Store session PIN
            setSessionPin(pin);
            await chrome.storage.session.set({ walletSessionPin: pin });

            // Update storage
            await chrome.storage.local.set({ isUnlocked: true, lastActivity: Date.now() });

            // Hide unlock, show main
            if (unlockInterface) unlockInterface.classList.add('hidden');
            restoreMainInterface();

            // Update UI
            showSuccess('Wallet unlocked!');
            await updateBalanceDisplay();

            // Show cached transactions immediately, fetch fresh in background
            const transactionList = document.getElementById('transaction-list');
            let shownCached = false;
            try {
                const mwResult = await chrome.storage.local.get(['multiWalletData']);
                if (mwResult.multiWalletData) {
                    const mwd = JSON.parse(mwResult.multiWalletData);
                    const wid = mwd.activeWalletId;
                    const subIdx = mwd.activeSubWalletIndex || 0;
                    if (wid) {
                        const cacheKey = walletCacheKey('cachedTransactions', wid, subIdx);
                        const cached = await chrome.storage.local.get([cacheKey]);
                        if (cached[cacheKey]?.length > 0 && transactionList) {
                            console.log('💾 [Popup] Showing cached transactions on PIN unlock');
                            storedTransactions = cached[cacheKey] as StoredTransaction[];
                            renderTransactionList(transactionList, storedTransactions.slice(0, 5));
                            shownCached = true;
                        }
                    }
                }
            } catch (e) { /* ignore cache errors */ }

            if (!shownCached && transactionList) {
                transactionList.innerHTML = getTransactionEmptyStateHtml('Loading transaction history...', 'Please wait a moment');
            }

            enableWalletControls();
            await initializeMultiWalletUI();
            await refreshLightningAddress();

            // Check for any pending sub-wallet discovery to resume
            resumePendingDiscovery(async (masterKeyId: string) => {
                // Get master mnemonic for the wallet that has pending discovery
                try {
                    const result = await ExtensionMessaging.getMasterMnemonic(masterKeyId, pin);
                    return result.success && result.data ? result.data.mnemonic : null;
                } catch {
                    return null;
                }
            }).catch(err => {
                console.warn('[Popup] Resume discovery error (non-fatal):', err);
            });

            // Start auto-lock
            await chrome.runtime.sendMessage({ type: 'START_AUTO_LOCK_ALARM' });
            await chrome.storage.local.set({ lastActivity: Date.now() });

            isUnlocking = false;
            return true;

        } catch (error) {
            console.error('❌ [Unlock] Failed:', error);
            const errorMsg = error instanceof Error ? error.message : 'Failed to unlock';

            // Show error for manual attempts OR auto-attempts with complete PIN (6+ digits)
            const shouldShowError = !isAutoAttempt || pin.length >= 6;
            if (shouldShowError) {
                showError(errorMsg);
                if (unlockError) {
                    unlockError.textContent = errorMsg;
                    unlockError.classList.remove('hidden');
                }
            }

            newUnlockBtn.disabled = false;
            newUnlockBtn.textContent = 'Unlock';
            if (!isAutoAttempt) {
                pinInput.value = '';
                pinInput.focus();
            }
            isUnlocking = false;
            return false;
        }
    }

    // Setup button click handler
    newUnlockBtn.onclick = () => attemptUnlock(pinInput.value, false);

    // Enter key to unlock
    pinInput.onkeypress = (e) => {
        if (e.key === 'Enter') attemptUnlock(pinInput.value, false);
    };

    // Auto-unlock: try to unlock when PIN reaches valid length (6+ digits)
    // Uses debounce to avoid attempting on every keystroke
    const autoUnlock = createDebounce((pin: string) => {
        attemptUnlock(pin, true);
    }, PIN_AUTO_CONFIRM_DELAY_MS);

    pinInput.oninput = () => {
        const pin = pinInput.value;

        // Cancel any pending auto-unlock attempt
        autoUnlock.cancel();

        // Only attempt auto-unlock if PIN is at least 6 digits
        if (pin.length >= 6 && /^\d+$/.test(pin)) {
            autoUnlock.call(pin);
        }
    };

    // Forgot PIN handler
    const forgotPinLink = document.getElementById('forgot-pin-link');
    if (forgotPinLink) {
        forgotPinLink.onclick = (e) => {
            e.preventDefault();
            showForgotPinModal();
        };
    }

    // Show wallet selector button handler
    const showWalletSelectorBtn = document.getElementById('show-wallet-selector-btn');
    if (showWalletSelectorBtn) {
        showWalletSelectorBtn.onclick = () => {
            showWalletSelectionInterface();
        };
    }
}

// ========================================
// QR-Only Interface (External Wallet Mode)
// ========================================

function showQROnlyInterface() {
    const app = document.getElementById('app');
    if (app) {
        app.innerHTML = `
            <header>
                <h1>⚡ ZapArc</h1>
                <p style="font-size: 12px; color: #666; margin: 0;">QR Code Mode</p>
            </header>
            
            <main>
                <div style="text-align: center; padding: 20px;">
                    <div style="background: #f0f7ff; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
                        <h3 style="margin: 0 0 8px 0; color: #2196F3;">External Wallet Mode</h3>
                        <p style="margin: 0; font-size: 13px; color: #666;">
                            QR codes will be generated for your external Lightning wallet.
                        </p>
                    </div>
                    
                    <div style="display: flex; gap: 8px; justify-content: center;">
                        <button id="setup-wallet-later" style="
                            padding: 8px 16px;
                            border: 1px solid #f7931a;
                            border-radius: 4px;
                            background: white;
                            color: #f7931a;
                            cursor: pointer;
                            font-size: 12px;
                        ">Setup Wallet Later</button>
                        
                        <button id="settings-btn-qr" style="
                            padding: 8px 16px;
                            border: 1px solid #666;
                            border-radius: 4px;
                            background: white;
                            color: #666;
                            cursor: pointer;
                            font-size: 12px;
                        ">Settings</button>
                    </div>
                </div>
            </main>
        `;

        // Add event listeners
        document.getElementById('setup-wallet-later')?.addEventListener('click', () => {
            // Clear the skip flag and show setup again
            chrome.storage.local.remove(['walletSkipped']);
            // Reload to show wizard
            window.location.reload();
        });

        document.getElementById('settings-btn-qr')?.addEventListener('click', handleOpenSettingsPage);
    }
}

// ========================================
// Forgot PIN / Reset Wallet
// ========================================

function showForgotPinModal() {
    console.log('[Wallet] Forgot PIN modal opened');

    const existingModal = document.getElementById('forgot-pin-modal');
    if (existingModal) existingModal.remove();

    const modal = document.createElement('div');
    modal.id = 'forgot-pin-modal';
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0, 0, 0, 0.7); z-index: 10000;
        display: flex; align-items: center; justify-content: center; padding: 20px; box-sizing: border-box;
    `;

    modal.innerHTML = `
        <div style="background: white; border-radius: 8px; max-width: 350px; width: 100%; box-shadow: 0 4px 12px rgba(0,0,0,0.3);">
            <div style="padding: 20px; border-bottom: 1px solid #eee;">
                <h3 style="margin: 0; font-size: 18px; color: #333;">⚠️ Reset Wallet</h3>
            </div>
            <div style="padding: 20px;">
                <div style="background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 6px; padding: 12px; margin-bottom: 16px;">
                    <p style="margin: 0 0 8px 0; font-weight: 600; color: #856404; font-size: 14px;">⚠️ Warning: This action cannot be undone!</p>
                    <p style="margin: 0; font-size: 13px; color: #856404; line-height: 1.4;">This will <strong>DELETE your current wallet permanently</strong>, including all funds.</p>
                </div>
                <p style="margin: 0 0 16px 0; font-size: 14px; color: #666; line-height: 1.5;">You'll need your <strong>12-word recovery phrase</strong> to restore access.</p>
                <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.4;">Without your recovery phrase, funds will be permanently lost.</p>
            </div>
            <div style="display: flex; gap: 12px; padding: 16px 20px; border-top: 1px solid #eee;">
                <button id="cancel-reset-btn" style="flex: 1; padding: 10px 16px; border: 1px solid #ddd; border-radius: 6px; background: white; color: #333; cursor: pointer; font-size: 14px;">Cancel</button>
                <button id="confirm-reset-btn" style="flex: 1; padding: 10px 16px; border: none; border-radius: 6px; background: #dc3545; color: white; cursor: pointer; font-size: 14px;">Delete Wallet</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    document.getElementById('cancel-reset-btn')?.addEventListener('click', () => modal.remove());
    document.getElementById('confirm-reset-btn')?.addEventListener('click', () => handleWalletReset(modal));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

async function handleWalletReset(modal: HTMLElement) {
    try {
        const confirmBtn = document.getElementById('confirm-reset-btn') as HTMLButtonElement;
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Deleting...';
        }

        // Get all wallets first to check if there are others
        const walletsResponse = await ExtensionMessaging.getAllWallets();
        
        if (!walletsResponse.success || !walletsResponse.data) {
            throw new Error('Failed to get wallets');
        }

        const allWallets = walletsResponse.data;
        const hasMultipleWallets = allWallets.length > 1;

        console.log('[Wallet] Delete wallet - has multiple:', hasMultipleWallets, 'total:', allWallets.length);

        // Disconnect SDK
        if (breezSDK) {
            try {
                await breezSDK.disconnect();
            } catch (e) { }
            setBreezSDK(null);
        }

        if (hasMultipleWallets) {
            // Multi-wallet: Delete only the active wallet
            const multiWalletResult = await chrome.storage.local.get(['multiWalletData']);
            if (multiWalletResult.multiWalletData) {
                const multiWalletData = JSON.parse(multiWalletResult.multiWalletData);
                const activeWalletId = multiWalletData.activeWalletId;
                
                console.log('[Wallet] Deleting active wallet:', activeWalletId);
                
                // Get session PIN for deletion
                const sessionData = await chrome.storage.session.get(['walletSessionPin']);
                if (!sessionData.walletSessionPin) {
                    throw new Error('PIN required to delete wallet. Please unlock first.');
                }
                
                // Delete the active wallet
                const deleteResponse = await ExtensionMessaging.deleteWallet(activeWalletId, sessionData.walletSessionPin);
                
                if (!deleteResponse.success) {
                    throw new Error(deleteResponse.error || 'Failed to delete wallet');
                }

                modal.remove();

                // Clear session PIN to force re-unlock
                await chrome.storage.session.remove(['walletSessionPin']);
                
                // Reset state
                setIsWalletUnlocked(false);
                setCurrentBalance(0);
                setBreezSDK(null);

                showNotification('Wallet deleted successfully', 'success', 3000);

                // Hide all other interfaces first
                const mainInterface = document.getElementById('main-interface');
                if (mainInterface) mainInterface.classList.add('hidden');
                
                const unlockInterface = document.getElementById('unlock-interface');
                if (unlockInterface) unlockInterface.classList.add('hidden');
                
                const wizard = document.getElementById('onboarding-wizard');
                if (wizard) wizard.classList.add('hidden');

                console.log('[Wallet] Showing wallet selection interface...');
                
                // Show wallet selection for remaining wallets
                await showWalletSelectionInterface();
                
                console.log('[Wallet] Wallet selection interface should now be visible');
            }
        } else {
            // Last wallet: Clear all storage and show setup
            console.log('[Wallet] Deleting last wallet - clearing all storage');
            
            await chrome.storage.local.clear();
            await chrome.storage.session.clear();

            // Reset state
            setIsWalletUnlocked(false);
            setCurrentBalance(0);
            setGeneratedMnemonic('');
            setMnemonicWords([]);
            setSelectedWords([]);
            setUserPin('');

            modal.remove();

            showNotification('Last wallet deleted. Set up a new wallet.', 'info', 5000);

            // Show wizard
            const unlockInterface = document.getElementById('unlock-interface');
            if (unlockInterface) unlockInterface.classList.add('hidden');

            showWalletSetupPrompt();
        }

    } catch (error) {
        console.error('❌ [Wallet] Reset failed:', error);
        showError('Failed to delete wallet: ' + (error instanceof Error ? error.message : 'Unknown error'));

        const confirmBtn = document.getElementById('confirm-reset-btn') as HTMLButtonElement;
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Delete Wallet';
        }
    }
}

async function lockWallet() {
    console.log('🔒 [Lock] LOCK_WALLET CALLED');

    // Stop auto-lock alarm
    try {
        await chrome.runtime.sendMessage({ type: 'STOP_AUTO_LOCK_ALARM' });
    } catch (e) { }

    // Disconnect SDK
    if (breezSDK) {
        try {
            await breezSDK.disconnect();
        } catch (e) { }
        setBreezSDK(null);
    }

    // Update state
    setIsWalletUnlocked(false);
    await chrome.storage.local.set({ isUnlocked: false });

    // Clear sensitive data
    setCurrentBalance(0);
    clearSensitiveState(true);

    // Show unlock screen
    showUnlockPrompt();
    showInfo('Wallet locked due to inactivity');
}

// ========================================
// UI Helper Functions
// ========================================

function restoreMainInterface() {
    console.log('🔵 [Restore] Restoring main interface');

    hideAllViews();

    const mainInterface = document.getElementById('main-interface');
    if (mainInterface) {
        mainInterface.classList.remove('hidden');
    } else {
        console.warn('⚠️ [Restore] main-interface not found - reloading');
        window.location.reload();
    }
}

function enableWalletControls() {
    const depositBtn = document.getElementById('deposit-btn') as HTMLButtonElement;
    const withdrawBtn = document.getElementById('withdraw-btn') as HTMLButtonElement;

    if (depositBtn) depositBtn.disabled = false;
    if (withdrawBtn) withdrawBtn.disabled = false;
}

function showWalletSetupPrompt() {
    console.log('[Setup] Showing wallet setup prompt');

    hideAllViews();

    const wizard = document.getElementById('onboarding-wizard');
    if (wizard) {
        wizard.classList.remove('hidden');
        showWizardStep('welcome-step');
        setupWizardListeners();
    }
}

// ========================================
// Event Listeners & Auto-lock
// ========================================

function updateActivityTimestamp() {
    chrome.storage.local.set({ lastActivity: Date.now() });
}

let autoLockController: AbortController | null = null;

function setupAutoLockListeners() {
    if (autoLockController) {
        autoLockController.abort();
    }

    autoLockController = new AbortController();
    const signal = autoLockController.signal;

    document.addEventListener('click', updateActivityTimestamp, { signal });
    document.addEventListener('keypress', updateActivityTimestamp, { signal });
}

setupAutoLockListeners();

// Listen for auto-lock from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'WALLET_LOCKED_AUTO') {
        console.log('🔔 [Popup] Auto-lock notification');
        lockWallet();
        sendResponse({ success: true });
    }
    return true;
});

// Cleanup on popup close
window.addEventListener('beforeunload', () => {
    if (breezSDK) {
        disconnectBreezSDK();
    }
});

// ========================================
// Main Event Listeners Setup
// ========================================

function setupEventListeners() {
    console.log('[Popup] Setting up event listeners');

    // Deposit button
    const depositBtn = document.getElementById('deposit-btn');
    if (depositBtn) {
        depositBtn.onclick = () => { hideAllViews(); showDepositInterface(); };
    }

    // Withdraw button
    const withdrawBtn = document.getElementById('withdraw-btn');
    if (withdrawBtn) {
        withdrawBtn.onclick = () => { hideAllViews(); showWithdrawalInterface(); };
    }

    // Settings button
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
        settingsBtn.onclick = () => { handleSettings(); };
    }

    const settingsBackBtn = document.getElementById('settings-back-btn');
    if (settingsBackBtn) {
        settingsBackBtn.onclick = () => hideSettingsInterface();
    }

    const settingsRenameBtn = document.getElementById('settings-rename-wallet-btn');
    if (settingsRenameBtn) {
        settingsRenameBtn.onclick = () => { handleSettingsRenameWallet(); };
    }

    const settingsViewSeedBtn = document.getElementById('settings-view-seed-btn');
    if (settingsViewSeedBtn) {
        settingsViewSeedBtn.onclick = () => { handleSettingsViewRecoveryPhrase(); };
    }

    const settingsLightningAddressToggleBtn = document.getElementById('settings-lightning-address-toggle-btn');
    if (settingsLightningAddressToggleBtn) {
        settingsLightningAddressToggleBtn.onclick = async () => {
            const section = document.getElementById('lightning-address-section');
            if (!section) return;

            const isExpanded = settingsLightningAddressToggleBtn.getAttribute('aria-expanded') === 'true';
            const nextExpanded = !isExpanded;

            settingsLightningAddressToggleBtn.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
            section.classList.toggle('hidden', !nextExpanded);

            if (nextExpanded) {
                await refreshLightningAddress(true);
            }
        };
    }

    const settingsFiatCurrencyToggleBtn = document.getElementById('settings-fiat-currency-toggle-btn');
    if (settingsFiatCurrencyToggleBtn) {
        settingsFiatCurrencyToggleBtn.onclick = async () => {
            const section = document.getElementById('fiat-currency-section');
            if (!section) return;

            const isExpanded = settingsFiatCurrencyToggleBtn.getAttribute('aria-expanded') === 'true';
            const nextExpanded = !isExpanded;

            settingsFiatCurrencyToggleBtn.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
            section.classList.toggle('hidden', !nextExpanded);

            if (nextExpanded) {
                await refreshFiatCurrencyUI();
            }
        };
    }

    const fiatCurrencyUsdBtn = document.getElementById('fiat-currency-usd-btn');
    const fiatCurrencyEurBtn = document.getElementById('fiat-currency-eur-btn');
    if (fiatCurrencyUsdBtn && fiatCurrencyEurBtn) {
        fiatCurrencyUsdBtn.addEventListener('click', async () => {
            await saveFiatCurrency('usd');
        });
        fiatCurrencyEurBtn.addEventListener('click', async () => {
            await saveFiatCurrency('eur');
        });
    }

    const settingsDeleteWalletBtn = document.getElementById('settings-delete-wallet-btn');
    if (settingsDeleteWalletBtn) {
        settingsDeleteWalletBtn.onclick = showForgotPinModal;
    }

    // Contacts button
    const contactsBtn = document.getElementById('contacts-btn');
    if (contactsBtn) {
        contactsBtn.onclick = () => { hideAllViews(); showContactsInterface(); };
    }

    const openWindowBtn = document.getElementById('open-window-btn');
    if (openWindowBtn) {
        openWindowBtn.addEventListener('click', () => {
            const fullViewUrl = chrome.runtime.getURL('popup.html?view=full');
            chrome.tabs.create({ url: fullViewUrl });
        });
    }

    // Lightning Address actions
    const lightningAddressRegisterBtn = document.getElementById('lightning-address-register-btn');
    if (lightningAddressRegisterBtn) {
        lightningAddressRegisterBtn.addEventListener('click', () => {
            handleRegisterLightningAddress();
        });
    }

    const lightningAddressUsernameInput = document.getElementById('lightning-address-username-input') as HTMLInputElement | null;
    if (lightningAddressUsernameInput) {
        lightningAddressUsernameInput.addEventListener('input', () => {
            const normalized = lightningAddressUsernameInput.value.toLowerCase().replace(/[^a-z0-9_-]/g, '');
            if (normalized !== lightningAddressUsernameInput.value) {
                lightningAddressUsernameInput.value = normalized;
            }
        });

        lightningAddressUsernameInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                handleRegisterLightningAddress();
            }
        });
    }

    const lightningAddressCopyBtn = document.getElementById('lightning-address-copy-btn');
    if (lightningAddressCopyBtn) {
        let copyInProgress = false;
        lightningAddressCopyBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (copyInProgress) return;
            copyInProgress = true;
            try {
                const addressEl = document.getElementById('lightning-address-value');
                const address = addressEl?.textContent?.trim() || currentLightningAddressInfo?.lightningAddress;
                if (!address) {
                    showError('No Lightning Address to copy');
                    return;
                }
                await copyToClipboard(address);
            } finally {
                setTimeout(() => { copyInProgress = false; }, 1000);
            }
        });
    }

    const homeLnCopyBtn = document.getElementById('home-ln-address-copy');
    if (homeLnCopyBtn) {
        homeLnCopyBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const address = currentLightningAddressInfo?.lightningAddress;
            if (address) {
                await copyToClipboard(address);
            }
        });
    }

    const lightningAddressUnregisterBtn = document.getElementById('lightning-address-unregister-btn');
    if (lightningAddressUnregisterBtn) {
        lightningAddressUnregisterBtn.addEventListener('click', () => {
            handleUnregisterLightningAddress();
        });
    }

    // Lock button
    const lockBtn = document.getElementById('lock-btn');
    if (lockBtn) {
        lockBtn.onclick = lockWallet;
    }

    // Show all wallets button
    const showWalletSelectorBtn = document.getElementById('show-wallet-selector-btn');
    if (showWalletSelectorBtn) {
        showWalletSelectorBtn.onclick = (e) => {
            e.preventDefault();
            console.log('[Popup] Show all wallets clicked');
            showWalletSelectionInterface();
        };
    }
    
    // Listen for wallet selection changes
    window.addEventListener('wallet-selected', () => {
        console.log('[Popup] Wallet selected event received, updating unlock screen');
        showUnlockPrompt();
    });

    // Refresh button - manually refresh balance and transactions
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
        refreshBtn.onclick = async () => {
            console.log('[Popup] Refresh button clicked');
            showBalanceLoading();
            showTransactionsLoading();
            const startTime = Date.now();

            try {
                await updateBalanceDisplay(true);
                await loadTransactionHistory();
                await refreshLightningAddress(true);
                console.log('[Popup] Refresh complete');
            } catch (error) {
                console.error('[Popup] Error during refresh:', error);
            } finally {
                // Ensure minimum 200ms loading time for better UX
                const elapsed = Date.now() - startTime;
                const minDelay = 200;
                if (elapsed < minDelay) {
                    await new Promise(resolve => setTimeout(resolve, minDelay - elapsed));
                }
                hideBalanceLoading();
                // Note: Transaction loading indicator is cleared when loadTransactionHistory() renders the list
            }
        };
    }

    // View All transactions button
    const viewAllBtn = document.getElementById('view-all-btn');
    console.log('[Popup] View All button found:', !!viewAllBtn);
    if (viewAllBtn) {
        viewAllBtn.onclick = () => {
            console.log('[Popup] View All button clicked');
            showTransactionHistoryView();
        };
    }

    // History back button
    const historyBackBtn = document.getElementById('history-back-btn');
    if (historyBackBtn) {
        historyBackBtn.onclick = () => hideTransactionHistoryView();
    }

    // Modal listeners
    setupModalListeners();
}

async function handleSettings(): Promise<void> {
    hideAllViews();

    const settingsInterface = document.getElementById('settings-interface');
    const lightningSection = document.getElementById('lightning-address-section');
    const lightningToggleBtn = document.getElementById('settings-lightning-address-toggle-btn');
    const fiatSection = document.getElementById('fiat-currency-section');
    const fiatToggleBtn = document.getElementById('settings-fiat-currency-toggle-btn');

    if (settingsInterface) settingsInterface.classList.remove('hidden');

    // Default-open both dropdown sections in settings
    if (lightningSection) lightningSection.classList.remove('hidden');
    if (lightningToggleBtn) lightningToggleBtn.setAttribute('aria-expanded', 'true');
    if (fiatSection) fiatSection.classList.remove('hidden');
    if (fiatToggleBtn) fiatToggleBtn.setAttribute('aria-expanded', 'true');

    await refreshSettingsInterface();
    await refreshLightningAddress(true);
    await refreshFiatCurrencyUI();
}

function handleOpenSettingsPage() {
    chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
}

function formatWalletCreatedAt(createdAt?: number): string {
    if (!createdAt || Number.isNaN(createdAt)) return 'Created: --';
    return `Created: ${new Date(createdAt).toLocaleDateString()}`;
}

async function refreshSettingsInterface(): Promise<void> {
    const nameEl = document.getElementById('settings-wallet-name');
    const createdEl = document.getElementById('settings-wallet-created');

    try {
        const result = await chrome.storage.local.get(['multiWalletData']);
        if (!result.multiWalletData) {
            if (nameEl) nameEl.textContent = 'Current Wallet';
            if (createdEl) createdEl.textContent = 'Created: --';
            return;
        }

        const data = JSON.parse(result.multiWalletData);
        const activeWalletId = data.activeWalletId;
        const wallet = data.wallets?.find((w: any) => w?.metadata?.id === activeWalletId);

        if (nameEl) nameEl.textContent = wallet?.metadata?.nickname || 'Current Wallet';
        if (createdEl) createdEl.textContent = formatWalletCreatedAt(wallet?.metadata?.createdAt);
    } catch (error) {
        console.warn('[Popup] Failed to refresh settings interface:', error);
        if (nameEl) nameEl.textContent = 'Current Wallet';
        if (createdEl) createdEl.textContent = 'Created: --';
    }
}

async function refreshFiatCurrencyUI(): Promise<void> {
    const usdBtn = document.getElementById('fiat-currency-usd-btn');
    const eurBtn = document.getElementById('fiat-currency-eur-btn');
    
    if (!usdBtn || !eurBtn) return;
    
    const fiatCurrency = await getUserFiatCurrency();
    
    if (fiatCurrency === 'usd') {
        usdBtn.classList.add('active');
        eurBtn.classList.remove('active');
    } else {
        eurBtn.classList.add('active');
        usdBtn.classList.remove('active');
    }
}

async function saveFiatCurrency(currency: FiatCurrency): Promise<void> {
    try {
        // Persist first (no dependency on background response)
        await persistFiatCurrency(currency);

        // Update in-memory cache so all modules use the new value immediately
        setFiatCurrencyCache(currency);

        // Best-effort background sync for compatibility with settings consumers
        try {
            const response = await ExtensionMessaging.getUserSettings();
            if (response.success && response.data) {
                const settings = response.data as UserSettings;
                settings.fiatCurrency = currency;
                const saveResponse = await ExtensionMessaging.saveUserSettings(settings);
                if (!saveResponse.success) {
                    console.warn('[Popup] Background saveUserSettings failed, direct persist still succeeded');
                }
            }
        } catch (syncError) {
            console.warn('[Popup] Background settings sync failed, direct persist still succeeded', syncError);
        }

        // Update button UI directly
        const usdBtn = document.getElementById('fiat-currency-usd-btn');
        const eurBtn = document.getElementById('fiat-currency-eur-btn');
        if (usdBtn && eurBtn) {
            if (currency === 'usd') {
                usdBtn.classList.add('active');
                eurBtn.classList.remove('active');
            } else {
                eurBtn.classList.add('active');
                usdBtn.classList.remove('active');
            }
        }

        await updateBalanceDisplay();
        showSuccess(`Currency changed to ${currency.toUpperCase()}`);
    } catch (error) {
        setFiatCurrencyCache(null);
        showError('Failed to update currency preference');
    }
}

function hideSettingsInterface(): void {
    const settingsInterface = document.getElementById('settings-interface');
    const mainInterface = document.getElementById('main-interface');
    const lightningSection = document.getElementById('lightning-address-section');
    const lightningToggleBtn = document.getElementById('settings-lightning-address-toggle-btn');
    const fiatSection = document.getElementById('fiat-currency-section');
    const fiatToggleBtn = document.getElementById('settings-fiat-currency-toggle-btn');

    if (settingsInterface) settingsInterface.classList.add('hidden');
    if (mainInterface) mainInterface.classList.remove('hidden');
    if (lightningSection) lightningSection.classList.add('hidden');
    if (lightningToggleBtn) lightningToggleBtn.setAttribute('aria-expanded', 'false');
    if (fiatSection) fiatSection.classList.add('hidden');
    if (fiatToggleBtn) fiatToggleBtn.setAttribute('aria-expanded', 'false');
}

async function handleSettingsRenameWallet(): Promise<void> {
    try {
        const result = await chrome.storage.local.get(['multiWalletData']);
        if (!result.multiWalletData) {
            showError('No active wallet found');
            return;
        }

        const data = JSON.parse(result.multiWalletData);
        const activeWalletId = data.activeWalletId;
        const wallet = data.wallets?.find((w: any) => w?.metadata?.id === activeWalletId);

        if (!activeWalletId || !wallet?.metadata) {
            showError('No active wallet found');
            return;
        }

        const newName = await promptForText('Enter a new wallet name:', wallet.metadata.nickname || 'Wallet', 'Wallet name');
        if (!newName || !newName.trim()) return;

        const pin = sessionPin || await promptForPIN('Enter PIN to rename wallet');
        if (!pin) return;

        const response = await ExtensionMessaging.renameWallet(activeWalletId, newName.trim(), pin);
        if (!response.success) {
            showError(response.error || 'Failed to rename wallet');
            return;
        }

        showSuccess('Wallet renamed');
        await initializeMultiWalletUI();
        await refreshSettingsInterface();
    } catch (error) {
        showError(error instanceof Error ? error.message : 'Failed to rename wallet');
    }
}

async function handleSettingsViewRecoveryPhrase(): Promise<void> {
    try {
        const pin = sessionPin || await promptForPIN('Enter PIN to reveal recovery phrase');
        if (!pin) return;

        const result = await chrome.storage.local.get(['multiWalletData']);
        if (!result.multiWalletData) {
            showError('No active wallet found');
            return;
        }

        const data = JSON.parse(result.multiWalletData);
        const activeWalletId = data.activeWalletId;
        const wallet = data.wallets?.find((w: any) => w?.metadata?.id === activeWalletId);
        const walletName = wallet?.metadata?.nickname || 'Wallet';

        const response = await ExtensionMessaging.getMasterMnemonic(activeWalletId, pin);
        if (!response.success || !response.data?.mnemonic) {
            showError(response.error || 'Failed to retrieve recovery phrase');
            return;
        }

        showSeedPhraseModal(response.data.mnemonic, walletName);
    } catch (error) {
        showError(error instanceof Error ? error.message : 'Failed to reveal recovery phrase');
    }
}

function showSeedPhraseModal(mnemonic: string, walletName: string): void {
    const words = mnemonic.split(' ');
    const grid = words.map((word, index) => `
        <div class="mnemonic-word"><span class="word-number">${index + 1}.</span> ${word}</div>
    `).join('');

    const existingModal = document.getElementById('seed-phrase-reveal-modal');
    if (existingModal) existingModal.remove();

    const modal = document.createElement('div');
    modal.id = 'seed-phrase-reveal-modal';
    modal.className = 'settings-seed-overlay';
    modal.innerHTML = `
        <div class="settings-seed-modal">
            <div class="modal-header"><h3>🔑 Recovery Phrase — ${walletName}</h3></div>
            <div class="modal-body">
                <div class="warning-box"><strong>⚠️ Security Warning:</strong> Never share your recovery phrase.</div>
                <div class="mnemonic-grid">${grid}</div>
            </div>
            <div class="modal-footer">
                <button id="seed-phrase-close-btn" class="btn-secondary">Close</button>
                <button id="seed-phrase-copy-btn" class="btn-primary">Copy</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const close = () => modal.remove();
    document.getElementById('seed-phrase-close-btn')?.addEventListener('click', close);
    document.getElementById('seed-phrase-copy-btn')?.addEventListener('click', async () => {
        await navigator.clipboard.writeText(mnemonic);
        showSuccess('Recovery phrase copied to clipboard');
    });
    modal.addEventListener('click', (e) => {
        if (e.target === modal) close();
    });
}

// ========================================
// Module Callbacks Setup
// ========================================

function setupModuleCallbacks(): void {
    // Setup SDK event callbacks
    setSdkEventCallbacks({
        onSync: async () => {
            await loadTransactionHistory();
            await updateBalanceDisplay();
        },
        onPaymentReceived: async () => {
            await updateBalanceDisplay();
            await loadTransactionHistory();
            // Also notify deposit interface for immediate UI update
            await handlePaymentReceivedFromSDK();
        },
        onDepositClaimed: async () => {
            await updateBalanceDisplay();
            await loadTransactionHistory();
        }
    });

    // Setup wallet management callbacks
    setWalletManagementCallbacks({
        updateBalanceDisplay,
        loadTransactionHistory,
        showWizardStep,
        setupWizardListeners,
        showSuccess,
        showError,
        showInfo
    });

    // Setup deposit callbacks
    setDepositCallbacks({
        updateBalanceDisplay,
        loadTransactionHistory
    });

    // Setup withdrawal callbacks
    setWithdrawalCallbacks({
        updateBalanceDisplay,
        loadTransactionHistory
    });
}

// ========================================
// Initialization
// ========================================

let popupInitialized = false;

function isFullWindowMode(): boolean {
    const params = new URLSearchParams(window.location.search);
    return params.get('view') === 'full';
}

function applyViewModeClass(): void {
    if (isFullWindowMode()) {
        document.body.classList.add('full-window-mode');
    } else {
        document.body.classList.remove('full-window-mode');
    }
}

async function initializePopup() {
    if (popupInitialized) {
        console.warn('[Popup] Already initialized, skipping duplicate init');
        return;
    }
    popupInitialized = true;
    console.log('🔵 [Popup] Initializing...');

    try {
        // Setup module callbacks first
        setupModuleCallbacks();

        // Setup event listeners
        setupEventListeners();
        setupWizardListeners();
        initializeContactsUI();

        // Check for existing wallet
        const storageData = await chrome.storage.local.get(['isUnlocked', 'cachedBalance']);
        const hasWallet = await ExtensionMessaging.getAllWallets().then(r => r.success && r.data && r.data.length > 0);

        console.log('[Popup] State:', { hasWallet, isUnlocked: storageData.isUnlocked });

        if (!hasWallet) {
            // No wallet - show setup
            showWalletSetupPrompt();
            return;
        }

        // Has wallet - check if locked
        if (!storageData.isUnlocked) {
            showUnlockPrompt();
            return;
        }

        // Try to auto-reconnect with session PIN
        const sessionData = await chrome.storage.session.get(['walletSessionPin']);
        if (sessionData.walletSessionPin) {
            try {
                console.log('🔐 [Popup] Attempting auto-reconnect...');

                const walletResponse = await ExtensionMessaging.loadWallet(sessionData.walletSessionPin);

                if (walletResponse.success && walletResponse.data) {
                    // Connect SDK
                    const sdk = await connectBreezSDK(walletResponse.data.mnemonic);
                    setBreezSDK(sdk);
                    setIsWalletUnlocked(true);
                    setSessionPin(sessionData.walletSessionPin);

                    // Show main interface
                    restoreMainInterface();

                    // Load cached balance immediately for instant UI
                    const hasCachedBalance = storageData.cachedBalance !== undefined && storageData.cachedBalance !== null;
                    if (hasCachedBalance) {
                        console.log('💾 [Popup] Using cached balance:', storageData.cachedBalance);
                        setCurrentBalance(storageData.cachedBalance);
                        const balanceElement = document.getElementById('balance');
                        if (balanceElement) {
                            balanceElement.textContent = `${storageData.cachedBalance.toLocaleString()} sats`;
                        }

                        // Show cached fiat estimate immediately (then reconcile with selected currency)
                        try {
                            const balanceFiatElement = document.getElementById('balance-fiat');
                            if (balanceFiatElement) {
                                const multiWalletResult = await chrome.storage.local.get(['multiWalletData']);
                                let fiatCacheKey = 'cachedBalanceFiat';
                                if (multiWalletResult.multiWalletData) {
                                    const mwd = JSON.parse(multiWalletResult.multiWalletData);
                                    if (mwd.activeWalletId) {
                                        const subIdx = mwd.activeSubWalletIndex || 0;
                                        fiatCacheKey = walletCacheKey('cachedBalanceFiat', mwd.activeWalletId, subIdx);
                                    }
                                }

                                const fiatCacheData = await chrome.storage.local.get([fiatCacheKey, 'cachedBalanceFiat']);
                                const fiatCache = fiatCacheData[fiatCacheKey] || fiatCacheData.cachedBalanceFiat;

                                // Immediate paint: if sats match, show cached fiat right away (fiat display modes only)
                                if (fiatCache && fiatCache.balanceSats === storageData.cachedBalance && fiatCache.display && fiatCache.currency !== 'sats') {
                                    balanceFiatElement.textContent = fiatCache.display;
                                    balanceFiatElement.classList.remove('hidden');
                                }

                                // Background reconcile: if cached currency differs from selected, refresh display
                                void (async () => {
                                    const selectedCurrency = await getDisplayCurrency();
                                    if (selectedCurrency === 'sats') {
                                        balanceFiatElement.classList.add('hidden');
                                        return;
                                    }

                                    if (!fiatCache || fiatCache.currency !== selectedCurrency || !fiatCache.display) {
                                        const fiatAmount = await satsToFiat(storageData.cachedBalance, selectedCurrency);
                                        if (fiatAmount !== null) {
                                            balanceFiatElement.textContent = formatFiat(fiatAmount, selectedCurrency);
                                            balanceFiatElement.classList.remove('hidden');
                                        }
                                    }
                                })();
                            }
                        } catch (e) { /* ignore cached fiat errors */ }
                        
                        // Also update withdraw balance if visible
                        const withdrawBalanceElement = document.getElementById('withdraw-balance-display');
                        if (withdrawBalanceElement) {
                            withdrawBalanceElement.textContent = storageData.cachedBalance.toLocaleString();
                        }
                    } else {
                        console.log('⚠️ [Popup] No cached balance found - will fetch from SDK');
                    }

                    // Only show loading indicator if we don't have cached data
                    setBalanceLoading(!hasCachedBalance);

                    // Load cached transactions or show loading
                    const transactionList = document.getElementById('transaction-list');
                    if (transactionList) {
                        // Get active wallet ID from multi-wallet data structure
                        const multiWalletResult = await chrome.storage.local.get(['multiWalletData']);
                        let activeWalletId = null;
                        let activeSubWalletIndex = 0;

                        console.log('🔍 [Popup] multiWalletResult:', !!multiWalletResult.multiWalletData);

                        if (multiWalletResult.multiWalletData) {
                            try {
                                const multiWalletData = JSON.parse(multiWalletResult.multiWalletData);
                                activeWalletId = multiWalletData.activeWalletId;
                                activeSubWalletIndex = multiWalletData.activeSubWalletIndex || 0;
                                console.log('🔍 [Popup] Active wallet ID from multiWalletData:', activeWalletId);
                            } catch (e) {
                                console.error('⚠️ [Popup] Failed to parse multiWalletData:', e);
                            }
                        } else {
                            console.log('⚠️ [Popup] No multiWalletData found in storage');
                        }

                        // Check if we have cached transactions for this specific wallet
                        let cachedTransactions = null;
                        let cacheWasChecked = false;

                        if (activeWalletId) {
                            const cacheKey = walletCacheKey('cachedTransactions', activeWalletId, activeSubWalletIndex);
                            const cacheCheckedKey = walletCacheKey('cachedTransactionsChecked', activeWalletId, activeSubWalletIndex);
                            const cachedTxData = await chrome.storage.local.get([cacheKey, cacheCheckedKey]);
                            cachedTransactions = cachedTxData[cacheKey];
                            cacheWasChecked = cachedTxData[cacheCheckedKey] === true;
                            console.log(`🔍 [Popup] Cache for ${activeWalletId}: ${cachedTransactions?.length || 0} transactions, checked: ${cacheWasChecked}`);
                        }

                        if (cachedTransactions && cachedTransactions.length > 0) {
                            // Show cached data immediately - SDK sync will update in background
                            console.log('💾 [Popup] Using cached transactions');
                            storedTransactions = cachedTransactions as StoredTransaction[];
                            renderTransactionList(transactionList, storedTransactions);
                        } else if (cacheWasChecked) {
                            // We've checked before and there were no transactions
                            console.log('💾 [Popup] No transactions (cached empty state)');
                            transactionList.innerHTML = getTransactionEmptyStateHtml();
                        } else {
                            console.log('⚠️ [Popup] No cache - showing loading indicator');
                            showTransactionsLoading();
                        }
                    }

                    enableWalletControls();
                    await initializeMultiWalletUI();
                    await refreshLightningAddress();

                    // Check for any pending sub-wallet discovery to resume
                    const pin = sessionData.walletSessionPin;
                    console.log('🔍 [Popup] Auto-unlock: Checking for pending discovery to resume...');
                    resumePendingDiscovery(async (masterKeyId: string) => {
                        try {
                            const result = await ExtensionMessaging.getMasterMnemonic(masterKeyId, pin);
                            return result.success && result.data ? result.data.mnemonic : null;
                        } catch (err) {
                            console.error('[Popup] getMasterMnemonic failed:', err);
                            return null;
                        }
                    }).catch(err => {
                        console.warn('[Popup] Resume discovery error (non-fatal):', err);
                    });

                    // Start auto-lock
                    await chrome.runtime.sendMessage({ type: 'START_AUTO_LOCK_ALARM' });

                    console.log('✅ [Popup] Auto-reconnect successful - SDK will sync in background');
                    return;
                }
            } catch (error) {
                console.error('[Popup] Auto-reconnect failed:', error);
            }
        }

        // Session expired - show unlock
        showUnlockPrompt();

    } catch (error) {
        console.error('❌ [Popup] Initialization error:', error);
        showError('Failed to initialize popup');
    }
}

// Start initialization when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    applyViewModeClass();
    void initializePopup();
});

// ========================================
// Hierarchical Wallet Switching Event Handler
// ========================================

// De-duplication tracking to prevent multiple notifications for the same switch
let lastWalletSwitchKey = '';
let lastWalletSwitchTime = 0;

/**
 * Handle wallet switch events from wallet-management.ts
 * This reconnects the SDK with the new derived mnemonic
 */
window.addEventListener('hierarchical-wallet-switched', async (event: Event) => {
    const customEvent = event as CustomEvent<{
        masterKeyId: string;
        subWalletIndex: number;
        masterKeyNickname: string;
        subWalletNickname: string;
    }>;

    console.log('🔄 [Popup] Hierarchical wallet switch event received', {
        masterKeyId: customEvent.detail.masterKeyId,
        subWalletIndex: customEvent.detail.subWalletIndex
    });

    try {
        // Show cached balance + transactions IMMEDIATELY before SDK work
        const switchedWalletId = customEvent.detail.masterKeyId;
        let shownCachedTx = false;

        // Cached balance — show instantly
        try {
            const balCacheKey = walletCacheKey('cachedBalance', switchedWalletId, customEvent.detail.subWalletIndex);
            const balData = await chrome.storage.local.get([balCacheKey]);
            const cachedBal = balData[balCacheKey];
            if (cachedBal !== undefined && cachedBal !== null) {
                console.log(`💰 [Popup] Showing cached balance for ${switchedWalletId}: ${cachedBal}`);
                setCurrentBalance(cachedBal);
                const balanceElement = document.getElementById('balance');
                if (balanceElement) balanceElement.textContent = `${cachedBal.toLocaleString()} sats`;
                const withdrawBalanceElement = document.getElementById('withdraw-balance-display');
                if (withdrawBalanceElement) withdrawBalanceElement.textContent = cachedBal.toLocaleString();
            }
        } catch (e) { /* ignore */ }

        // Cached transactions — show instantly
        try {
            const txCacheKey = walletCacheKey('cachedTransactions', switchedWalletId, customEvent.detail.subWalletIndex);
            const cachedData = await chrome.storage.local.get([txCacheKey]);
            const cached = cachedData[txCacheKey];
            if (cached && cached.length > 0) {
                console.log(`📦 [Popup] Showing ${cached.length} cached transactions for ${switchedWalletId}`);
                storedTransactions = cached as StoredTransaction[];
                const transactionList = document.getElementById('transaction-list');
                if (transactionList) {
                    renderTransactionList(transactionList, storedTransactions.slice(0, 5));
                }
                shownCachedTx = true;
            }
        } catch (e) {
            console.warn('[Popup] Cache read failed:', e);
        }

        // Only show loading spinner if no cached transactions
        if (!shownCachedTx) {
            showTransactionsLoading();
        }

        // Disconnect existing SDK and clear stale state
        if (breezSDK) {
            console.log('🔄 [Popup] Disconnecting previous SDK...');
            await disconnectBreezSDK();
            setBreezSDK(null);
            setIsSDKInitialized(false);
        }
        // Clear Lightning Address immediately so old wallet's address doesn't linger
        currentLightningAddressInfo = null;
        renderLightningAddressUI();
        
        // Connect with derived mnemonic fetched from background
        const pin = sessionPin;
        if (!pin) {
            throw new Error('Session expired. Please unlock again.');
        }

        const mnemonicResponse = await ExtensionMessaging.getHierarchicalWalletMnemonic(
            customEvent.detail.masterKeyId,
            customEvent.detail.subWalletIndex,
            pin
        );

        if (!mnemonicResponse.success || !mnemonicResponse.data) {
            throw new Error(mnemonicResponse.error || 'Failed to retrieve wallet mnemonic');
        }

        console.log('🔄 [Popup] Connecting SDK with derived mnemonic...');
        const sdk = await connectBreezSDK(mnemonicResponse.data);
        setBreezSDK(sdk);
        setIsSDKInitialized(true);

        // Background refresh — update balance and transactions from SDK
        console.log('🔄 [Popup] Fetching balance and transactions...');
        await updateBalanceDisplay();
        
        // Small delay to allow SDK to sync before loading transactions
        await new Promise(resolve => setTimeout(resolve, 500));
        await loadTransactionHistory();
        await refreshLightningAddress();

        console.log('✅ [Popup] SDK reconnected for new wallet', {
            masterKeyNickname: customEvent.detail.masterKeyNickname,
            subWalletNickname: customEvent.detail.subWalletNickname,
            subWalletIndex: customEvent.detail.subWalletIndex
        });
        
        // Don't show notification here - let the caller decide
        // This prevents duplicate notifications when the event fires multiple times
        console.log('[Popup] Wallet switched successfully, balance and transactions refreshed');
    } catch (error) {
        console.error('❌ [Popup] Failed to reconnect SDK after wallet switch:', error);
        showError('Failed to connect to new wallet');
    }
});
