// Withdrawal Interface
// Handles Lightning + On-chain send flows

// parse is now a method on the SDK instance, not a standalone export
import {
    breezSDK,
    currentBalance,
    preparedPayment,
    setPreparedPayment
} from './state';
import { isExistingContact, openContactModalWithAddress, openContactPicker, showContactsInterface } from './contacts';
import { showError, showSuccess, showConfirmDialog } from './notifications';
import { currencyService, fiatToSats, satsToFiat, formatFiat, formatSelectedCurrencyAmount, getBtcSpotPrice, type FiatCurrency } from '../utils/currency';
import { getUserFiatCurrency, getDisplayCurrency, type DisplayCurrency } from './currency-pref';
import { nonblankPaymentComment, preparedPaymentComment, savePaymentComment } from './payment-comment';

export type WithdrawalCallbacks = {
    updateBalanceDisplay: () => Promise<void>;
    loadTransactionHistory: () => Promise<void>;
};

let callbacks: WithdrawalCallbacks | null = null;
let withdrawalListenersInitialized = false;

let activeSendTab: 'lightning' | 'onchain' = 'lightning';
let onchainPreparedBySpeed: Partial<Record<'fast' | 'medium' | 'slow', any>> = {};
let onchainSelectedSpeed: 'fast' | 'medium' | 'slow' = 'medium';
let dismissedSaveContactAddress: string | null = null;
let paymentSendInProgress = false;
let saveContactPromptRequestId = 0;
// Captured at Preview so post-send history reflects the exact comment the user approved.
// Recipient delivery remains restricted to LNURL-pay recipients that advertise LUD-12.
let preparedCommentAtPreview: string | undefined;

// Currency toggle state for send amount input
let sendInputCurrency: DisplayCurrency = 'sats';
let userFiatCurrency: FiatCurrency = 'usd';

/** Load currency preferences from shared cache */
async function loadFiatCurrencySetting(): Promise<void> {
    userFiatCurrency = await getUserFiatCurrency();
    sendInputCurrency = await getDisplayCurrency();
}

/** Update the currency selector value and conversion hint */
function updateCurrencyToggleUI(): void {
    const currencySelect = document.getElementById('send-currency-select') as HTMLSelectElement | null;
    const amountInput = document.getElementById('withdrawal-amount') as HTMLInputElement;

    if (currencySelect) {
        currencySelect.value = sendInputCurrency;
    }

    if (amountInput) {
        amountInput.placeholder = sendInputCurrency === 'sats' ? 'Amount in sats' : `Amount in ${sendInputCurrency.toUpperCase()}`;
    }

    // Update conversion hint based on current input value
    updateConversionHint();
}

