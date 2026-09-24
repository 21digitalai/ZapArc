// Multi-Wallet Management UI
// Handles wallet selector, switching, rename, delete, and management interface

import { ExtensionMessaging } from '../utils/messaging';
import {
    currentWallets,
    setCurrentWallets,
    isWalletSelectorOpen,
    setIsWalletSelectorOpen,
    sessionPin,
    setSessionPin,
    breezSDK,
    setBreezSDK,
    isWalletUnlocked,
    setIsWalletUnlocked,
    renameWalletId,
    setRenameWalletId,
    renameWalletCurrentName,
    setRenameWalletCurrentName,
    isRenameSaving,
    setIsRenameSaving,
    setIsAddingWallet,
    // Hierarchical wallet state
    masterKeys,
    setMasterKeys,
    activeMasterKeyId,
    setActiveMasterKeyId,
    activeSubWalletIndex,
    setActiveSubWalletIndex,
    isHierarchicalMode,
    setIsHierarchicalMode,
    expandedMasterKeys,
    toggleMasterKeyExpanded as toggleMasterKeyExpandedState
} from './state';
import type { MasterKeyMetadata, SubWalletEntry } from '../types';
import { connectBreezSDK, discoverSubWalletsInPopup } from './sdk';
import { showError, showSuccess, showInfo, showNotification } from './notifications';
import { clearWalletDisplay, showTransactionsLoading } from './ui-helpers';

// Track which wallets are currently being discovered
const walletsBeingDiscovered = new Set<string>();

// Storage key for notification deduplication (persisted across popup sessions)
const DISCOVERY_NOTIFICATION_KEY = 'lastDiscoveryNotification';

// Track discovery progress for UI updates
interface DiscoveryProgress {
    masterKeyId: string;
    currentIndex: number;
    foundCount: number;
    isComplete: boolean;
}
let currentDiscoveryProgress: DiscoveryProgress | null = null;

// Persistent discovery state for resume functionality
interface PendingDiscovery {
    masterKeyId: string;
    nextIndexToCheck: number;  // The next index to check when resuming
    foundCount: number;        // How many sub-wallets have been found so far
    startedAt: number;         // Timestamp when discovery started
}

const PENDING_DISCOVERY_KEY = 'pendingSubWalletDiscovery';

/**
 * Save pending discovery state to storage for resume
 */
async function savePendingDiscovery(state: PendingDiscovery | null): Promise<void> {
    if (state) {
        await chrome.storage.local.set({ [PENDING_DISCOVERY_KEY]: state });
        console.log('[Discovery] Saved pending state:', state);
    } else {
        await chrome.storage.local.remove(PENDING_DISCOVERY_KEY);
        console.log('[Discovery] Cleared pending state');
    }
}

/**
 * Load pending discovery state from storage
 */
async function loadPendingDiscovery(): Promise<PendingDiscovery | null> {
    const result = await chrome.storage.local.get(PENDING_DISCOVERY_KEY);
    return result[PENDING_DISCOVERY_KEY] || null;
}

import { showPINModal, promptForPIN, promptForText, showModal, hideModal } from './modals';

/**
 * Start sub-wallet discovery for a newly imported wallet
 * Shows progress in the wallet list UI and adds discovered sub-wallets
 */
// Track which wallets have active discovery running (not just marked for UI)
const activeDiscoveryRunning = new Set<string>();

export async function startSubWalletDiscovery(
    masterKeyId: string,
    mnemonic: string,
    startFromIndex: number = 1
): Promise<void> {
    // Check if discovery is already RUNNING (not just marked for UI)
    if (activeDiscoveryRunning.has(masterKeyId)) {
        console.log('[Discovery] Already discovering for wallet:', masterKeyId);
        return;
    }

    console.log(`[Discovery] Starting discovery for wallet: ${masterKeyId} from index ${startFromIndex}`);
    activeDiscoveryRunning.add(masterKeyId);
    walletsBeingDiscovered.add(masterKeyId);

    // Save initial pending state
    await savePendingDiscovery({
        masterKeyId,
        nextIndexToCheck: startFromIndex,
        foundCount: 0,
        startedAt: Date.now()
    });

    // Update UI to show discovery in progress
    updateDiscoveryUI(masterKeyId, 'Scanning for sub-wallets...', 0, false);

    try {
        const discoveredWallets = await discoverSubWalletsInPopup(
            mnemonic,
            async (_status, index, foundCount) => {
                // Update progress in UI (keep message simple for users)
                currentDiscoveryProgress = {
                    masterKeyId,
                    currentIndex: index,
                    foundCount,
                    isComplete: false
                };
                // Save progress for resume - save CURRENT index since we're about to check it
                // If popup closes during the check, we need to resume from this same index
                await savePendingDiscovery({
                    masterKeyId,
                    nextIndexToCheck: index,  // Save the index we're about to check, not +1
                    foundCount,
                    startedAt: Date.now()
                });
                // Don't change the message - keep it simple as "Scanning for sub-wallets..."
                updateDiscoveryUI(masterKeyId, 'Scanning for sub-wallets...', foundCount, false);
            },
            async (wallet) => {
                // When a sub-wallet is found, add it immediately
                console.log(`[Discovery] Found sub-wallet ${wallet.index} with ${wallet.balanceSats} sats`);

                const addResult = await ExtensionMessaging.addDiscoveredSubWallets(masterKeyId, [{
                    index: wallet.index,
                    nickname: `Sub-wallet ${wallet.index}`
                }]);

                if (addResult.success) {
                    console.log(`[Discovery] Added sub-wallet ${wallet.index}`);
                    // Refresh the wallet list to show new sub-wallet
                    await loadWalletManagementList();
                }
            },
            startFromIndex
        );

        // Discovery complete - clear pending state
        await savePendingDiscovery(null);

        // Discovery complete
        currentDiscoveryProgress = {
            masterKeyId,
            currentIndex: 0,
            foundCount: discoveredWallets.length,
            isComplete: true
        };

        console.log(`[Discovery] Complete! Found ${discoveredWallets.length} new sub-wallets in this session (started from index ${startFromIndex})`);

        // Only show notification if we found new sub-wallets in THIS discovery session
        // (not counting ones found in previous sessions before resume)
        // Deduplicate using persistent storage to prevent duplicates across popup sessions
        if (discoveredWallets.length > 0) {
            const notificationKey = `${masterKeyId}-${discoveredWallets.length}-${startFromIndex}`;
            const now = Date.now();

            // Check storage for last notification (persists across popup sessions)
            const stored = await chrome.storage.local.get(DISCOVERY_NOTIFICATION_KEY);
            const lastNotification = stored[DISCOVERY_NOTIFICATION_KEY] as { key: string; time: number } | undefined;

            const isDuplicate = lastNotification &&
                               lastNotification.key === notificationKey &&
                               (now - lastNotification.time) < 30000; // 30 second window (longer for popup reopens)

            if (!isDuplicate) {
                // Save to storage before showing notification
                await chrome.storage.local.set({
                    [DISCOVERY_NOTIFICATION_KEY]: { key: notificationKey, time: now }
                });
                showNotification(
                    `Found ${discoveredWallets.length} sub-wallet${discoveredWallets.length > 1 ? 's' : ''} with history`,
                    'success'
                );
            } else {
                console.log('[Discovery] Skipping duplicate notification (from storage check)');
            }
        } else if (startFromIndex > 1) {
            // Resumed discovery but didn't find any more - that's fine, just log it
            console.log('[Discovery] Resumed discovery completed - no additional sub-wallets found');
        }

        // Remove discovery indicator and clear state BEFORE refreshing UI
        // This ensures the UI doesn't show the spinner anymore
        activeDiscoveryRunning.delete(masterKeyId);
        walletsBeingDiscovered.delete(masterKeyId);
        currentDiscoveryProgress = null;

        updateDiscoveryUI(masterKeyId, '', 0, true);

        // Final refresh of wallet list (now without discovery spinner)
        await loadWalletManagementList();
        await initializeMultiWalletUI();

    } catch (error) {
        console.error('[Discovery] Error during discovery:', error);
        showError('Sub-wallet discovery failed');
        // Keep pending state on error so it can be resumed
        // Clear in-memory state
        activeDiscoveryRunning.delete(masterKeyId);
        walletsBeingDiscovered.delete(masterKeyId);
        currentDiscoveryProgress = null;
    }
}

/**
 * Check for and resume any pending discovery
 * Should be called after wallet unlock
 */
export async function resumePendingDiscovery(getMnemonic: (masterKeyId: string) => Promise<string | null>): Promise<void> {
    console.log('[Discovery] resumePendingDiscovery called');

    const pending = await loadPendingDiscovery();
    if (!pending) {
        console.log('[Discovery] No pending discovery to resume');
        return;
    }

    console.log('[Discovery] Found pending discovery:', JSON.stringify(pending));

    // Check if the discovery is still relevant (not too old - 24 hours max)
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const ageMs = Date.now() - pending.startedAt;
    console.log(`[Discovery] Pending discovery age: ${ageMs}ms (max: ${MAX_AGE_MS}ms)`);

    if (ageMs > MAX_AGE_MS) {
        console.log('[Discovery] Pending discovery is too old, clearing');
        await savePendingDiscovery(null);
        return;
    }

    // Get the mnemonic for the wallet
    const mnemonic = await getMnemonic(pending.masterKeyId);

    if (!mnemonic) {
        console.log('[Discovery] Could not get mnemonic for pending discovery, clearing');
        await savePendingDiscovery(null);
        return;
    }


    // Mark wallet for UI display before starting
    markWalletForDiscovery(pending.masterKeyId);

    // Refresh the wallet dropdown to show the discovery spinner
    // (the dropdown was already populated before resumePendingDiscovery was called)
    await populateWalletDropdown();

    // Resume discovery from where we left off
    startSubWalletDiscovery(pending.masterKeyId, mnemonic, pending.nextIndexToCheck).catch(err => {
        console.error('[Discovery] Resume discovery error:', err);
    });
}

