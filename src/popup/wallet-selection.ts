// Wallet Selection for Unlock Screen
// Handles wallet/sub-wallet selection before PIN entry

import { ExtensionMessaging } from '../utils/messaging';
import { setIsAddingWallet } from './state';
import { hideAllViews } from './view-manager';

/**
 * Show wallet selection interface
 * Displays all wallets and sub-wallets without balances
 */
export async function showWalletSelectionInterface(): Promise<void> {
    console.log('🔵 [Wallet Selection] Showing wallet selection interface');

    // The selector is a top-level view. Always close every wallet-specific
    // surface first so a deleted/locked wallet cannot remain visible behind it.
    hideAllViews();

    // Close the in-wallet dropdown too. It lives inside main-interface and can
    // otherwise retain stale open state when main is shown again later.
    document.getElementById('wallet-dropdown')?.classList.add('hidden');

    // Show wallet selection interface
    const selectionInterface = document.getElementById('wallet-selection-interface');
    if (selectionInterface) {
        selectionInterface.classList.remove('hidden');
    }

    // Load and populate wallet list
    await populateWalletSelectionList();

    // Setup back button
    const backBtn = document.getElementById('wallet-selection-back-btn');
    if (backBtn) {
        backBtn.onclick = () => {
            hideWalletSelectionInterface();
        };
    }
}

/**
 * Hide wallet selection interface and return to unlock screen
 * If no wallets exist, shows the setup wizard instead
 */
export async function hideWalletSelectionInterface(): Promise<void> {
    console.log('🔵 [Wallet Selection] Hiding wallet selection interface');

    hideAllViews();

    // Check if any wallets exist
    const walletsResponse = await ExtensionMessaging.getAllWallets();
    const hasWallets = walletsResponse.success && walletsResponse.data && walletsResponse.data.length > 0;

    if (hasWallets) {
        // Show unlock screen
        const unlockInterface = document.getElementById('unlock-interface');
        if (unlockInterface) {
            unlockInterface.classList.remove('hidden');
        }
    } else {
        // No wallets - show setup wizard with welcome step (first time setup)
        const wizard = document.getElementById('onboarding-wizard');
        if (wizard) {
            wizard.classList.remove('hidden');
            // Show welcome step for first-time users
            const welcomeStep = document.getElementById('welcome-step');
            const allSteps = document.querySelectorAll('.wizard-step');
            allSteps.forEach(step => step.classList.add('hidden'));
            if (welcomeStep) welcomeStep.classList.remove('hidden');
        }
    }
}

/**
 * Populate wallet selection list with hierarchical structure (no balances)
 * Reuses the same structure as populateWalletDropdown but in a full-screen view
 */