function getContactSaveCandidate(input: string): string | null {
    const candidate = input.trim().replace(/^lightning:/i, '');
    const lower = candidate.toLowerCase();
    const match = candidate.match(/[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    if (match) return match[0];

    const lnurlMatch = candidate.match(/lnurl[a-z0-9]{15,}/i);
    if (lnurlMatch) return lnurlMatch[0];

    if (lower.startsWith('lnurl') && candidate.length >= 20) {
        return candidate;
    }

    return null;
}

function hideSaveContactPrompt(invalidatePending = true): void {
    if (invalidatePending) {
        saveContactPromptRequestId += 1;
    }
    const prompt = document.getElementById('save-contact-prompt');
    const saveBtn = document.getElementById('save-contact-save-btn') as HTMLButtonElement | null;

    prompt?.classList.add('hidden');
    if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
    }
}

function showSaveContactPrompt(address: string): void {
    const prompt = document.getElementById('save-contact-prompt');
    const addressEl = document.getElementById('save-contact-address');
    const cancelBtn = document.getElementById('save-contact-cancel-btn') as HTMLButtonElement | null;
    const saveBtn = document.getElementById('save-contact-save-btn') as HTMLButtonElement | null;

    if (!prompt || !addressEl || !cancelBtn || !saveBtn) {
        console.warn('[Withdrawal] Save-contact prompt markup is missing');
        return;
    }

    addressEl.textContent = address;

    cancelBtn.onclick = () => {
        dismissedSaveContactAddress = address.toLowerCase();
        hideSaveContactPrompt();
    };

    saveBtn.onclick = async () => {
        const originalText = saveBtn.textContent || 'Save';
        saveBtn.disabled = true;
        saveBtn.textContent = 'Opening...';

        try {
            dismissedSaveContactAddress = address.toLowerCase();
            hideSaveContactPrompt();
            await showContactsInterface();
            openContactModalWithAddress(address);
        } catch (error) {
            showError(error instanceof Error ? error.message : 'Failed to open contacts');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = originalText;
        }
    };

    prompt.classList.remove('hidden');
    console.log('[Withdrawal] Showing save-contact prompt for', address);
    saveBtn.focus({ preventScroll: true });
}

async function getSaveContactPromptAddress(recipient: string): Promise<string | null> {
    hideSaveContactPrompt(false);

    const address = getContactSaveCandidate(recipient);
    if (!address) {
        console.log('[Withdrawal] No save-contact prompt: recipient is not a saveable Lightning Address or LNURL', recipient);
        return null;
    }

    const addressKey = address.toLowerCase();
    if (dismissedSaveContactAddress === addressKey) {
        console.log('[Withdrawal] No save-contact prompt: address was dismissed', address);
        return null;
    }

    try {
        if (await isExistingContact(address)) {
            console.log('[Withdrawal] No save-contact prompt: address already saved', address);
            return null;
        }
    } catch (error) {
        console.warn('[Withdrawal] Failed to check contact book:', error);
        return null;
    }

    console.log('[Withdrawal] Save-contact candidate ready', address);
    return address;
}

function showPreviewSaveContactPrompt(recipient: string): void {
    const requestId = saveContactPromptRequestId + 1;
    saveContactPromptRequestId = requestId;

    getSaveContactPromptAddress(recipient)
        .then((address) => {
            if (requestId === saveContactPromptRequestId && address) {
                showSaveContactPrompt(address);
            }
        })
        .catch((error) => {
            console.warn('[Withdrawal] Failed to prepare save-contact prompt:', error);
        });
}

/** Show live conversion below the amount input */
async function updateConversionHint(): Promise<void> {
    const conversionHint = document.getElementById('send-conversion-hint');
    const amountInput = document.getElementById('withdrawal-amount') as HTMLInputElement;
    if (!conversionHint || !amountInput) return;

    const rawValue = parseFloat(amountInput.value);
    if (!rawValue || rawValue <= 0) {
        conversionHint.textContent = '';
        conversionHint.classList.add('hidden');
        return;
    }

    conversionHint.classList.remove('hidden');
    const spotCurrency = sendInputCurrency === 'sats' ? userFiatCurrency : sendInputCurrency;
    const spotPrice = await getBtcSpotPrice(spotCurrency);

    if (sendInputCurrency === 'sats') {
        // Show fiat equivalent
        const fiatAmount = await satsToFiat(rawValue, userFiatCurrency);
        if (fiatAmount !== null) {
            const estimate = `≈ ${formatFiat(fiatAmount, userFiatCurrency)}`;
            conversionHint.textContent = spotPrice ? `${estimate}\n${spotPrice}` : estimate;
        } else {
            conversionHint.textContent = '≈ rate unavailable';
        }
    } else {
        // Show sats equivalent
        const sats = await fiatToSats(rawValue, sendInputCurrency);
        if (sats !== null) {
            const lines = [`= ${sats.toLocaleString()} sats`];
            if (sendInputCurrency !== userFiatCurrency) {
                const defaultFiat = await satsToFiat(sats, userFiatCurrency);
                if (defaultFiat !== null) {
                    lines.push(`≈ ${formatFiat(defaultFiat, userFiatCurrency)} ${userFiatCurrency.toUpperCase()}`);
                }
            }
            if (spotPrice) lines.push(spotPrice);
            conversionHint.textContent = lines.join('\n');
        } else {
            conversionHint.textContent = '= rate unavailable';
        }
    }
}

export function setWithdrawalCallbacks(cb: WithdrawalCallbacks): void {
    callbacks = cb;
}

export function showWithdrawalInterface(): void {
    const mainInterface = document.getElementById('main-interface');
    const withdrawInterface = document.getElementById('withdraw-interface');

    mainInterface?.classList.add('hidden');
    withdrawInterface?.classList.remove('hidden');

    const balanceDisplay = document.getElementById('withdraw-balance-display');
    if (balanceDisplay) balanceDisplay.textContent = `${currentBalance.toLocaleString()}`;

    // Load fiat currency preference before resetting form
    loadFiatCurrencySetting()
        .catch(() => {
            userFiatCurrency = 'usd';
        })
        .finally(() => {
            resetWithdrawForm();
            setupWithdrawalListeners();
            setSendTab('lightning');
        });
}

export function hideWithdrawInterface(): void {
    const withdrawInterface = document.getElementById('withdraw-interface');
    const mainInterface = document.getElementById('main-interface');

    withdrawInterface?.classList.add('hidden');
    mainInterface?.classList.remove('hidden');

    resetWithdrawForm();
    setPreparedPayment(null);
    preparedCommentAtPreview = undefined;
}

function setSendTab(tab: 'lightning' | 'onchain'): void {
    activeSendTab = tab;

    const lightningBtn = document.getElementById('withdraw-tab-lightning');
    const onchainBtn = document.getElementById('withdraw-tab-onchain');
    const lightningContent = document.getElementById('withdraw-lightning-content');
    const onchainContent = document.getElementById('withdraw-onchain-content');

    lightningBtn?.classList.toggle('active', tab === 'lightning');
    onchainBtn?.classList.toggle('active', tab === 'onchain');
    lightningContent?.classList.toggle('hidden', tab !== 'lightning');
    onchainContent?.classList.toggle('hidden', tab !== 'onchain');

    const statusDiv = document.getElementById('withdrawal-status');
    statusDiv?.classList.add('hidden');
}

export function resetWithdrawForm(): void {
    const paymentInput = document.getElementById('payment-input') as HTMLTextAreaElement;
    const amountInput = document.getElementById('withdrawal-amount') as HTMLInputElement;
    const commentInput = document.getElementById('withdrawal-comment') as HTMLInputElement;
    const previewDiv = document.getElementById('payment-preview');
    const sendBtn = document.getElementById('send-payment-btn') as HTMLButtonElement;
    const previewBtn = document.getElementById('preview-payment-btn') as HTMLButtonElement;

    if (paymentInput) paymentInput.value = '';
    if (amountInput) {
        amountInput.value = '';
        amountInput.disabled = false;
        amountInput.placeholder = '';
    }
    if (commentInput) commentInput.value = '';
    preparedCommentAtPreview = undefined;
    previewDiv?.classList.add('hidden');
    hideSaveContactPrompt();
    dismissedSaveContactAddress = null;

    updateCurrencyToggleUI();
    const conversionHint = document.getElementById('send-conversion-hint');
    if (conversionHint) { conversionHint.textContent = ''; conversionHint.classList.add('hidden'); }

    if (sendBtn) {
        sendBtn.classList.add('hidden');
        sendBtn.disabled = true;
        sendBtn.textContent = 'Send Payment';
    }
    if (previewBtn) {
        previewBtn.disabled = true;
        previewBtn.textContent = 'Preview Payment';
    }

    // On-chain reset
    const onchainAddressInput = document.getElementById('onchain-address-input') as HTMLInputElement;
    const onchainAmountInput = document.getElementById('onchain-amount-input') as HTMLInputElement;
    const onchainPreview = document.getElementById('onchain-payment-preview');
    const previewOnchainBtn = document.getElementById('preview-onchain-payment-btn') as HTMLButtonElement;
    const sendOnchainBtn = document.getElementById('send-onchain-payment-btn') as HTMLButtonElement;
    const feeSummary = document.getElementById('onchain-network-fee');
    const onchainValidation = document.getElementById('onchain-amount-validation');

    if (onchainAddressInput) onchainAddressInput.value = '';
    if (onchainAmountInput) onchainAmountInput.value = '';
    onchainPreview?.classList.add('hidden');

    if (previewOnchainBtn) {
        previewOnchainBtn.disabled = true;
        previewOnchainBtn.textContent = 'Preview On-chain Transaction';
    }

    if (sendOnchainBtn) {
        sendOnchainBtn.classList.add('hidden');
        sendOnchainBtn.disabled = true;
        sendOnchainBtn.textContent = 'Send';
    }

    if (feeSummary) feeSummary.textContent = '—';
    if (onchainValidation) {
        onchainValidation.textContent = '';
        onchainValidation.classList.add('hidden');
    }
    (['fast', 'medium', 'slow'] as const).forEach(speed => {
        const feeEl = document.getElementById(`speed-fee-${speed}`);
        if (feeEl) feeEl.textContent = 'Fee: —';
    });

    onchainPreparedBySpeed = {};
    onchainSelectedSpeed = 'medium';
    updateSpeedSelectionUI();
}

export function setupWithdrawalListeners(): void {
    if (withdrawalListenersInitialized) return;
    withdrawalListenersInitialized = true;

    const backBtn = document.getElementById('withdraw-back-btn');
    if (backBtn) backBtn.onclick = () => hideWithdrawInterface();

    const lightningTabBtn = document.getElementById('withdraw-tab-lightning');
    const onchainTabBtn = document.getElementById('withdraw-tab-onchain');
    lightningTabBtn?.addEventListener('click', () => setSendTab('lightning'));
    onchainTabBtn?.addEventListener('click', () => setSendTab('onchain'));

    const paymentInput = document.getElementById('payment-input') as HTMLTextAreaElement;
    const amountInput = document.getElementById('withdrawal-amount') as HTMLInputElement;
    const previewBtn = document.getElementById('preview-payment-btn') as HTMLButtonElement;
    const sendBtn = document.getElementById('send-payment-btn') as HTMLButtonElement;

    const contactsBtn = document.getElementById('withdraw-contacts-btn');
    contactsBtn?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        openContactPicker((contact) => {
            if (paymentInput) {
                paymentInput.value = contact.lightningAddress;
                validateWithdrawalForm();
            }
        });
    });

    paymentInput?.addEventListener('input', validateWithdrawalForm);
    amountInput?.addEventListener('input', () => {
        validateWithdrawalForm();
        updateConversionHint();
    });
    previewBtn?.addEventListener('click', previewPayment);

    // Currency select dropdown
    const currencySelect = document.getElementById('send-currency-select') as HTMLSelectElement | null;
    currencySelect?.addEventListener('change', () => {
        const nextCurrency = currencySelect.value as DisplayCurrency;
        if (nextCurrency !== 'sats' && nextCurrency !== 'usd' && nextCurrency !== 'eur') {
            return;
        }

        sendInputCurrency = nextCurrency;

        const amtInput = document.getElementById('withdrawal-amount') as HTMLInputElement;
        if (amtInput) amtInput.value = ''; // clear on currency change to avoid confusion
        updateCurrencyToggleUI();
        validateWithdrawalForm();
    });
    sendBtn?.addEventListener('click', () => sendPayment());

    const onchainAddressInput = document.getElementById('onchain-address-input') as HTMLInputElement;
    const onchainAmountInput = document.getElementById('onchain-amount-input') as HTMLInputElement;
    const previewOnchainBtn = document.getElementById('preview-onchain-payment-btn') as HTMLButtonElement;
    const sendOnchainBtn = document.getElementById('send-onchain-payment-btn') as HTMLButtonElement;

    onchainAddressInput?.addEventListener('input', validateOnchainForm);
    onchainAmountInput?.addEventListener('input', validateOnchainForm);

    document.querySelectorAll('#onchain-speed-cards .speed-card').forEach((card) => {
        card.addEventListener('click', () => {
            const speed = (card as HTMLElement).dataset.speed as 'fast' | 'medium' | 'slow';
            if (!speed) return;
            onchainSelectedSpeed = speed;
            updateSpeedSelectionUI();
            updateOnchainPreviewFromSelection();
        });
    });

    previewOnchainBtn?.addEventListener('click', previewOnchainPayment);
    sendOnchainBtn?.addEventListener('click', sendOnchainPayment);
}