/**
 * Update the discovery UI indicator for a wallet
 * Updates both the wallet management list indicator AND the main interface banner
 */
function updateDiscoveryUI(
    masterKeyId: string,
    status: string,
    foundCount: number,
    isComplete: boolean
): void {
    // Update wallet management list indicator (if visible)
    const discoveryIndicator = document.querySelector(
        `.discovery-indicator[data-master-id="${masterKeyId}"]`
    );

    if (discoveryIndicator) {
        if (isComplete) {
            discoveryIndicator.remove();
        } else {
            const statusEl = discoveryIndicator.querySelector('.discovery-status');
            const countEl = discoveryIndicator.querySelector('.discovery-count');
            if (statusEl) statusEl.textContent = status;
            if (countEl && foundCount > 0) {
                countEl.textContent = `Found: ${foundCount}`;
                countEl.classList.remove('hidden');
            }
        }
    }

    // Update main interface discovery banner
    const discoveryBanner = document.getElementById('discovery-banner');
    if (discoveryBanner) {
        if (isComplete) {
            discoveryBanner.classList.add('hidden');
        } else {
            discoveryBanner.classList.remove('hidden');
            const textEl = discoveryBanner.querySelector('.discovery-banner-text');
            const countEl = document.getElementById('discovery-banner-count');
            if (textEl) textEl.textContent = status;
            if (countEl && foundCount > 0) {
                countEl.textContent = `Found: ${foundCount}`;
                countEl.classList.remove('hidden');
            }
        }
    }
}

/**
 * Check if a wallet is currently being discovered
 */
export function isWalletBeingDiscovered(masterKeyId: string): boolean {
    return walletsBeingDiscovered.has(masterKeyId);
}

/**
 * Mark a wallet as pending discovery (before actual discovery starts)
 * This ensures the UI shows the loading state immediately
 */
export function markWalletForDiscovery(masterKeyId: string): void {
    walletsBeingDiscovered.add(masterKeyId);
}

/**
 * Refresh the discovery banner visibility based on current discovery state
 * Called when UI initializes to ensure banner is visible if discovery is in progress
 */
function refreshDiscoveryBannerVisibility(): void {
    const discoveryBanner = document.getElementById('discovery-banner');
    if (!discoveryBanner) return;

    // Check if any wallet is being discovered
    if (walletsBeingDiscovered.size > 0) {
        // Show the banner
        discoveryBanner.classList.remove('hidden');
        const textEl = discoveryBanner.querySelector('.discovery-banner-text');
        if (textEl) textEl.textContent = 'Scanning for sub-wallets...';

        // Update count if we have progress info
        if (currentDiscoveryProgress) {
            const countEl = document.getElementById('discovery-banner-count');
            if (countEl && currentDiscoveryProgress.foundCount > 0) {
                countEl.textContent = `Found: ${currentDiscoveryProgress.foundCount}`;
                countEl.classList.remove('hidden');
            }
        }
    } else {
        // No discovery in progress, hide the banner
        discoveryBanner.classList.add('hidden');
    }
}

// Callback type for wallet operations that need main popup functions
export type WalletManagementCallbacks = {
    updateBalanceDisplay: () => Promise<void>;
    loadTransactionHistory: () => Promise<void>;
    showWizardStep: (step: string) => void;
    setupWizardListeners: () => void;
    showSuccess: (message: string) => void;
    showError: (message: string) => void;
    showInfo: (message: string) => void;
};

// Show add wallet flow (sets isAddingWallet and shows wizard)
async function showAddWalletFlow(): Promise<void> {
    console.log('[Wallet Management] Starting add wallet flow');
    setIsAddingWallet(true);

    // Load master keys first so the sub-wallet button can show correctly
    const masterKeysResponse = await ExtensionMessaging.getMasterKeyMetadata();
    if (masterKeysResponse.success && masterKeysResponse.data) {
        setMasterKeys(masterKeysResponse.data);
        console.log(`[Wallet Management] Loaded ${masterKeysResponse.data.length} master key(s) for add wallet flow`);
    }

    // Hide management interface
    hideWalletManagementInterface();

    // Hide main interface, show wizard
    const mainInterface = document.getElementById('main-interface');
    const wizard = document.getElementById('onboarding-wizard');

    if (mainInterface) mainInterface.classList.add('hidden');
    if (wizard) {
        wizard.classList.remove('hidden');
        // Trigger the wizard to show setup-choice-step
        callbacks?.showWizardStep('setup-choice-step');
        callbacks?.setupWizardListeners();
    }
}

let callbacks: WalletManagementCallbacks | null = null;

export function setWalletManagementCallbacks(cb: WalletManagementCallbacks): void {
    callbacks = cb;
}

// ========================================
// Multi-Wallet Selector UI
// ========================================

/**
 * Initialize multi-wallet UI if user has multiple wallets
 */
export async function initializeMultiWalletUI(): Promise<void> {
    try {
        console.log('🔄 [Multi-Wallet] Initializing wallet selector');

        // Get all wallets
        const walletsResponse = await ExtensionMessaging.getAllWallets();
        if (!walletsResponse.success || !walletsResponse.data) {
            console.log('[Multi-Wallet] No wallets found or error');
            return;
        }

        setCurrentWallets(walletsResponse.data);
        console.log(`[Multi-Wallet] Found ${currentWallets.length} wallet(s)`);

        // Show wallet selector if one or more wallets exist (shows "+" button to add more)
        const walletSelector = document.getElementById('wallet-selector');
        if (currentWallets.length >= 1 && walletSelector) {
            walletSelector.classList.remove('hidden');
            updateWalletSelectorUI();
            setupWalletSelectorListeners();
        }

        // Refresh discovery banner visibility in case discovery is in progress
        refreshDiscoveryBannerVisibility();
    } catch (error) {
        console.error('[Multi-Wallet] Initialization error:', error);
    }
}

/**
 * Update wallet selector UI with current wallets
 */
export async function updateWalletSelectorUI(): Promise<void> {
    try {
        // Get active hierarchical wallet info
        const result = await chrome.storage.local.get(['multiWalletData']);
        if (!result.multiWalletData) return;

        const multiWalletData = JSON.parse(result.multiWalletData);
        const activeWalletId = multiWalletData.activeWalletId;
        const activeSubWalletIndex = multiWalletData.activeSubWalletIndex || 0;

        if (!activeWalletId) return;

        // Find the active wallet
        const activeWallet = multiWalletData.wallets?.find((w: any) => w.metadata.id === activeWalletId);
        if (!activeWallet) return;

        // Determine display name based on active sub-wallet
        let displayName = activeWallet.metadata.nickname;
        
        if (activeSubWalletIndex === 0) {
            // Master wallet is active (index 0)
            displayName = activeWallet.metadata.nickname;
        } else if (activeWallet.subWallets) {
            // Find the active sub-wallet
            const activeSubWallet = activeWallet.subWallets.find((sw: any) => sw.index === activeSubWalletIndex);
            if (activeSubWallet) {
                displayName = activeSubWallet.nickname;
            }
        }

        // Update current wallet button
        const currentWalletName = document.getElementById('current-wallet-name');
        if (currentWalletName) {
            currentWalletName.textContent = displayName;
        }

        // Update wallet count badge
        const walletCountBadge = document.getElementById('wallet-count-badge');
        if (walletCountBadge) {
            const totalWallets = multiWalletData.wallets?.length || 0;
            walletCountBadge.textContent = totalWallets.toString();
        }

        // Hide delete button for sub-wallets (only show for master wallet at index 0)
        const deleteWalletBtn = document.getElementById('delete-wallet-btn');
        if (deleteWalletBtn) {
            if (activeSubWalletIndex > 0) {
                deleteWalletBtn.classList.add('hidden');
            } else {
                deleteWalletBtn.classList.remove('hidden');
            }
        }

        // Populate wallet dropdown list
        await populateWalletDropdown();
    } catch (error) {
        console.error('[Wallet Management] Error updating wallet selector UI:', error);
    }
}

/**
 * Populate wallet dropdown with hierarchical wallet structure
 * Shows master keys (wallets) with their sub-wallets nested underneath
 */