async function populateWalletSelectionList(): Promise<void> {
    const listContainer = document.getElementById('wallet-selection-list');
    if (!listContainer) return;

    listContainer.innerHTML = '<div class="loading-wallets">Loading wallets...</div>';

    try {
        // Get wallet metadata
        const walletsResponse = await ExtensionMessaging.getAllWallets();
        const wallets = walletsResponse.success && walletsResponse.data ? walletsResponse.data : [];
        const hasWallets = wallets.length > 0;

        // Get selected wallet for unlock and active wallet from storage
        const storageResult = await chrome.storage.local.get(['multiWalletData', 'selectedWalletForUnlock']);
        const multiWalletData = storageResult.multiWalletData ? JSON.parse(storageResult.multiWalletData) : null;

        // Use selectedWalletForUnlock if set, otherwise fall back to active wallet
        const selectedWalletForUnlock = storageResult.selectedWalletForUnlock ||
            (multiWalletData ? {
                masterKeyId: multiWalletData.activeWalletId,
                subWalletIndex: multiWalletData.activeSubWalletIndex ?? 0
            } : null);

        let html = '';

        // Show message if no wallets
        if (!hasWallets) {
            html += `
                <div class="no-wallets-message" style="padding: 20px; text-align: center; color: #666;">
                    No wallets yet
                </div>
            `;
        }

        // Build hierarchical list (similar to populateWalletDropdown)
        for (const wallet of wallets) {
            const isSelectedForUnlock = selectedWalletForUnlock
                ? selectedWalletForUnlock.masterKeyId === wallet.id
                : false;

            // Get sub-wallets from storage (filter out archived ones)
            const allSubWalletsData = multiWalletData
                ? multiWalletData.wallets?.find((w: any) => w.metadata.id === wallet.id)?.subWallets || []
                : [];
            const subWalletsData = allSubWalletsData.filter((sw: any) => !sw.archivedAt);

            const hasSubWallets = subWalletsData.length > 0;
            const createdDate = new Date(wallet.createdAt).toLocaleDateString();

            if (hasSubWallets) {
                // Wallet with sub-wallets - show hierarchical structure
                const isMasterSelectedForUnlock = isSelectedForUnlock &&
                    (!selectedWalletForUnlock.subWalletIndex || selectedWalletForUnlock.subWalletIndex === 0);

                html += `
                    <div class="wallet-selection-master-item">
                        <div class="wallet-selection-header ${isMasterSelectedForUnlock ? 'selected' : ''}"
                             data-master-id="${wallet.id}" data-sub-index="0">
                            <span class="wallet-icon">🔑</span>
                            <div class="wallet-info">
                                <div class="wallet-name">${wallet.nickname}</div>
                                <div class="wallet-meta">Created: ${createdDate}</div>
                            </div>
                            ${isMasterSelectedForUnlock ? '<span class="selection-check">✓</span>' : ''}
                        </div>

                        <!-- Sub-wallets -->
                        <div class="wallet-selection-sub-list">
                            ${subWalletsData.map((sw: any, i: number) => {
                                const isSubWalletSelected = isSelectedForUnlock &&
                                    selectedWalletForUnlock.subWalletIndex === sw.index;
                                const isLast = i === subWalletsData.length - 1;
                                return `
                                    <div class="wallet-selection-sub-item ${isSubWalletSelected ? 'selected' : ''}"
                                         data-master-id="${wallet.id}" data-sub-index="${sw.index}">
                                        <span class="sub-wallet-indent">${isLast ? '└──' : '├──'}</span>
                                        <span class="sub-wallet-name">${sw.nickname}</span>
                                        ${isSubWalletSelected ? '<span class="selection-check">✓</span>' : ''}
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `;
            } else {
                // Wallet without sub-wallets
                html += `
                    <div class="wallet-selection-master-item">
                        <div class="wallet-selection-header ${isSelectedForUnlock ? 'selected' : ''}"
                             data-master-id="${wallet.id}" data-sub-index="0">
                            <span class="wallet-icon">🔑</span>
                            <div class="wallet-info">
                                <div class="wallet-name">${wallet.nickname}</div>
                                <div class="wallet-meta">Created: ${createdDate}</div>
                            </div>
                            ${isSelectedForUnlock ? '<span class="selection-check">✓</span>' : ''}
                        </div>
                    </div>
                `;
            }
        }

        listContainer.innerHTML = html;
        attachWalletSelectionListeners();

        // Add "Add New Wallet" button to the footer (outside scrollable list)
        const footerContainer = document.getElementById('wallet-selection-footer');
        if (footerContainer) {
            footerContainer.innerHTML = `
                <button id="add-wallet-from-selection-btn" class="btn-secondary" style="width: 100%; padding: 12px; font-size: 14px; display: flex; align-items: center; justify-content: center; gap: 8px;">
                    <span style="font-size: 18px;">+</span> Add New Wallet
                </button>
            `;

            // Attach listener for add wallet button
            const addBtn = document.getElementById('add-wallet-from-selection-btn');
            if (addBtn) {
                addBtn.onclick = () => {
                    // Ensure we're NOT in "adding wallet" mode - this prevents the sub-wallet button from showing
                    // since we're adding a new master wallet from scratch, not from within an active wallet
                    setIsAddingWallet(false);

                    // Hide selection interface and show setup wizard
                    const selectionInterface = document.getElementById('wallet-selection-interface');
                    if (selectionInterface) selectionInterface.classList.add('hidden');

                    const wizard = document.getElementById('onboarding-wizard');
                    const unlockInterface = document.getElementById('unlock-interface');
                    if (unlockInterface) unlockInterface.classList.add('hidden');
                    if (wizard) {
                        wizard.classList.remove('hidden');
                        // Show setup-choice-step directly (skip welcome)
                        const setupChoiceStep = document.getElementById('setup-choice-step');
                        const allSteps = document.querySelectorAll('.wizard-step');
                        allSteps.forEach(step => step.classList.add('hidden'));
                        if (setupChoiceStep) setupChoiceStep.classList.remove('hidden');
                    }
                };
            }
        }
    } catch (error) {
        console.error('[Wallet Selection] Error populating list:', error);
        listContainer.innerHTML = '<div class="error-wallets">Error loading wallets</div>';
    }
}

/**
 * Attach click listeners to wallet selection items
 */
function attachWalletSelectionListeners(): void {
    // Master wallet headers
    document.querySelectorAll('.wallet-selection-header').forEach(header => {
        header.addEventListener('click', async (e) => {
            const target = e.currentTarget as HTMLElement;
            const masterId = target.getAttribute('data-master-id');
            const subIndex = parseInt(target.getAttribute('data-sub-index') || '0', 10);

            if (masterId) {
                await handleWalletSelectionChoice(masterId, subIndex);
            }
        });
    });

    // Sub-wallet items
    document.querySelectorAll('.wallet-selection-sub-item').forEach(item => {
        item.addEventListener('click', async (e) => {
            const target = e.currentTarget as HTMLElement;
            const masterId = target.getAttribute('data-master-id');
            const subIndex = parseInt(target.getAttribute('data-sub-index') || '0', 10);

            if (masterId) {
                await handleWalletSelectionChoice(masterId, subIndex);
            }
        });
    });
}

/**
 * Handle wallet selection choice
 * Stores the selected wallet and returns to unlock screen
 */
async function handleWalletSelectionChoice(masterKeyId: string, subWalletIndex: number): Promise<void> {
    console.log('🔵 [Wallet Selection] Selected wallet:', { masterKeyId, subWalletIndex });

    try {
        // Store selected wallet for unlock
        await chrome.storage.local.set({
            selectedWalletForUnlock: {
                masterKeyId,
                subWalletIndex
            }
        });

        // Dispatch event to notify popup.ts to update the unlock screen
        window.dispatchEvent(new CustomEvent('wallet-selected'));

        // Return to unlock screen
        hideWalletSelectionInterface();

        // Clear any previous error messages
        const unlockError = document.getElementById('unlock-error');
        if (unlockError) {
            unlockError.classList.add('hidden');
            unlockError.textContent = '';
        }

        // Clear PIN input
        const pinInput = document.getElementById('unlock-pin') as HTMLInputElement;
        if (pinInput) {
            pinInput.value = '';
            pinInput.focus();
        }

        console.log('✅ [Wallet Selection] Selection saved, returned to unlock screen');
    } catch (error) {
        console.error('[Wallet Selection] Failed to save selection:', error);
    }
}