let autoPreviewInProgress = false;

export function validateWithdrawalForm(): void {
    const paymentInput = document.getElementById('payment-input') as HTMLTextAreaElement;
    const previewBtn = document.getElementById('preview-payment-btn') as HTMLButtonElement;
    const amountInput = document.getElementById('withdrawal-amount') as HTMLInputElement;

    if (!paymentInput || !previewBtn) return;

    const input = paymentInput.value.trim();
    const lower = input.toLowerCase();
    const isValidInvoice = lower.startsWith('lnbc') || lower.startsWith('lntb');
    const isValidAddress = input.includes('@') && input.includes('.');

    previewBtn.disabled = !(isValidInvoice || isValidAddress);

    // BOLT11 with encoded amount: auto-preview and disable amount input
    if (isValidInvoice && !autoPreviewInProgress) {
        // Check if amount is encoded in the invoice (lnbc<amount><multiplier>1...)
        // e.g. lnbc500u1..., lnbc1m1..., lnbc2500n1...
        const hasAmount = /^ln(bc|tb)\d+[munp]?1/i.test(input);
        if (hasAmount) {
            if (amountInput) {
                amountInput.disabled = true;
                amountInput.placeholder = 'Set by invoice';
                amountInput.value = '';
            }
            autoPreviewInProgress = true;
            previewPayment().finally(() => {
                autoPreviewInProgress = false;
            });
            return;
        }
    }

    // For non-invoice or zero-amount invoice: re-enable amount input
    if (amountInput && amountInput.disabled) {
        amountInput.disabled = false;
        amountInput.placeholder = '';
    }
}

let onchainFeeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function isValidBitcoinAddress(address: string): boolean {
    // Bech32 (native segwit): bc1q... (42 chars) or bc1p... (62 chars taproot)
    if (/^bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{25,87}$/i.test(address)) return true;
    // Legacy P2PKH: starts with 1, 25-34 chars
    if (/^1[1-9A-HJ-NP-Za-km-z]{24,33}$/.test(address)) return true;
    // P2SH: starts with 3, 25-34 chars
    if (/^3[1-9A-HJ-NP-Za-km-z]{24,33}$/.test(address)) return true;
    return false;
}

function validateOnchainForm(): void {
    const addressInput = document.getElementById('onchain-address-input') as HTMLInputElement;
    const amountInput = document.getElementById('onchain-amount-input') as HTMLInputElement;
    const previewBtn = document.getElementById('preview-onchain-payment-btn') as HTMLButtonElement;
    const validationMessage = document.getElementById('onchain-amount-validation');

    if (!addressInput || !amountInput || !previewBtn) return;

    const address = addressInput.value.trim();
    const amount = parseInt(amountInput.value) || 0;

    const MIN_ONCHAIN_SATS = 1000;

    // Validate bitcoin address format
    if (address.length > 0 && !isValidBitcoinAddress(address)) {
        if (validationMessage) {
            validationMessage.textContent = 'Invalid Bitcoin address';
            validationMessage.classList.remove('hidden');
        }
        previewBtn.disabled = true;
    } else if (amount > 0 && amount < MIN_ONCHAIN_SATS) {
        if (validationMessage) {
            validationMessage.textContent = `Minimum on-chain send: ${MIN_ONCHAIN_SATS.toLocaleString()} sats`;
            validationMessage.classList.remove('hidden');
        }
        previewBtn.disabled = true;
    } else {
        if (validationMessage) {
            validationMessage.textContent = '';
            validationMessage.classList.add('hidden');
        }
        previewBtn.disabled = !(isValidBitcoinAddress(address) && amount >= MIN_ONCHAIN_SATS);
    }

    // Auto-fetch fees when address + amount are valid
    if (onchainFeeDebounceTimer) clearTimeout(onchainFeeDebounceTimer);
    if (address.length >= 14 && amount > 0) {
        onchainFeeDebounceTimer = setTimeout(() => autoFetchOnchainFees(address, amount), 800);
    } else {
        // Clear fees when inputs are incomplete
        (['fast', 'medium', 'slow'] as const).forEach(speed => {
            const feeEl = document.getElementById(`speed-fee-${speed}`);
            if (feeEl) feeEl.textContent = 'Fee: —';
        });
        const feeSummary = document.getElementById('onchain-network-fee');
        if (feeSummary) feeSummary.textContent = '—';
    }
}