export async function populateWalletDropdown(): Promise<void> {
    const walletList = document.getElementById('wallet-list');
    if (!walletList) return;

    walletList.innerHTML = '<div class="loading-wallets">Loading...</div>';

    try {
        // Get current active wallet info from storage
        const storageResult = await chrome.storage.local.get(['multiWalletData']);
        if (!storageResult.multiWalletData) {
            walletList.innerHTML = '<div class="no-wallets">No wallets found</div>';
            return;
        }

        const data = JSON.parse(storageResult.multiWalletData);
        const activeWalletId = data.activeWalletId;
        const activeSubWalletIndex = data.activeSubWalletIndex || 0;

        let html = '';

        // Each wallet is a master key
        for (const wallet of currentWallets) {
            const isActiveWallet = wallet.id === activeWalletId;
            const isDiscovering = walletsBeingDiscovered.has(wallet.id);
            const allSubWallets = (data.wallets?.find((w: any) => w.metadata.id === wallet.id)?.subWallets) || [];
            // Filter out archived sub-wallets
            const subWallets = allSubWallets.filter((sw: any) => !sw.archivedAt);
            const hasSubWallets = subWallets.length > 0;
            const createdDate = new Date(wallet.createdAt).toLocaleDateString();

            // Show spinner if discovering, checkmark if active, nothing otherwise
            const statusIcon = isDiscovering
                ? '<span class="discovery-spinner-small">⏳</span>'
                : (isActiveWallet ? '<span class="active-check">✓</span>' : '');

            if (hasSubWallets) {
                // Wallet with sub-wallets - show hierarchical structure
                // Master wallet is clickable at top level (index 0), sub-wallets shown below (index 1+)
                const isMasterActive = isActiveWallet && activeSubWalletIndex === 0;
                const masterStatusIcon = isDiscovering
                    ? '<span class="discovery-spinner-small">⏳</span>'
                    : (isMasterActive ? '<span class="active-check">✓</span>' : '');

                html += `
                    <div class="master-key-dropdown-item expanded" data-master-id="${wallet.id}">
                        <div class="master-key-dropdown-header ${isMasterActive ? 'active' : ''}"
                             data-master-id="${wallet.id}" data-sub-index="0">
                            <span class="dropdown-expand-icon">▼</span>
                            <span class="master-key-icon">🔑</span>
                            <div class="master-key-dropdown-info">
                                <div class="master-key-dropdown-name">${wallet.nickname}</div>
                                <div class="master-key-dropdown-meta">${isDiscovering ? 'Scanning...' : `Last used: ${createdDate}`}</div>
                            </div>
                            ${masterStatusIcon}
                        </div>

                        <!-- Sub-wallets wrapper for proper indentation -->
                        <div class="sub-wallet-list">
                            ${subWallets.map((sw: any, i: number) => {
                                const isActiveSubWallet = isActiveWallet && sw.index === activeSubWalletIndex;
                                const isLast = i === subWallets.length - 1;
                                return `
                                    <div class="sub-wallet-dropdown-item ${isActiveSubWallet ? 'active' : ''}"
                                         data-master-id="${wallet.id}" data-sub-index="${sw.index}">
                                        <span class="sub-wallet-indent">${isLast ? '└──' : '├──'}</span>
                                        <span class="sub-wallet-name">${sw.nickname}</span>
                                        ${isActiveSubWallet ? '<span class="active-check">✓</span>' : ''}
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `;
            } else {
                // Wallet without sub-wallets - use same header structure for consistency
                html += `
                    <div class="master-key-dropdown-item" data-master-id="${wallet.id}">
                        <div class="master-key-dropdown-header ${isActiveWallet ? 'active' : ''}"
                             data-master-id="${wallet.id}" data-sub-index="0">
                            <span class="dropdown-expand-icon"></span>
                            <span class="master-key-icon">🔑</span>
                            <div class="master-key-dropdown-info">
                                <div class="master-key-dropdown-name">${wallet.nickname}</div>
                                <div class="master-key-dropdown-meta">${isDiscovering ? 'Scanning...' : `Last used: ${createdDate}`}</div>
                            </div>
                            ${statusIcon}
                        </div>
                    </div>
                `;
            }
        }

        walletList.innerHTML = html;
        attachDropdownListeners();
    } catch (error) {
        console.error('[Wallet Management] Error populating dropdown:', error);
        walletList.innerHTML = '<div class="error-wallets">Error loading wallets</div>';
    }
}

/**
 * Attach listeners to hierarchical dropdown items
 */
function attachDropdownListeners(): void {
    // Master wallet header click to switch to master (index 0)
    document.querySelectorAll('.master-key-dropdown-header[data-sub-index="0"]').forEach(header => {
        header.addEventListener('click', async (e) => {
            const target = e.currentTarget as HTMLElement;
            const masterId = target.getAttribute('data-master-id');

            if (masterId) {
                await handleHierarchicalWalletSwitch(masterId, 0);
            }
        });
    });

    // Sub-wallet click to switch
    document.querySelectorAll('.sub-wallet-dropdown-item').forEach(item => {
        item.addEventListener('click', async (e) => {
            const target = e.currentTarget as HTMLElement;
            const masterId = target.getAttribute('data-master-id');
            const subIndex = parseInt(target.getAttribute('data-sub-index') || '0', 10);

            if (masterId) {
                await handleHierarchicalWalletSwitch(masterId, subIndex);
            }
        });
    });
}

/**
 * Handle switching to a specific sub-wallet
 * Prompts for PIN if switching to a different master wallet
 */
async function handleHierarchicalWalletSwitch(masterKeyId: string, subWalletIndex: number): Promise<void> {
    console.log('[Wallet Management] Switching to wallet:', { masterKeyId, subWalletIndex });
    
    try {
        // Close dropdown
        const walletDropdown = document.getElementById('wallet-dropdown');
        const currentWalletBtn = document.getElementById('current-wallet-btn');
        if (walletDropdown) walletDropdown.classList.add('hidden');
        if (currentWalletBtn) currentWalletBtn.classList.remove('open');
        setIsWalletSelectorOpen(false);

        // Get current active wallet from storage to determine if we're switching master wallets
        const storageResult = await chrome.storage.local.get(['multiWalletData']);
        let currentActiveMasterKeyId = '';
        
        if (storageResult.multiWalletData) {
            const data = JSON.parse(storageResult.multiWalletData);
            currentActiveMasterKeyId = data.activeWalletId || '';
        }

        // Check if switching to a different master wallet (different PIN required)
        const isDifferentMasterWallet = currentActiveMasterKeyId !== masterKeyId;
        let pin: string | null;

        if (isDifferentMasterWallet) {
            // Switching to a different master wallet - need to prompt for its PIN
            console.log('[Wallet Management] Different master wallet - prompting for PIN');
            
            pin = await promptForPIN('Enter PIN for the wallet you\'re switching to:');
            if (!pin) {
                console.log('[Wallet Management] PIN prompt cancelled');
                return; // User cancelled
            }
        } else {
            // Switching sub-wallet within same master wallet - use session PIN
            console.log('[Wallet Management] Same master wallet - using session PIN');
            pin = sessionPin;
            if (!pin) {
                showError('Session expired. Please unlock again.');
                return;
            }
        }

        // Switch to the hierarchical wallet
        const response = await ExtensionMessaging.switchHierarchicalWallet(masterKeyId, subWalletIndex, pin);
        
        if (response.success && response.data) {
            // Update local state
            setActiveMasterKeyId(masterKeyId);
            setActiveSubWalletIndex(subWalletIndex);

            // Update session PIN if we switched to a different master wallet
            if (isDifferentMasterWallet && pin) {
                setSessionPin(pin);
                await chrome.storage.session.set({ walletSessionPin: pin, walletSessionMasterKeyId: masterKeyId });
                console.log('[Wallet Management] Updated session PIN for new master wallet');
            }

            // Dispatch custom event for popup.ts to handle SDK reconnection
            const event = new CustomEvent('hierarchical-wallet-switched', {
                detail: {
                    masterKeyId: masterKeyId,
                    subWalletIndex: subWalletIndex,
                    masterKeyNickname: response.data.masterKeyNickname,
                    subWalletNickname: response.data.subWalletNickname
                }
            });
            window.dispatchEvent(event);

            // Show success notification
            const displayName = subWalletIndex === 0 
                ? response.data.masterKeyNickname 
                : response.data.subWalletNickname;
            if (displayName) {
                showSuccess(`Switched to ${displayName}`);
            }

            // Refresh UI
            await initializeMultiWalletUI();
        } else {
            // Provide user-friendly error message for common cases
            const errorMsg = response.error || 'Failed to switch wallet';
            if (errorMsg.includes('decrypt') || errorMsg.includes('mnemonic')) {
                showError('Incorrect PIN. Please try again.');
            } else {
                showError(errorMsg);
            }
        }
    } catch (error) {
        console.error('[Wallet Management] Switch error:', error);
        showError('Failed to switch wallet');
    }
}

/**
 * Setup wallet selector event listeners
 */
export function setupWalletSelectorListeners(): void {
    const currentWalletBtn = document.getElementById('current-wallet-btn');
    const addWalletBtn = document.getElementById('add-wallet-btn');
    const manageWalletsBtn = document.getElementById('manage-wallets-btn');
    const walletDropdown = document.getElementById('wallet-dropdown');
    const walletSelector = document.getElementById('wallet-selector');

    // Toggle dropdown
    if (currentWalletBtn) {
        currentWalletBtn.onclick = () => {
            setIsWalletSelectorOpen(!isWalletSelectorOpen);
            currentWalletBtn.classList.toggle('open', isWalletSelectorOpen);
            walletDropdown?.classList.toggle('hidden', !isWalletSelectorOpen);
        };
    }

    // Add wallet
    if (addWalletBtn) {
        addWalletBtn.onclick = () => {
            showAddWalletFlow();
        };
    }

    // Manage wallets
    if (manageWalletsBtn) {
        manageWalletsBtn.onclick = async () => {
            // Close the dropdown first
            setIsWalletSelectorOpen(false);
            currentWalletBtn?.classList.remove('open');
            walletDropdown?.classList.add('hidden');

            // Show in-popup wallet management interface
            await showWalletManagementInterface();
        };
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (walletSelector && !walletSelector.contains(e.target as Node) && isWalletSelectorOpen) {
            setIsWalletSelectorOpen(false);
            currentWalletBtn?.classList.remove('open');
            walletDropdown?.classList.add('hidden');
        }
    });
}

/**
 * Handle wallet switch
 */
export async function handleWalletSwitch(walletId: string): Promise<void> {
    try {
        console.log(`[Multi-Wallet] Switching to wallet: ${walletId}`);

        // Close dropdown
        const walletDropdown = document.getElementById('wallet-dropdown');
        walletDropdown?.classList.add('hidden');
        setIsWalletSelectorOpen(false);

        // Show switching indicator
        showWalletSwitchingIndicator(true);

        // Try with current session PIN first
        let pin = sessionPin || '';

        if (!pin) {
            // No session PIN - prompt for PIN
            showWalletSwitchingIndicator(false);
            pin = await promptForWalletPin(walletId);
            if (!pin) {
                return; // User cancelled
            }
            showWalletSwitchingIndicator(true);
        }

        // Clear cached balance before switching wallets
        await chrome.storage.local.remove(['cachedBalance']);
        console.log('🔄 [Multi-Wallet] Cleared global balance cache before switch');

        // Disconnect current SDK
        if (breezSDK) {
            console.log('[Multi-Wallet] Disconnecting current SDK');
            await breezSDK.disconnect();
            setBreezSDK(null);
        }

        // Try to switch wallet with current PIN
        let switchResponse = await ExtensionMessaging.switchWallet(walletId, pin);

        // If PIN doesn't match (decryption fails), prompt for the correct PIN
        if (!switchResponse.success && 
            (switchResponse.error?.includes('decrypt') || 
             switchResponse.error?.includes('Invalid PIN') ||
             switchResponse.error?.includes('Failed to load wallet'))) {
            console.log('[Multi-Wallet] PIN mismatch - prompting for wallet PIN');
            showWalletSwitchingIndicator(false);

            const walletName = currentWallets.find(w => w.id === walletId)?.nickname || 'this wallet';
            showInfo(`Current PIN is invalid for ${walletName}. Please enter the correct PIN.`);

            pin = await promptForWalletPin(walletId);
            if (!pin) {
                return; // User cancelled
            }

            showWalletSwitchingIndicator(true);
            switchResponse = await ExtensionMessaging.switchWallet(walletId, pin);
        }

        if (!switchResponse.success || !switchResponse.data) {
            // Check if this is a PIN-related error and show a clearer message
            const errorMsg = switchResponse.error || 'Wallet switch failed';
            if (errorMsg.includes('decrypt') || errorMsg.includes('Failed to load wallet')) {
                throw new Error('Incorrect PIN. Please try again.');
            }
            throw new Error(errorMsg);
        }

        // Update session PIN to the new wallet's PIN
        setSessionPin(pin);
        await chrome.storage.session.set({ walletSessionPin: pin, walletSessionMasterKeyId: walletId });
        console.log('🔐 [Multi-Wallet] Updated session PIN for new wallet');

        // Clear old wallet data BEFORE connecting to new wallet
        clearWalletDisplay();
        showTransactionsLoading();

        // Connect new SDK and store in state
        console.log('[Multi-Wallet] Connecting to new wallet SDK');
        const sdk = await connectBreezSDK(switchResponse.data.mnemonic);
        setBreezSDK(sdk); // Store in shared state

        // Query fresh balance from SDK
        await callbacks?.updateBalanceDisplay();
        console.log('🔄 [Multi-Wallet] Queried fresh balance from new wallet SDK');

        showInfo('Syncing wallet data...');

        // Update UI
        await initializeMultiWalletUI();

        showSuccess('Switched to ' + currentWallets.find(w => w.id === walletId)?.nickname);
        showWalletSwitchingIndicator(false);

    } catch (error) {
        console.error('[Multi-Wallet] Wallet switch failed:', error);
        showError('Failed to switch wallet: ' + (error instanceof Error ? error.message : 'Unknown error'));
        showWalletSwitchingIndicator(false);
    }
}

/**
 * Prompt user for wallet PIN
 */
async function promptForWalletPin(walletId: string): Promise<string> {
    const walletName = currentWallets.find(w => w.id === walletId)?.nickname || 'wallet';
    const pin = await promptForPIN(`Enter PIN for ${walletName}`);
    return pin || '';
}

/**
 * Show/hide wallet switching indicator
 */
export function showWalletSwitchingIndicator(show: boolean): void {
    let overlay = document.getElementById('wallet-switching-overlay');

    if (show && !overlay) {
        overlay = document.createElement('div');
        overlay.id = 'wallet-switching-overlay';
        overlay.className = 'wallet-switching-overlay';
        overlay.innerHTML = `
      <div class="switching-spinner"></div>
      <div class="switching-text">Switching wallet...</div>
    `;
        document.body.appendChild(overlay);
    } else if (!show && overlay) {
        overlay.remove();
    }
}

// ========================================
// Wallet Management Interface
// ========================================

/**
 * Show wallet management interface (in-popup)
 */
export async function showWalletManagementInterface(): Promise<void> {
    console.log('[Wallet Management] Showing management interface');

    // Hide main interface
    const mainInterface = document.getElementById('main-interface');
    if (mainInterface) {
        mainInterface.classList.add('hidden');
    }

    // Show wallet management interface
    const managementInterface = document.getElementById('wallet-management-interface');
    if (managementInterface) {
        managementInterface.classList.remove('hidden');
    }

    // Load and display wallets
    await loadWalletManagementList();

    // Setup back button
    const backBtn = document.getElementById('wallet-mgmt-back-btn');
    if (backBtn) {
        backBtn.onclick = () => {
            hideWalletManagementInterface();
        };
    }

    // Setup add wallet button
    const addBtn = document.getElementById('wallet-mgmt-add-btn');
    if (addBtn) {
        addBtn.onclick = () => {
            console.log('[Wallet Management] Add wallet button clicked');
            showAddWalletFlow();
        };
    }

    // Setup view archived wallets button
    const viewArchivedBtn = document.getElementById('view-archived-wallets-btn');
    if (viewArchivedBtn) {
        viewArchivedBtn.onclick = () => {
            console.log('[Wallet Management] View archived wallets button clicked');
            showArchivedWalletsInterface();
        };
    }
}

/**
 * Hide wallet management interface and optionally return to main interface
 * @param showMain - If true (default), shows the main interface after hiding management
 */
export function hideWalletManagementInterface(showMain: boolean = true): void {
    console.log('[Wallet Management] Hiding management interface');

    const managementInterface = document.getElementById('wallet-management-interface');
    if (managementInterface) {
        managementInterface.classList.add('hidden');
    }

    if (showMain) {
        const mainInterface = document.getElementById('main-interface');
        if (mainInterface) {
            mainInterface.classList.remove('hidden');
        }
    }
}

/**
 * Load and display wallet list in management interface
 * Always uses hierarchical view (master keys with sub-wallets)
 */
export async function loadWalletManagementList(): Promise<void> {
    try {
        console.log('[Wallet Management] Loading wallet list (hierarchical)');

        // Always use hierarchical mode - all wallets are master keys with sub-wallets
        setIsHierarchicalMode(true);
        await loadHierarchicalWalletList();

    } catch (error) {
        console.error('[Wallet Management] Failed to load wallet list:', error);
        showError('Failed to load wallets');
    }
}

/**
 * Load hierarchical wallet list (v2 mode - master keys with sub-wallets)
 */
async function loadHierarchicalWalletList(): Promise<void> {
    const masterKeysResponse = await ExtensionMessaging.getMasterKeyMetadata();
    if (!masterKeysResponse.success || !masterKeysResponse.data) {
        showError('Failed to load master keys');
        return;
    }

    const masterKeyList: MasterKeyMetadata[] = masterKeysResponse.data;
    setMasterKeys(masterKeyList);
    console.log(`[Wallet Management] Loaded ${masterKeyList.length} master key(s) (v2 hierarchical mode)`);

    // Get active wallet info
    const activeData = await chrome.storage.local.get(['multiWalletData']);
    let currentActiveMasterKeyId = '';
    let currentActiveSubWalletIndex = 0;

    if (activeData.multiWalletData) {
        try {
            const data = JSON.parse(activeData.multiWalletData);
            currentActiveMasterKeyId = data.activeWalletId || ''; // Fixed: use activeWalletId not activeMasterKeyId
            currentActiveSubWalletIndex = data.activeSubWalletIndex || 0;
        } catch (e) {
            console.error('[Wallet Management] Failed to parse active wallet data');
        }
    }

    setActiveMasterKeyId(currentActiveMasterKeyId);
    setActiveSubWalletIndex(currentActiveSubWalletIndex);

    const listContainer = document.getElementById('wallet-management-list');
    if (!listContainer) {
        console.error('[Wallet Management] List container not found');
        return;
    }

    if (masterKeyList.length === 0) {
        listContainer.innerHTML = '<div class="no-transactions" style="padding: 40px 20px;">No wallets found</div>';
        return;
    }

    // Check if current active wallet has transactions OR balance (for add sub-wallet button)
    let activeWalletHasTransactions = false;
    if (breezSDK) {
        try {
            const [paymentsResponse, info] = await Promise.all([
                breezSDK.listPayments({}).catch(() => ({ payments: [] })),
                breezSDK.getInfo({ ensureSynced: false }).catch(() => ({ balanceSats: 0 }))
            ]);
            
            const paymentCount = paymentsResponse?.payments?.length || 0;
            const balance = info?.balanceSats || 0;
            
            activeWalletHasTransactions = paymentCount > 0 || balance > 0;
            console.log(`[Wallet Management] Active wallet (master: ${currentActiveMasterKeyId}, index: ${currentActiveSubWalletIndex}): ${paymentCount} txs, ${balance} sats. Has usage: ${activeWalletHasTransactions}`);
        } catch (error) {
            console.warn('[Wallet Management] Could not check usage:', error);
            activeWalletHasTransactions = false;
        }
    }

    // Build hierarchical HTML
    let html = '';

    for (const mk of masterKeyList) {
        const isActiveMasterKey = mk.id === currentActiveMasterKeyId;
        const isExpanded = true; // Always expanded by default
        const canDeleteMasterKey = masterKeyList.length > 1;
        const createdDate = new Date(mk.createdAt).toLocaleDateString();

        // Fetch sub-wallets including archived to check if the LAST one has been used
        const subWalletsResponseAll = await ExtensionMessaging.getSubWallets(mk.id, true); // includeArchived = true
        const allSubWallets: SubWalletEntry[] = subWalletsResponseAll.success && subWalletsResponseAll.data
            ? subWalletsResponseAll.data
            : [];
        
        // Also get non-archived for display
        const subWallets = allSubWallets.filter(sw => !sw.archivedAt);

        // Check if we can add a sub-wallet based on the LAST created sub-wallet's usage
        let canAddSubWallet = false;
        let addSubWalletDisabledReason = '';

        if (allSubWallets.length === 0) {
            // No sub-wallets exist yet - first sub-wallet is always allowed
            canAddSubWallet = true;
        } else {
            // Find the last sub-wallet by highest index
            const lastSubWallet = allSubWallets.reduce((max, sw) =>
                sw.index > max.index ? sw : max
            );

            const lastName = lastSubWallet.index === 0
                ? mk.nickname
                : lastSubWallet.nickname || `Sub-wallet ${lastSubWallet.index}`;

            // Check if we're connected to this exact last sub-wallet (can verify via SDK)
            const isConnectedToLastSubWallet = isActiveMasterKey && currentActiveSubWalletIndex === lastSubWallet.index;

            if (isConnectedToLastSubWallet) {
                // We're connected to this exact sub-wallet - use SDK to verify
                // Also persist the result to hasActivity so it works when wallet is unselected
                if (activeWalletHasTransactions) {
                    canAddSubWallet = true;
                    // Persist hasActivity = true
                    ExtensionMessaging.updateSubWalletActivity(mk.id, lastSubWallet.index, true).catch(e => 
                        console.warn('[Wallet Management] Failed to persist hasActivity:', e)
                    );
                } else {
                    addSubWalletDisabledReason = `${lastName} must have transactions before adding another`;
                    // Persist hasActivity = false
                    ExtensionMessaging.updateSubWalletActivity(mk.id, lastSubWallet.index, false).catch(e => 
                        console.warn('[Wallet Management] Failed to persist hasActivity:', e)
                    );
                }
            } else {
                // Not connected to this sub-wallet - use stored hasActivity flag
                // Only allow if hasActivity is explicitly true, OR if on same master key (optimistic)
                if (lastSubWallet.hasActivity === true) {
                    canAddSubWallet = true;
                } else if (isActiveMasterKey) {
                    // On same master key but not connected to last sub-wallet - be optimistic
                    canAddSubWallet = true;
                } else {
                    // Different master key and hasActivity is false or undefined
                    addSubWalletDisabledReason = `${lastName} must have transactions before adding another`;
                }
            }
        }

        // Check if this wallet is currently being discovered
        const isDiscovering = walletsBeingDiscovered.has(mk.id);

        html += `
            <div class="master-key-item ${isExpanded ? 'expanded' : 'collapsed'}"
                 data-master-id="${mk.id}">
                <div class="master-key-header" data-master-id="${mk.id}">
                    <span class="master-key-icon">🔑</span>
                    <span class="master-key-name">${mk.nickname}</span>
                    <span class="sub-wallet-count">(${mk.subWalletCount})</span>
                    <span class="expand-icon">${isExpanded ? '▼' : '▶'}</span>
                </div>
                ${isDiscovering ? `
                    <div class="discovery-indicator" data-master-id="${mk.id}">
                        <span class="discovery-spinner">⏳</span>
                        <span class="discovery-status">Scanning for sub-wallets...</span>
                        <span class="discovery-count hidden"></span>
                    </div>
                ` : ''}
                <div class="master-key-meta">Created: ${createdDate}</div>
                <div class="master-key-actions">
                    <button class="wallet-mgmt-btn rename-master-btn"
                            data-master-id="${mk.id}"
                            data-master-name="${mk.nickname}">
                        Rename
                    </button>
                    <button class="wallet-mgmt-btn archive-master-btn"
                            data-master-id="${mk.id}"
                            data-master-name="${mk.nickname}"
                            ${!canDeleteMasterKey ? 'disabled' : ''}>
                        Archive
                    </button>
                    <button class="wallet-mgmt-btn delete-master-btn"
                            data-master-id="${mk.id}"
                            ${!canDeleteMasterKey ? 'disabled' : ''}>
                        Delete
                    </button>
                </div>
                <div class="master-key-actions">
                    <button class="wallet-mgmt-btn reveal-seed-btn"
                            data-master-id="${mk.id}"
                            data-master-name="${mk.nickname}">
                        🔑 Reveal Seed Phrase
                    </button>
                </div>
                <div class="master-key-actions">
                    <button class="wallet-mgmt-btn add-sub-wallet-btn"
                            data-master-id="${mk.id}"
                            ${!canAddSubWallet ? 'disabled' : ''}
                            ${addSubWalletDisabledReason ? `title="${addSubWalletDisabledReason}"` : ''}>
                        + Add Sub-Wallet
                    </button>
                </div>

                <div class="sub-wallet-list ${isExpanded ? '' : 'hidden'}">
                    ${subWallets.map(sw => {
                        const isActiveSubWallet = isActiveMasterKey && sw.index === currentActiveSubWalletIndex;

                        return `
                            <div class="sub-wallet-item"
                                 data-master-id="${mk.id}"
                                 data-sub-index="${sw.index}">
                                <div class="sub-wallet-header">
                                    <span class="sub-wallet-icon">💼</span>
                                    <span class="sub-wallet-name">${sw.nickname}</span>
                                </div>
                                <div class="sub-wallet-actions">
                                    <button class="wallet-mgmt-btn rename-sub-btn"
                                            data-master-id="${mk.id}"
                                            data-sub-index="${sw.index}"
                                            data-sub-name="${sw.nickname}">
                                        Rename
                                    </button>
                                    <button class="wallet-mgmt-btn archive-sub-btn"
                                            data-master-id="${mk.id}"
                                            data-sub-index="${sw.index}"
                                            data-sub-name="${sw.nickname}">
                                        Archive
                                    </button>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }

    listContainer.innerHTML = html;
    attachHierarchicalWalletListeners();
}

/**
 * Attach event listeners for hierarchical wallet management
 */
function attachHierarchicalWalletListeners(): void {
    // Master key expand/collapse
    document.querySelectorAll('.master-key-header').forEach(header => {
        header.addEventListener('click', (e) => {
            const target = e.currentTarget as HTMLElement;
            const masterId = target.getAttribute('data-master-id');
            if (masterId) {
                handleToggleMasterKeyExpand(masterId);
            }
        });
    });

    // Rename master key
    document.querySelectorAll('.rename-master-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const target = e.target as HTMLElement;
            const masterId = target.getAttribute('data-master-id');
            const currentName = target.getAttribute('data-master-name');
            if (masterId && currentName) {
                await handleRenameMasterKey(masterId, currentName);
            }
        });
    });

    // Reveal seed phrase
    document.querySelectorAll('.reveal-seed-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const target = e.target as HTMLElement;
            const masterId = target.getAttribute('data-master-id');
            const masterName = target.getAttribute('data-master-name');
            if (masterId && masterName) {
                await handleRevealSeedPhrase(masterId, masterName);
            }
        });
    });

    // Archive master key
    document.querySelectorAll('.archive-master-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const target = e.target as HTMLElement;
            const masterId = target.getAttribute('data-master-id');
            const masterName = target.getAttribute('data-master-name');
            if (masterId && masterName) {
                await handleArchiveMasterKey(masterId, masterName);
            }
        });
    });

    // Delete master key
    document.querySelectorAll('.delete-master-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const target = e.target as HTMLElement;
            const masterId = target.getAttribute('data-master-id');
            if (masterId) {
                await handleDeleteMasterKey(masterId);
            }
        });
    });

    // Add sub-wallet
    document.querySelectorAll('.add-sub-wallet-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const target = e.target as HTMLElement;
            const masterId = target.getAttribute('data-master-id');
            if (masterId) {
                await handleAddSubWallet(masterId);
            }
        });
    });

    // Rename sub-wallet
    document.querySelectorAll('.rename-sub-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const target = e.target as HTMLElement;
            const masterId = target.getAttribute('data-master-id');
            const subIndex = target.getAttribute('data-sub-index');
            const currentName = target.getAttribute('data-sub-name');
            if (masterId && subIndex && currentName) {
                await handleRenameSubWallet(masterId, parseInt(subIndex, 10), currentName);
            }
        });
    });

    // Archive sub-wallet
    document.querySelectorAll('.archive-sub-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const target = e.target as HTMLElement;
            const masterId = target.getAttribute('data-master-id');
            const subIndex = target.getAttribute('data-sub-index');
            const subName = target.getAttribute('data-sub-name');
            if (masterId && subIndex && subName) {
                await handleArchiveSubWallet(masterId, parseInt(subIndex, 10), subName);
            }
        });
    });
}

// ========================================
// Hierarchical Wallet Operations
// ========================================

/**
 * Toggle master key expand/collapse state
 */
function handleToggleMasterKeyExpand(masterId: string): void {
    console.log(`[Wallet Management] Toggling master key expansion: ${masterId}`);

    toggleMasterKeyExpandedState(masterId);

    // Update UI
    const masterKeyItem = document.querySelector(`.master-key-item[data-master-id="${masterId}"]`);
    const subWalletList = masterKeyItem?.querySelector('.sub-wallet-list');
    const expandIcon = masterKeyItem?.querySelector('.expand-icon');

    if (masterKeyItem && subWalletList && expandIcon) {
        const isNowExpanded = expandedMasterKeys.has(masterId);
        masterKeyItem.classList.toggle('expanded', isNowExpanded);
        masterKeyItem.classList.toggle('collapsed', !isNowExpanded);
        subWalletList.classList.toggle('hidden', !isNowExpanded);
        expandIcon.textContent = isNowExpanded ? '▼' : '▶';
    }

    // Persist expansion state
    ExtensionMessaging.toggleMasterKeyExpanded(masterId).catch(console.error);
}

/**
 * Handle rename master key
 */
async function handleRenameMasterKey(masterId: string, currentName: string): Promise<void> {
    try {
        console.log(`[Wallet Management] Renaming master key ${masterId}`);

        // Store context for rename
        setRenameWalletId(`master:${masterId}`);
        setRenameWalletCurrentName(currentName);

        showRenameInterface(currentName);
    } catch (error) {
        console.error('[Wallet Management] Failed to show rename interface:', error);
        showError('Failed to open rename screen');
    }
}

/**
 * Handle reveal seed phrase for master key
 */
async function handleRevealSeedPhrase(masterId: string, masterName: string): Promise<void> {
    try {
        console.log(`[Wallet Management] Revealing seed phrase for master key ${masterId}`);

        // Request PIN for security
        const pin = await promptForPIN(`Enter PIN for "${masterName}" to reveal seed phrase`);
        if (!pin) {
            console.log('[Wallet Management] PIN prompt cancelled');
            return; // User cancelled
        }

        // Fetch the master mnemonic (not derived, just the original 12 words)
        const response = await ExtensionMessaging.getMasterMnemonic(masterId, pin);
        
        if (!response.success || !response.data) {
            if (response.error?.includes('decrypt') || response.error?.includes('PIN')) {
                showError('Incorrect PIN. Please try again.');
            } else {
                showError(response.error || 'Failed to retrieve seed phrase');
            }
            return;
        }

        const mnemonic = response.data.mnemonic;
        
        // Display seed phrase in modal
        showSeedPhraseModal(mnemonic, masterName);

    } catch (error) {
        console.error('[Wallet Management] Failed to reveal seed phrase:', error);
        showError('Failed to reveal seed phrase: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
}

/**
 * Show seed phrase modal with copy functionality
 */
function showSeedPhraseModal(mnemonic: string, walletName: string): void {
    // Remove existing modal if any
    const existingModal = document.getElementById('seed-phrase-reveal-modal');
    if (existingModal) existingModal.remove();

    const modal = document.createElement('div');
    modal.id = 'seed-phrase-reveal-modal';
    modal.className = 'modal-overlay';
    
    const words = mnemonic.split(' ');
    const mnemonicGrid = words.map((word, index) => `
        <div class="mnemonic-word">
            <span class="word-number">${index + 1}</span>
            <span class="word-text">${word}</span>
        </div>
    `).join('');

    modal.innerHTML = `
        <div class="modal">
            <div class="modal-header">
                <h3>🔑 Seed Phrase for "${walletName}"</h3>
                <button class="modal-close" id="seed-phrase-modal-close">×</button>
            </div>
            <div class="modal-body">
                <div class="warning-box" style="margin-bottom: 16px;">
                    <strong>⚠️ Security Warning:</strong> Never share your seed phrase with anyone. Anyone with these words can access your funds.
                </div>
                <div class="mnemonic-grid">${mnemonicGrid}</div>
                <button id="copy-seed-phrase-btn" class="btn-outline" style="width: 100%; margin-top: 16px;">
                    📋 Copy to Clipboard
                </button>
            </div>
            <div class="modal-footer">
                <button id="seed-phrase-close-btn" class="btn-primary" style="width: 100%;">Close</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Event listeners
    const closeModal = () => modal.remove();
    
    document.getElementById('seed-phrase-modal-close')?.addEventListener('click', closeModal);
    document.getElementById('seed-phrase-close-btn')?.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // Copy button
    document.getElementById('copy-seed-phrase-btn')?.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(mnemonic);
            showSuccess('Seed phrase copied to clipboard');
            
            // Change button text temporarily
            const btn = document.getElementById('copy-seed-phrase-btn');
            if (btn) {
                const originalText = btn.textContent;
                btn.textContent = '✓ Copied!';
                setTimeout(() => {
                    btn.textContent = originalText;
                }, 2000);
            }
        } catch (error) {
            console.error('[Wallet Management] Failed to copy:', error);
            showError('Failed to copy to clipboard');
        }
    });
}

/**
 * Handle delete master key
 */
async function handleDeleteMasterKey(masterId: string): Promise<void> {
    try {
        console.log(`[Wallet Management] Deleting master key ${masterId}`);

        // Get wallet info for confirmation message
        const masterKeys = await ExtensionMessaging.getMasterKeyMetadata();
        if (!masterKeys.success || !masterKeys.data) {
            showError('Failed to load wallet information');
            return;
        }

        const masterKey = masterKeys.data.find(mk => mk.id === masterId);
        const masterName = masterKey?.nickname || 'this master key';
        const subWalletCount = masterKey?.subWalletCount || 0;

        const message = subWalletCount > 0
            ? `Enter PIN to delete "${masterName}" and ${subWalletCount} sub-wallet(s)`
            : `Enter PIN to delete "${masterName}"`;

        // Request PIN to confirm deletion
        const pin = await showPINModal(message);
        if (!pin) return;

        // Verify PIN is correct by trying to decrypt the wallet
        const verifyResponse = await ExtensionMessaging.getHierarchicalWalletMnemonic(masterId, 0, pin);
        if (!verifyResponse.success) {
            showError('Incorrect PIN');
            return;
        }

        const response = await ExtensionMessaging.removeMasterKey(masterId, pin);
        if (response.success) {
            showSuccess(`Wallet "${masterName}" deleted successfully!`);

            // Stay on the Manage Wallets page and refresh the list
            await loadWalletManagementList();
        } else {
            showError(response.error || 'Failed to delete wallet');
        }
    } catch (error) {
        console.error('[Wallet Management] Delete master key failed:', error);
        showError('Failed to delete wallet');
    }
}

/**
 * Handle add sub-wallet to a master key
 */
async function handleAddSubWallet(masterId: string): Promise<void> {
    try {
        console.log(`[Wallet Management] Adding sub-wallet to master key ${masterId}`);

        // Get ALL sub-wallets (including archived) to determine the next index
        // This ensures archived wallets keep their indices reserved
        const response = await ExtensionMessaging.getSubWallets(masterId, true);
        if (!response.success || !response.data) {
            showError('Failed to load sub-wallets');
            return;
        }

        const allSubWallets = response.data;
        const nextIndex = allSubWallets.length + 1;
        const defaultName = `Sub-wallet ${nextIndex}`;

        // Prompt for wallet name using modal
        const walletName = await promptForText(
            'Enter a name for the new sub-wallet:',
            defaultName,
            'e.g., Savings, Trading'
        );

        if (!walletName) {
            return; // User cancelled
        }

        // Add the sub-wallet
        const addResponse = await ExtensionMessaging.addSubWallet(masterId, walletName.trim());
        if (addResponse.success && addResponse.data) {
            const newSubWalletIndex = addResponse.data; // The newly created sub-wallet index
            
            // Switch to the newly created sub-wallet
            if (sessionPin) {
                const switchResponse = await ExtensionMessaging.switchHierarchicalWallet(
                    masterId,
                    newSubWalletIndex,
                    sessionPin
                );

                if (switchResponse.success && switchResponse.data) {
                    // Update state
                    setActiveMasterKeyId(masterId);
                    setActiveSubWalletIndex(newSubWalletIndex);
                    
                    // Dispatch event for popup.ts to handle SDK reconnection + balance refresh
                    const event = new CustomEvent('hierarchical-wallet-switched', {
                        detail: {
                            mnemonic: switchResponse.data.mnemonic,
                            masterKeyId: masterId,
                            subWalletIndex: newSubWalletIndex,
                            masterKeyNickname: switchResponse.data.masterKeyNickname,
                            subWalletNickname: walletName.trim() // Use the wallet name we just created
                        }
                    });
                    window.dispatchEvent(event);
                    
                    // Refresh UI lists BEFORE clicking back to avoid duplicate events
                    await loadWalletManagementList();
                    await populateWalletDropdown();
                    await updateWalletSelectorUI();
                    
                    // Close wallet management - simulate back button click
                    const backBtn = document.getElementById('wallet-mgmt-back-btn');
                    if (backBtn) {
                        backBtn.click();
                    }
                    
                    // Show success notification AFTER everything is done
                    showSuccess(`Switched to ${walletName.trim()}`);
                } else {
                    console.warn('[Wallet Management] Could not switch to new sub-wallet:', switchResponse.error);
                    // Only update lists if switch failed
                    await loadWalletManagementList();
                    await populateWalletDropdown();
                }
            } else {
                // No session PIN, just update the lists
                await loadWalletManagementList();
                await populateWalletDropdown();
            }
        } else {
            showError(addResponse.error || 'Failed to create sub-wallet');
        }
    } catch (error) {
        console.error('[Wallet Management] Add sub-wallet failed:', error);
        showError('Failed to create sub-wallet');
    }
}

/**
 * Handle rename sub-wallet
 */
async function handleRenameSubWallet(masterId: string, subIndex: number, currentName: string): Promise<void> {
    try {
        console.log(`[Wallet Management] Renaming sub-wallet ${masterId}:${subIndex}`);

        // Store context for rename
        setRenameWalletId(`sub:${masterId}:${subIndex}`);
        setRenameWalletCurrentName(currentName);

        showRenameInterface(currentName);
    } catch (error) {
        console.error('[Wallet Management] Failed to show rename interface:', error);
        showError('Failed to open rename screen');
    }
}

/**
 * Handle archive sub-wallet
 * Archives the sub-wallet without requiring PIN
 */
async function handleArchiveSubWallet(masterId: string, subIndex: number, subName: string): Promise<void> {
    try {
        console.log(`[Wallet Management] Archiving sub-wallet ${masterId}:${subIndex}`);

        // Show confirmation modal
        const confirmed = await showArchiveConfirmation(subName);
        if (!confirmed) {
            console.log('[Wallet Management] Archive cancelled by user');
            return;
        }

        const response = await ExtensionMessaging.archiveSubWallet(masterId, subIndex);
        if (response.success) {
            showSuccess(`"${subName}" has been archived`);
            await loadWalletManagementList();
            await initializeMultiWalletUI();
        } else {
            showError(response.error || 'Failed to archive sub-wallet');
        }
    } catch (error) {
        console.error('[Wallet Management] Archive sub-wallet failed:', error);
        showError('Failed to archive sub-wallet');
    }
}

/**
 * Handle selecting/switching to a sub-wallet
 * This triggers SDK reconnection with the derived mnemonic
 */
async function handleSelectSubWallet(masterId: string, subIndex: number): Promise<void> {
    try {
        console.log(`[Wallet Management] Switching to sub-wallet ${masterId}:${subIndex}`);

        // Check if already active
        if (activeMasterKeyId === masterId && activeSubWalletIndex === subIndex) {
            console.log('[Wallet Management] Already active, skipping switch');
            return;
        }

        // Request PIN for switching (needed to derive mnemonic)
        const pin = sessionPin || await showPINModal('Enter your PIN to switch wallet');
        if (!pin) return;

        // Switch wallet via background (this derives the sub-wallet mnemonic)
        const response = await ExtensionMessaging.switchHierarchicalWallet(masterId, subIndex, pin);

        if (response.success && response.data) {
            // Update local state
            setActiveMasterKeyId(masterId);
            setActiveSubWalletIndex(subIndex);

            // The popup will need to reconnect SDK with the new mnemonic
            // Dispatch custom event for popup.ts to handle SDK reconnection
            const event = new CustomEvent('hierarchical-wallet-switched', {
                detail: {
                    mnemonic: response.data.mnemonic,
                    masterKeyId: masterId,
                    subWalletIndex: subIndex,
                    masterKeyNickname: response.data.masterKeyNickname,
                    subWalletNickname: response.data.subWalletNickname
                }
            });
            window.dispatchEvent(event);

            // Show success notification
            if (response.data.subWalletNickname) {
                showSuccess(`Switched to ${response.data.subWalletNickname}`);
            }

            // Refresh the wallet list UI
            await loadWalletManagementList();
            await initializeMultiWalletUI();
        } else {
            showError(response.error || 'Failed to switch wallet');
        }
    } catch (error) {
        console.error('[Wallet Management] Switch sub-wallet failed:', error);
        showError('Failed to switch wallet');
    }
}

/**
 * Attach event listeners to wallet management buttons
 */
export function attachWalletManagementListeners(): void {
    const renameButtons = document.querySelectorAll('.wallet-mgmt-btn.rename-btn');
    renameButtons.forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const target = e.target as HTMLElement;
            const walletId = target.getAttribute('data-wallet-id');
            const currentName = target.getAttribute('data-wallet-name');

            if (walletId && currentName) {
                await handleRenameWallet(walletId, currentName);
            }
        });
    });

    const deleteButtons = document.querySelectorAll('.wallet-mgmt-btn.delete-btn');
    deleteButtons.forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const target = e.target as HTMLElement;
            const walletId = target.getAttribute('data-wallet-id');

            if (walletId) {
                await handleDeleteWallet(walletId);
            }
        });
    });
}

// ========================================
// Rename Wallet
// ========================================

/**
 * Handle rename wallet action - show full-screen rename interface
 */
export async function handleRenameWallet(walletId: string, currentName: string): Promise<void> {
    try {
        console.log(`[Wallet Management] Renaming wallet ${walletId}`);

        setRenameWalletId(walletId);
        setRenameWalletCurrentName(currentName);

        showRenameInterface(currentName);
    } catch (error) {
        console.error('[Wallet Management] Failed to show rename interface:', error);
        showError('Failed to open rename screen');
    }
}

/**
 * Show rename wallet full-screen interface
 */
export function showRenameInterface(currentName: string): void {
    console.log('[Rename] Showing rename interface');

    const managementInterface = document.getElementById('wallet-management-interface');
    if (managementInterface) {
        managementInterface.classList.add('hidden');
    }

    const renameInterface = document.getElementById('rename-wallet-interface');
    if (renameInterface) {
        renameInterface.classList.remove('hidden');
    }

    const input = document.getElementById('rename-wallet-name-input') as HTMLInputElement;
    if (input) {
        input.value = currentName;
        input.focus();
        input.select();
    }

    const errorEl = document.getElementById('rename-error-message');
    if (errorEl) {
        errorEl.classList.add('hidden');
        errorEl.textContent = '';
    }
}