async function autoFetchOnchainFees(address: string, amount: number): Promise<void> {
    if (!breezSDK) return;

    // Show loading state
    (['fast', 'medium', 'slow'] as const).forEach(speed => {
        const feeEl = document.getElementById(`speed-fee-${speed}`);
        if (feeEl) feeEl.textContent = 'Fee: ...';
    });

    try {
        const prepared = await breezSDK.prepareSendPayment({
            paymentRequest: { type: 'input', input: address },
            amount: BigInt(amount)
        });

        onchainPreparedBySpeed = { fast: prepared, medium: prepared, slow: prepared };

        const feeQuote = (prepared?.paymentMethod as any)?.feeQuote;
        const speedMap = { fast: feeQuote?.speedFast, medium: feeQuote?.speedMedium, slow: feeQuote?.speedSlow } as const;

        for (const speed of ['fast', 'medium', 'slow'] as const) {
            const quote = speedMap[speed];
            const serviceFee = Number(quote?.userFeeSat ?? 0);
            const l1Fee = Number(quote?.l1BroadcastFeeSat ?? 0);
            const totalFee = serviceFee + l1Fee;
            const feeEl = document.getElementById(`speed-fee-${speed}`);
            if (feeEl) {
                if (totalFee > 0) {
                    feeEl.textContent = `Fee: ${totalFee.toLocaleString()} sats`;
                } else {
                    feeEl.textContent = 'Fee: unavailable';
                }
            }
        }

        updateOnchainPreviewFromSelection();
    } catch (error) {
        console.error('Auto-fee estimation failed:', error);
        (['fast', 'medium', 'slow'] as const).forEach(speed => {
            const feeEl = document.getElementById(`speed-fee-${speed}`);
            if (feeEl) feeEl.textContent = 'Fee: —';
        });
    }
}

function updateSpeedSelectionUI(): void {
    document.querySelectorAll('#onchain-speed-cards .speed-card').forEach((card) => {
        const speed = (card as HTMLElement).dataset.speed;
        card.classList.toggle('selected', speed === onchainSelectedSpeed);
    });
}

async function previewOnchainPayment(): Promise<void> {
    const addressInput = document.getElementById('onchain-address-input') as HTMLInputElement;
    const amountInput = document.getElementById('onchain-amount-input') as HTMLInputElement;
    const previewBtn = document.getElementById('preview-onchain-payment-btn') as HTMLButtonElement;

    if (!addressInput || !amountInput || !previewBtn) return;

    const address = addressInput.value.trim();
    const amount = parseInt(amountInput.value) || 0;

    try {
        if (!breezSDK) {
            showError('Wallet not connected. Please unlock wallet first.');
            return;
        }

        previewBtn.disabled = true;
        previewBtn.textContent = 'Preparing...';

        onchainPreparedBySpeed = {};

        // Single prepare call — SDK returns fee quotes for all 3 speeds
        const prepared = await breezSDK.prepareSendPayment({
            paymentRequest: { type: 'input', input: address },
            amount: BigInt(amount)
        });

        // Store the same prepared response for all speeds (fee selection happens at send time)
        onchainPreparedBySpeed = { fast: prepared, medium: prepared, slow: prepared };

        // Extract per-speed fees from feeQuote
        const feeQuote = (prepared?.paymentMethod as any)?.feeQuote;
        const speedMap = { fast: feeQuote?.speedFast, medium: feeQuote?.speedMedium, slow: feeQuote?.speedSlow } as const;

        for (const speed of ['fast', 'medium', 'slow'] as const) {
            const quote = speedMap[speed];
            const serviceFee = Number(quote?.userFeeSat ?? 0);
            const l1Fee = Number(quote?.l1BroadcastFeeSat ?? 0);
            const totalFee = serviceFee + l1Fee;
            const feeEl = document.getElementById(`speed-fee-${speed}`);
            if (feeEl) {
                if (totalFee > 0) {
                    feeEl.textContent = `Fee: ${totalFee.toLocaleString()} sats`;
                } else {
                    feeEl.textContent = 'Fee: unavailable';
                }
            }
        }

        updateOnchainPreviewFromSelection();
    } catch (error) {
        showError(error instanceof Error ? error.message : 'Failed to preview on-chain transaction');
    } finally {
        previewBtn.disabled = false;
        previewBtn.textContent = 'Preview On-chain Transaction';
    }
}

function updateOnchainPreviewFromSelection(): void {
    const prepared = onchainPreparedBySpeed[onchainSelectedSpeed];
    const previewDiv = document.getElementById('onchain-payment-preview');
    const sendBtn = document.getElementById('send-onchain-payment-btn') as HTMLButtonElement;

    const address = (document.getElementById('onchain-address-input') as HTMLInputElement)?.value?.trim() || '';
    const amount = parseInt((document.getElementById('onchain-amount-input') as HTMLInputElement)?.value || '0') || 0;

    if (!prepared || !previewDiv || !sendBtn) return;

    const feeQuote = (prepared?.paymentMethod as any)?.feeQuote;
    const speedKey = onchainSelectedSpeed === 'fast' ? 'speedFast' : onchainSelectedSpeed === 'slow' ? 'speedSlow' : 'speedMedium';
    const quote = feeQuote?.[speedKey];
    const serviceFee = Number(quote?.userFeeSat ?? 0);
    const l1Fee = Number(quote?.l1BroadcastFeeSat ?? 0);
    const feeSats = serviceFee + l1Fee;
    const total = amount + feeSats;

    const networkFeeSummary = document.getElementById('onchain-network-fee');
    if (networkFeeSummary) networkFeeSummary.textContent = `${feeSats.toLocaleString()} sats`;

    const recipientEl = document.getElementById('onchain-preview-recipient');
    const amountEl = document.getElementById('onchain-preview-amount');
    const feeEl = document.getElementById('onchain-preview-fee');
    const speedEl = document.getElementById('onchain-preview-speed');
    const totalEl = document.getElementById('onchain-preview-total');

    if (recipientEl) recipientEl.textContent = address;
    if (amountEl) amountEl.textContent = `${amount.toLocaleString()} sats`;
    if (feeEl) feeEl.textContent = `${feeSats.toLocaleString()} sats`;
    if (speedEl) speedEl.textContent = onchainSelectedSpeed[0].toUpperCase() + onchainSelectedSpeed.slice(1);
    if (totalEl) totalEl.textContent = `${total.toLocaleString()} sats`;

    previewDiv.classList.remove('hidden');
    sendBtn.classList.remove('hidden');
    sendBtn.disabled = false;
}