/**
 * Handle rename save action
 * Supports v1 wallet renaming, v2 master key renaming, and v2 sub-wallet renaming
 * Format of renameWalletId:
 * - v1 wallet: "<walletId>"
 * - v2 master key: "master:<masterKeyId>"
 * - v2 sub-wallet: "sub:<masterKeyId>:<subWalletIndex>"
 */
export async function handleRenameSave(): Promise<void> {
    try {
        console.log('🔵 [Rename] handleRenameSave() CALLED');

        if (isRenameSaving) {
            console.log('🔄 [Rename] Save already in progress - ignoring');
            return;
        }

        setIsRenameSaving(true);

        if (!renameWalletId) {
            console.error('[Rename] No wallet ID set - ABORTING');
            return;
        }

        const input = document.getElementById('rename-wallet-name-input') as HTMLInputElement;
        const errorEl = document.getElementById('rename-error-message');
        const newName = input?.value.trim();

        if (!newName) {
            if (errorEl) {
                errorEl.textContent = 'Please enter a name';
                errorEl.classList.remove('hidden');
            }
            return;
        }

        console.log('[Rename] Saving new name', { id: renameWalletId, newName });

        let response;

        // Determine rename type based on ID format
        if (renameWalletId.startsWith('master:')) {
            // Renaming a master key (v2)
            const masterKeyId = renameWalletId.substring(7); // Remove "master:" prefix
            response = await ExtensionMessaging.renameMasterKey(masterKeyId, newName);
        } else if (renameWalletId.startsWith('sub:')) {
            // Renaming a sub-wallet (v2)
            const parts = renameWalletId.split(':');
            const masterKeyId = parts[1];
            const subWalletIndex = parseInt(parts[2], 10);
            response = await ExtensionMessaging.renameSubWallet(masterKeyId, subWalletIndex, newName);
        } else {
            // Renaming a v1 wallet
            const pin = sessionPin || '';
            if (!pin) {
                showError('Session expired. Please unlock wallet again.');
                return;
            }
            response = await ExtensionMessaging.renameWallet(renameWalletId, newName, pin);
        }

        if (response.success) {
            showSuccess('Renamed successfully!');

            setRenameWalletId(null);
            setRenameWalletCurrentName(null);

            hideRenameInterface();

            await loadWalletManagementList();
            await initializeMultiWalletUI();
        } else {
            if (errorEl) {
                errorEl.textContent = response.error || 'Failed to rename';
                errorEl.classList.remove('hidden');
            }
        }
    } catch (error) {
        console.error('[Rename] Save failed:', error);
        const errorEl = document.getElementById('rename-error-message');
        if (errorEl) {
            errorEl.textContent = 'Failed to rename';
            errorEl.classList.remove('hidden');
        }
    } finally {
        setIsRenameSaving(false);
    }
}

/**
 * Hide rename interface and return to wallet management
 */
export function hideRenameInterface(): void {
    console.log('[Rename] Hiding rename interface');

    const renameInterface = document.getElementById('rename-wallet-interface');
    if (renameInterface) {
        renameInterface.classList.add('hidden');
    }

    const managementInterface = document.getElementById('wallet-management-interface');
    if (managementInterface) {
        managementInterface.classList.remove('hidden');
    }

    setRenameWalletId(null);
    setRenameWalletCurrentName(null);
}

// ========================================
// Delete Wallet
// ========================================

/**
 * Handle delete wallet action
 */
export async function handleDeleteWallet(walletId: string): Promise<void> {
    try {
        console.log(`[Wallet Management] Deleting wallet ${walletId}`);

        const confirmed = confirm('Are you sure you want to delete this wallet? This action cannot be undone. Make sure you have backed up your recovery phrase!');
        if (!confirmed) return;

        const pin = await showPINModal('Enter your PIN to delete wallet');
        if (!pin) return;

        const response = await ExtensionMessaging.deleteWallet(walletId, pin);
        if (response.success) {
            showSuccess('Wallet deleted successfully!');

            await loadWalletManagementList();
            await initializeMultiWalletUI();
        } else {
            showError(response.error || 'Failed to delete wallet');
        }
    } catch (error) {
        console.error('[Wallet Management] Delete failed:', error);
        showError('Failed to delete wallet');
    }
}