export async function previewPayment(): Promise<void> {
    const paymentInput = document.getElementById('payment-input') as HTMLTextAreaElement;
    const amountInput = document.getElementById('withdrawal-amount') as HTMLInputElement;
    const previewBtn = document.getElementById('preview-payment-btn') as HTMLButtonElement;

    if (!paymentInput) return;

    try {
        if (!breezSDK) {
            showError('Wallet not connected. Please unlock wallet first.');
            return;
        }

        previewBtn.disabled = true;
        previewBtn.textContent = 'Analyzing...';

        const input = paymentInput.value.trim();
        const enteredAmount = amountInput?.value.trim() || '';
        const enteredCurrency = sendInputCurrency;
        
        // Convert amount to sats — SDK always expects integer sats
        let amount: number;
        if (sendInputCurrency !== 'sats' && amountInput && parseFloat(amountInput.value) > 0) {
            // User entered fiat amount — convert to sats
            const converted = await fiatToSats(parseFloat(amountInput.value), sendInputCurrency);
            if (!converted || converted <= 0) {
                showError('Could not convert to sats — rate unavailable. Try again.');
                previewBtn.disabled = false;
                previewBtn.textContent = 'Preview Payment';
                return;
            }
            amount = Math.round(converted); // ensure integer sats
            console.log(`[Withdrawal] Converted ${amountInput.value} ${sendInputCurrency.toUpperCase()} → ${amount} sats`);
        } else {
            // User entered sats directly — must be integer
            amount = amountInput ? Math.round(parseFloat(amountInput.value) || 0) : 0;
        }
        
        const isInvoice = input.toLowerCase().startsWith('lnbc') || input.toLowerCase().startsWith('lntb');

        if (isInvoice) {
            const prepared = await breezSDK.prepareSendPayment({
                paymentRequest: { type: 'input', input },
                amount: amount > 0 ? BigInt(amount) : undefined
            });

            setPreparedPayment(prepared);
            preparedCommentAtPreview = preparedPaymentComment((document.getElementById('withdrawal-comment') as HTMLInputElement | null)?.value);
            const prepFee = prepared.paymentMethod?.type === 'bolt11Invoice' 
                ? Number(prepared.paymentMethod.lightningFeeSats || 0) 
                : 0;
            const invoiceAmount = Number(prepared.amount || 0) || amount || 0;

            // If invoice has a built-in amount, show it in the (disabled) amount field
            if (invoiceAmount > 0 && amountInput) {
                amountInput.value = invoiceAmount.toString();
                amountInput.disabled = true;
                amountInput.placeholder = 'Set by invoice';
            }

            displayPaymentPreview({
                recipient: 'Lightning Payment',
                amount: invoiceAmount,
                fee: prepFee,
                type: 'bolt11',
                prepareResponse: prepared,
                enteredAmount,
                enteredCurrency
            });
        } else {
            let lnurlInput = input;
            if (input.includes('@') && !input.toLowerCase().startsWith('lnurl')) {
                const [username, domain] = input.split('@');
                lnurlInput = `https://${domain}/.well-known/lnurlp/${username}`;
            }

            const parsed = await breezSDK.parse(lnurlInput);
            if (parsed.type !== 'lnurlPay' && parsed.type !== 'lightningAddress') {
                throw new Error(`Unsupported input type: ${parsed.type}`);
            }

            const payRequest = parsed.type === 'lightningAddress' ? parsed.payRequest : parsed;
            if (!amount || amount <= 0) {
                throw new Error('Amount is required for Lightning addresses and LNURL payments');
            }

            const minSendableSats = Math.ceil((payRequest.minSendable || 0) / 1000);
            const maxSendableSats = Math.floor((payRequest.maxSendable || Number.MAX_SAFE_INTEGER) / 1000);

            if (amount < minSendableSats) throw new Error(`Amount must be at least ${minSendableSats} sats`);
            if (amount > maxSendableSats) throw new Error(`Amount cannot exceed ${maxSendableSats} sats`);

            const commentInput = document.getElementById('withdrawal-comment') as HTMLInputElement;
            const comment = nonblankPaymentComment(commentInput?.value);
            const allowed = Number(payRequest.commentAllowed || 0);
            if (commentInput) {
                if (Number.isFinite(allowed) && allowed > 0) {
                    commentInput.maxLength = allowed;
                } else {
                    commentInput.removeAttribute('maxlength');
                }
            }
            if (comment && (!Number.isFinite(allowed) || allowed <= 0)) throw new Error('This recipient does not accept comments. Remove the comment to continue.');
            if (comment && comment.length > allowed) throw new Error(`Comment is too long. This recipient accepts up to ${allowed} characters.`);

            const prepareResponse = await breezSDK.prepareLnurlPay({
                amount: BigInt(amount),
                payRequest,
                comment,
                validateSuccessActionUrl: true
            });

            setPreparedPayment(prepareResponse);
            preparedCommentAtPreview = preparedPaymentComment(comment);
            displayPaymentPreview({
                recipient: input,
                amount,
                fee: prepareResponse.feeSats,
                type: 'lnurl',
                prepareResponse,
                enteredAmount,
                enteredCurrency
            });
        }
    } catch (error) {
        showError(error instanceof Error ? error.message : 'Failed to preview payment');
    } finally {
        previewBtn.disabled = false;
        previewBtn.textContent = 'Preview Payment';
    }
}