// ========================================
// Archive Wallet
// ========================================

/**
 * Handle archive master key action
 * Archives the wallet without requiring PIN (for forgotten PIN recovery)
 */
async function handleArchiveMasterKey(masterId: string, masterName: string): Promise<void> {
    try {
        console.log(`[Wallet Management] Archiving master key ${masterId}`);

        // Show confirmation modal
        const confirmed = await showArchiveConfirmation(masterName);
        if (!confirmed) {
            console.log('[Wallet Management] Archive cancelled by user');
            return;
        }

        // Archive the wallet (no PIN required)
        const response = await ExtensionMessaging.archiveMasterKey(masterId);
        if (response.success) {
            showSuccess(`"${masterName}" has been archived`);
            await loadWalletManagementList();
            await initializeMultiWalletUI();
        } else {
            showError(response.error || 'Failed to archive wallet');
        }
    } catch (error) {
        console.error('[Wallet Management] Archive master key failed:', error);
        showError('Failed to archive wallet');
    }
}

/**
 * Show archive confirmation modal
 */
async function showArchiveConfirmation(walletName: string): Promise<boolean> {
    return new Promise((resolve) => {
        const modalHtml = `
            <div id="archive-confirm-modal" class="modal-overlay">
                <div class="modal-content">
                    <h3>Archive Wallet</h3>
                    <p>Are you sure you want to archive "${walletName}"?</p>
                    <p class="modal-note">Archived wallets can be restored later from the Archived Wallets list.</p>
                    <div class="modal-buttons">
                        <button id="archive-cancel-btn" class="modal-btn secondary">Cancel</button>
                        <button id="archive-confirm-btn" class="modal-btn primary">Archive</button>
                    </div>
                </div>
            </div>
        `;

        // Insert modal into DOM
        const modalContainer = document.createElement('div');
        modalContainer.innerHTML = modalHtml;
        document.body.appendChild(modalContainer);

        const modal = document.getElementById('archive-confirm-modal');
        const cancelBtn = document.getElementById('archive-cancel-btn');
        const confirmBtn = document.getElementById('archive-confirm-btn');

        const cleanup = () => {
            modalContainer.remove();
        };

        cancelBtn?.addEventListener('click', () => {
            cleanup();
            resolve(false);
        });

        confirmBtn?.addEventListener('click', () => {
            cleanup();
            resolve(true);
        });

        // Close on overlay click
        modal?.addEventListener('click', (e) => {
            if (e.target === modal) {
                cleanup();
                resolve(false);
            }
        });
    });
}

/**
 * Show archived wallets interface
 */