export function displayPaymentPreview(previewData: any): void {
    const previewDiv = document.getElementById('payment-preview');
    const sendBtn = document.getElementById('send-payment-btn') as HTMLButtonElement;
    if (!previewDiv || !sendBtn) return;

    const recipientEl = document.getElementById('preview-recipient');
    const amountEl = document.getElementById('preview-amount');
    const feeEl = document.getElementById('preview-fee');
    const totalEl = document.getElementById('preview-total');
    const commentRow = document.getElementById('preview-comment-row');
    const commentEl = document.getElementById('preview-comment');

    if (recipientEl) recipientEl.textContent = previewData.recipient || 'Lightning Payment';
    const total = previewData.amount + previewData.fee;
    setPreviewAmount(amountEl, previewData.amount, previewData.enteredAmount, previewData.enteredCurrency);
    setPreviewAmount(feeEl, previewData.fee);
    setPreviewAmount(totalEl, total);
    const comment = nonblankPaymentComment((document.getElementById('withdrawal-comment') as HTMLInputElement | null)?.value) || '';
    if (commentRow && commentEl) {
        commentEl.textContent = comment;
        commentRow.classList.toggle('hidden', !comment);
    }

    previewDiv.classList.remove('hidden');
    sendBtn.classList.remove('hidden');
    sendBtn.disabled = false;

    if (previewData.type === 'lnurl' && typeof previewData.recipient === 'string') {
        showPreviewSaveContactPrompt(previewData.recipient);
    } else {
        hideSaveContactPrompt();
    }
}

function setPreviewAmount(
    element: HTMLElement | null,
    sats: number,
    enteredAmount?: string,
    enteredCurrency?: DisplayCurrency
): void {
    if (!element) return;

    element.textContent = '';
    const satsEl = document.createElement('span');
    satsEl.className = 'preview-sats';
    satsEl.textContent = `${sats.toLocaleString()} sats`;

    const fiatEl = document.createElement('span');
    fiatEl.className = 'preview-fiat';
    fiatEl.textContent = '≈ ...';

    element.append(satsEl, fiatEl);

    const selectedAmount = enteredCurrency
        ? formatSelectedCurrencyAmount(enteredAmount || '', enteredCurrency, userFiatCurrency)
        : null;
    if (selectedAmount) {
        const selectedEl = document.createElement('span');
        selectedEl.className = 'preview-fiat preview-selected-currency';
        selectedEl.textContent = selectedAmount;
        element.append(selectedEl);
    }

    const currency = userFiatCurrency;

    satsToFiat(sats, currency)
        .then(fiatAmount => {
            if (fiatAmount === null) {
                fiatEl.textContent = 'Fiat unavailable';
                return;
            }
            fiatEl.textContent = `≈ ${formatFiat(fiatAmount, currency)}`;
        })
        .catch(() => {
            fiatEl.textContent = 'Fiat unavailable';
        });
}

export async function sendPayment(): Promise<void> {
    const paymentInput = document.getElementById('payment-input') as HTMLTextAreaElement;
    const sendBtn = document.getElementById('send-payment-btn') as HTMLButtonElement;
    const statusDiv = document.getElementById('withdrawal-status');
    const statusText = document.getElementById('withdrawal-status-text');

    if (!paymentInput || !sendBtn) return;
    if (paymentSendInProgress) return;

    const confirmed = await showConfirmDialog('Confirm Payment', 'Are you sure you want to send this payment? This action cannot be undone.');
    if (!confirmed) return;

    const recipientAtSend = paymentInput.value.trim();
    console.log('[Withdrawal] Recipient captured for post-payment contact prompt', recipientAtSend);

    paymentSendInProgress = true;

    try {
        if (!breezSDK) {
            showError('Wallet not connected. Please unlock wallet first.');
            return;
        }

        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending...';
        hideSaveContactPrompt();

        statusDiv?.classList.remove('hidden');
        if (statusText) statusText.textContent = 'Processing payment...';

        if (!preparedPayment) {
            showError('Please preview payment first');
            return;
        }

        const isLnurlPayment = preparedPayment && 'feeSats' in preparedPayment && 'payRequest' in preparedPayment;
        const commentAtSend = preparedCommentAtPreview;
        let result: any;
        let sendResult: any;

        if (isLnurlPayment) {
            result = await breezSDK.lnurlPay({ prepareResponse: preparedPayment });

            // Validate payment actually succeeded
            console.log('📤 [Withdrawal] lnurlPay response:', JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v).slice(0, 500));
            const lnurlPaymentStatus = result?.payment?.status;
            if (lnurlPaymentStatus) {
                const statusStr = typeof lnurlPaymentStatus === 'string' ? lnurlPaymentStatus : (lnurlPaymentStatus as any)?.tag || '';
                if (/fail|error/i.test(statusStr)) {
                    throw new Error(`Payment failed: ${statusStr}`);
                }
            }

            // Push notification is triggered once after both payment paths (below).
            // Do NOT trigger here — it causes duplicate notifications.
        } else {
            sendResult = await breezSDK.sendPayment({ prepareResponse: preparedPayment });

            // Validate payment actually succeeded
            console.log('📤 [Withdrawal] sendPayment response:', JSON.stringify(sendResult, (_, v) => typeof v === 'bigint' ? v.toString() : v).slice(0, 500));
            const sendPaymentStatus = sendResult?.payment?.status;
            if (sendPaymentStatus) {
                const statusStr = typeof sendPaymentStatus === 'string' ? sendPaymentStatus : sendPaymentStatus?.tag || '';
                if (/fail|error/i.test(statusStr)) {
                    throw new Error(`Payment failed: ${statusStr}`);
                }
            }
        }

        setPreparedPayment(null);
        preparedCommentAtPreview = undefined;

        document.querySelectorAll('.confirm-dialog-overlay').forEach(el => el.remove());

        // Check if the payment is still pending (may not have actually settled)
        const finalStatus = isLnurlPayment
            ? result?.payment?.status
            : sendResult?.payment?.status;
        const isPending = typeof finalStatus === 'string' && finalStatus === 'pending';
        const completedPayment = isLnurlPayment ? result?.payment : sendResult?.payment;
        if (commentAtSend && completedPayment?.id) {
            const wallet = JSON.parse((await chrome.storage.local.get(['multiWalletData'])).multiWalletData || '{}');
            await savePaymentComment(wallet.activeWalletId || null, Number(wallet.activeSubWalletIndex || 0), completedPayment.id, commentAtSend);
        }
        if (isPending) {
            const pendingPayment = isLnurlPayment ? result?.payment : sendResult?.payment;
            const pendingLog = {
                id: pendingPayment?.id,
                status: pendingPayment?.status,
                amountSats: Number(pendingPayment?.amount ?? 0),
                feesSats: Number(pendingPayment?.fees ?? 0),
                method: pendingPayment?.method,
                timestamp: pendingPayment?.timestamp,
            };
            console.warn('⏳ [Withdrawal] Payment returned as pending:\n' + JSON.stringify(pendingLog, null, 2));

            if (statusText) {
                statusText.textContent = '⏳ Payment is processing. Check transaction history for final status.';
                statusText.className = 'status-indicator warning';
            }
            showSuccess('Payment submitted — check history for confirmation.');
        } else {
            if (statusText) {
                statusText.textContent = '✅ Payment sent successfully!';
                statusText.className = 'status-indicator success';
            }
            showSuccess('Payment sent successfully!');
        }
        await callbacks?.updateBalanceDisplay();
        await callbacks?.loadTransactionHistory();

        setTimeout(() => {
            hideWithdrawInterface();
        }, 1500);

        // Retry in case tx doesn't appear immediately
        for (const delayMs of [2000, 5000]) {
            setTimeout(async () => {
                await callbacks?.updateBalanceDisplay();
                await callbacks?.loadTransactionHistory();
            }, delayMs);
        }
    } catch (error) {
        document.querySelectorAll('.confirm-dialog-overlay').forEach(el => el.remove());
        if (statusText) {
            statusText.textContent = `❌ ${error instanceof Error ? error.message : 'Payment failed'}`;
            statusText.className = 'status-indicator error';
        }
        showError(error instanceof Error ? error.message : 'Failed to send payment');
    } finally {
        paymentSendInProgress = false;
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Payment';
        document.querySelectorAll('.confirm-dialog-overlay').forEach(el => el.remove());
    }
}

async function sendOnchainPayment(): Promise<void> {
    const sendBtn = document.getElementById('send-onchain-payment-btn') as HTMLButtonElement;
    const statusDiv = document.getElementById('withdrawal-status');
    const statusText = document.getElementById('withdrawal-status-text');

    const prepared = onchainPreparedBySpeed[onchainSelectedSpeed];
    if (!prepared) {
        showError('Please preview the on-chain transaction first');
        return;
    }

    const confirmed = await showConfirmDialog('Confirm On-chain Transaction', 'Are you sure you want to send this on-chain transaction?');
    if (!confirmed) return;

    try {
        if (!breezSDK) {
            showError('Wallet not connected. Please unlock wallet first.');
            return;
        }

        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending...';

        statusDiv?.classList.remove('hidden');
        if (statusText) statusText.textContent = 'Broadcasting on-chain transaction...';

        await breezSDK.sendPayment({
            prepareResponse: prepared,
            options: {
                type: 'bitcoinAddress',
                confirmationSpeed: onchainSelectedSpeed,
            },
        });

        if (statusText) {
            statusText.textContent = '✅ On-chain transaction sent successfully!';
            statusText.className = 'status-indicator success';
        }

        showSuccess('On-chain transaction sent successfully!');
        await callbacks?.updateBalanceDisplay();
        // Return to main view first, then keep refreshing tx list
        setTimeout(() => hideWithdrawInterface(), 1500);
        // Retry tx list multiple times — SDK may not return the on-chain tx immediately
        for (const delayMs of [500, 2000, 5000, 10000]) {
            setTimeout(async () => {
                await callbacks?.updateBalanceDisplay();
                await callbacks?.loadTransactionHistory();
            }, delayMs);
        }
    } catch (error) {
        if (statusText) {
            statusText.textContent = `❌ ${error instanceof Error ? error.message : 'Transaction failed'}`;
            statusText.className = 'status-indicator error';
        }
        showError(error instanceof Error ? error.message : 'Failed to send on-chain transaction');
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
    }
}