export async function showArchivedWalletsInterface(): Promise<void> {
    console.log('[Wallet Management] Showing archived wallets interface');

    // Hide wallet management interface
    const managementInterface = document.getElementById('wallet-management-interface');
    if (managementInterface) {
        managementInterface.classList.add('hidden');
    }

    // Show archived wallets interface
    const archivedInterface = document.getElementById('archived-wallets-interface');
    if (archivedInterface) {
        archivedInterface.classList.remove('hidden');
    }

    // Load and display archived wallets
    await loadArchivedWalletsList();

    // Setup back button
    const backBtn = document.getElementById('archived-wallets-back-btn');
    if (backBtn) {
        backBtn.onclick = () => {
            hideArchivedWalletsInterface();
        };
    }
}

/**
 * Hide archived wallets interface and return to wallet management
 */
export function hideArchivedWalletsInterface(): void {
    console.log('[Wallet Management] Hiding archived wallets interface');

    const archivedInterface = document.getElementById('archived-wallets-interface');
    if (archivedInterface) {
        archivedInterface.classList.add('hidden');
    }

    const managementInterface = document.getElementById('wallet-management-interface');
    if (managementInterface) {
        managementInterface.classList.remove('hidden');
    }
}

/**
 * Load and display archived wallets list
 * Shows hierarchical structure: master wallets with their archived sub-wallets nested below
 */
async function loadArchivedWalletsList(): Promise<void> {
    const listContainer = document.getElementById('archived-wallets-list');
    if (!listContainer) return;

    listContainer.innerHTML = '<div class="loading-wallets">Loading archived wallets...</div>';

    try {
        // Fetch archived wallets, archived sub-wallets, and active wallets (for parent context)
        const [masterResponse, subResponse, activeWalletsResponse] = await Promise.all([
            ExtensionMessaging.getArchivedWallets(),
            ExtensionMessaging.getArchivedSubWallets(),
            ExtensionMessaging.getAllWallets()
        ]);

        const archivedMasterWallets = masterResponse.success && masterResponse.data ? masterResponse.data : [];
        const archivedSubWallets = subResponse.success && subResponse.data ? subResponse.data : [];
        const activeWallets = activeWalletsResponse.success && activeWalletsResponse.data ? activeWalletsResponse.data : [];

        if (archivedMasterWallets.length === 0 && archivedSubWallets.length === 0) {
            listContainer.innerHTML = '<div class="no-wallets">No archived wallets</div>';
            return;
        }

        // Group archived sub-wallets by their master key ID
        const subWalletsByMaster = new Map<string, typeof archivedSubWallets>();
        for (const subWallet of archivedSubWallets) {
            const existing = subWalletsByMaster.get(subWallet.masterKeyId) || [];
            existing.push(subWallet);
            subWalletsByMaster.set(subWallet.masterKeyId, existing);
        }

        let html = '';

        // 1. Archived Master Wallets (with any archived sub-wallets nested)
        if (archivedMasterWallets.length > 0) {
            for (const wallet of archivedMasterWallets) {
                const archivedDate = wallet.archivedAt
                    ? new Date(wallet.archivedAt).toLocaleDateString()
                    : 'Unknown';

                html += `
                    <div class="archived-master-item" data-wallet-id="${wallet.id}">
                        <div class="archived-master-header archived">
                            <span class="archived-wallet-icon">🔑</span>
                            <div class="archived-wallet-info">
                                <div class="archived-wallet-name">${wallet.nickname}</div>
                                <div class="archived-wallet-meta">Archived: ${archivedDate}</div>
                            </div>
                        </div>
                        <div class="archived-wallet-actions">
                            <button class="wallet-mgmt-btn restore-archived-btn"
                                    data-wallet-id="${wallet.id}"
                                    data-wallet-name="${wallet.nickname}">
                                Restore
                            </button>
                            <button class="wallet-mgmt-btn delete-archived-btn danger"
                                    data-wallet-id="${wallet.id}"
                                    data-wallet-name="${wallet.nickname}">
                                Delete Forever
                            </button>
                        </div>
                    </div>
                `;

                // Remove from map since we've handled this master's sub-wallets implicitly
                subWalletsByMaster.delete(wallet.id);
            }
        }

        // 2. Active Master Wallets that have archived sub-wallets (show parent for context)
        for (const [masterKeyId, subWallets] of subWalletsByMaster) {
            // Find the active parent wallet
            const parentWallet = activeWallets.find(w => w.id === masterKeyId);
            const parentName = parentWallet?.nickname || subWallets[0]?.masterKeyNickname || 'Unknown Wallet';

            html += `
                <div class="archived-master-item" data-wallet-id="${masterKeyId}">
                    <div class="archived-master-header active-parent">
                        <span class="archived-wallet-icon">🔑</span>
                        <div class="archived-wallet-info">
                            <div class="archived-wallet-name">${parentName}</div>
                            <div class="archived-wallet-meta active-indicator">Active wallet</div>
                        </div>
                    </div>
                    <div class="archived-sub-wallet-list">
                        ${subWallets.map((subWallet, i) => {
                            const archivedDate = new Date(subWallet.archivedAt).toLocaleDateString();
                            const isLast = i === subWallets.length - 1;
                            return `
                                <div class="archived-sub-wallet-item"
                                     data-master-id="${subWallet.masterKeyId}"
                                     data-sub-index="${subWallet.subWalletIndex}">
                                    <span class="sub-wallet-indent">${isLast ? '└──' : '├──'}</span>
                                    <span class="archived-wallet-icon">💼</span>
                                    <div class="archived-wallet-info">
                                        <div class="archived-wallet-name">${subWallet.subWalletNickname}</div>
                                        <div class="archived-wallet-meta">Archived: ${archivedDate}</div>
                                    </div>
                                    <button class="wallet-mgmt-btn restore-archived-sub-btn"
                                            data-master-id="${subWallet.masterKeyId}"
                                            data-sub-index="${subWallet.subWalletIndex}"
                                            data-sub-name="${subWallet.subWalletNickname}">
                                        Restore
                                    </button>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        }

        listContainer.innerHTML = html;
        attachArchivedWalletsListeners();
    } catch (error) {
        console.error('[Wallet Management] Failed to load archived wallets:', error);
        listContainer.innerHTML = '<div class="error-wallets">Error loading archived wallets</div>';
    }
}

/**
 * Attach event listeners for archived wallet actions
 */
function attachArchivedWalletsListeners(): void {
    // Restore archived master wallet
    document.querySelectorAll('.restore-archived-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const target = e.target as HTMLElement;
            const walletId = target.getAttribute('data-wallet-id');
            const walletName = target.getAttribute('data-wallet-name');
            if (walletId && walletName) {
                await handleRestoreArchivedWallet(walletId, walletName);
            }
        });
    });

    // Delete archived master wallet permanently
    document.querySelectorAll('.delete-archived-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const target = e.target as HTMLElement;
            const walletId = target.getAttribute('data-wallet-id');
            const walletName = target.getAttribute('data-wallet-name');
            if (walletId && walletName) {
                await handleDeleteArchivedWallet(walletId, walletName);
            }
        });
    });

    // Restore archived sub-wallet
    document.querySelectorAll('.restore-archived-sub-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const target = e.target as HTMLElement;
            const masterId = target.getAttribute('data-master-id');
            const subIndex = target.getAttribute('data-sub-index');
            const subName = target.getAttribute('data-sub-name');
            if (masterId && subIndex && subName) {
                await handleRestoreArchivedSubWallet(masterId, parseInt(subIndex, 10), subName);
            }
        });
    });

}

/**
 * Handle restore archived wallet
 */
async function handleRestoreArchivedWallet(walletId: string, walletName: string): Promise<void> {
    try {
        console.log(`[Wallet Management] Restoring archived wallet ${walletId}`);

        const response = await ExtensionMessaging.restoreArchivedMasterKey(walletId);
        if (response.success) {
            showSuccess(`"${walletName}" has been restored`);
            await loadArchivedWalletsList();
            // Also refresh the main wallet management list so restored wallet appears there
            await loadWalletManagementList();
            await initializeMultiWalletUI();
        } else {
            showError(response.error || 'Failed to restore wallet');
        }
    } catch (error) {
        console.error('[Wallet Management] Restore archived wallet failed:', error);
        showError('Failed to restore wallet');
    }
}

/**
 * Handle permanently delete archived wallet
 * Requires PIN verification for security
 */
async function handleDeleteArchivedWallet(walletId: string, walletName: string): Promise<void> {
    try {
        console.log(`[Wallet Management] Permanently deleting archived wallet ${walletId}`);

        // Request PIN to confirm deletion (same as regular delete)
        const pin = await showPINModal(`Enter PIN to permanently delete "${walletName}"`);
        if (!pin) {
            console.log('[Wallet Management] Delete cancelled by user');
            return;
        }

        // Verify PIN is correct by trying to decrypt the archived wallet
        const verifyResponse = await ExtensionMessaging.verifyArchivedWalletPin(walletId, pin);
        if (!verifyResponse.success || !verifyResponse.data) {
            showError('Incorrect PIN');
            return;
        }

        const response = await ExtensionMessaging.deleteArchivedMasterKey(walletId);
        if (response.success) {
            showSuccess(`"${walletName}" has been permanently deleted`);
            await loadArchivedWalletsList();
        } else {
            showError(response.error || 'Failed to delete wallet');
        }
    } catch (error) {
        console.error('[Wallet Management] Delete archived wallet failed:', error);
        showError('Failed to delete wallet');
    }
}

/**
 * Handle restore archived sub-wallet
 */
async function handleRestoreArchivedSubWallet(masterId: string, subIndex: number, subName: string): Promise<void> {
    try {
        console.log(`[Wallet Management] Restoring archived sub-wallet ${masterId}:${subIndex}`);

        const response = await ExtensionMessaging.restoreSubWallet(masterId, subIndex);
        if (response.success) {
            showSuccess(`"${subName}" has been restored`);
            await loadArchivedWalletsList();
            // Also refresh the main wallet management list so restored wallet appears there
            await loadWalletManagementList();
            await initializeMultiWalletUI();
        } else {
            showError(response.error || 'Failed to restore sub-wallet');
        }
    } catch (error) {
        console.error('[Wallet Management] Restore archived sub-wallet failed:', error);
        showError('Failed to restore sub-wallet');
    }
}

