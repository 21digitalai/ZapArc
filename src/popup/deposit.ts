// Deposit Interface
// Handles Lightning invoice generation + on-chain address generation

import * as QRCode from 'qrcode';
import {
    breezSDK,
    paymentMonitoringInterval,
    setPaymentMonitoringInterval,
    invoiceExpiryTime,
    setInvoiceExpiryTime
} from './state';
import { showError, showSuccess } from './notifications';
import { showModal } from './modals';
import {
    fiatToSats,
    satsToFiat,
    formatFiat,
    formatSelectedCurrencyAmount,
    getBtcSpotPrice,
    type FiatCurrency
} from '../utils/currency';
import { getUserFiatCurrency } from './currency-pref';
import { classifyClaimError, getClaimKey, upsertProvisionalClaim, type ClaimRow } from './onchain-claim-lifecycle';
import { ExtensionMessaging } from '../utils/messaging';
import { DEFAULT_INVOICE_EXPIRY_SECS, getBolt11ExpiryTime } from '../utils/invoice-expiry';

type ReceiveInputCurrency = 'sats' | FiatCurrency;

let receiveInputCurrency: ReceiveInputCurrency = 'sats';
let receiveDefaultFiat: FiatCurrency = 'usd';
const RECEIVE_INPUT_CURRENCY_KEY = 'receive_input_currency';

async function loadReceiveCurrencySetting(): Promise<void> {
    receiveDefaultFiat = await getUserFiatCurrency();
    try {
        const stored = await chrome.storage.local.get([RECEIVE_INPUT_CURRENCY_KEY]);
        const value = stored?.[RECEIVE_INPUT_CURRENCY_KEY];
        receiveInputCurrency = value === 'usd' || value === 'eur' || value === 'sats'
            ? value
            : 'sats';
    } catch (error) {
        console.warn('[Deposit] Failed to load receive currency preference:', error);
        receiveInputCurrency = 'sats';
    }
    updateReceiveCurrencyUI();
}

async function persistReceiveCurrencySetting(currency: ReceiveInputCurrency): Promise<void> {
    try {
        await chrome.storage.local.set({ [RECEIVE_INPUT_CURRENCY_KEY]: currency });
    } catch (error) {
        console.warn('[Deposit] Failed to save receive currency preference:', error);
    }
}

function updateReceiveCurrencyUI(): void {
    const select = document.getElementById('receive-currency-select') as HTMLSelectElement | null;
    const amountInput = document.getElementById('deposit-amount') as HTMLInputElement | null;
    if (select) select.value = receiveInputCurrency;
    if (amountInput) {
        amountInput.placeholder = receiveInputCurrency === 'sats'
            ? 'Amount in sats'
            : `Amount in ${receiveInputCurrency.toUpperCase()}`;
        amountInput.step = receiveInputCurrency === 'sats' ? '1' : '0.01';
        amountInput.min = receiveInputCurrency === 'sats' ? '1' : '0.01';
        if (receiveInputCurrency === 'sats') amountInput.max = '100000000';
        else amountInput.removeAttribute('max');
    }

    const presets = receiveInputCurrency === 'sats'
        ? [10000, 50000, 100000, 500000]
        : [10, 25, 50, 100];
    document.querySelectorAll<HTMLElement>('.quick-amount-btn').forEach((button, index) => {
        const value = presets[index];
        if (value === undefined) return;
        button.dataset.amount = String(value);
        button.textContent = receiveInputCurrency === 'sats' ? `${value / 1000}K` : String(value);
        button.classList.remove('selected');
    });
}

async function receiveAmountToSats(amount: number): Promise<number | null> {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (receiveInputCurrency === 'sats') return Math.round(amount);
    return fiatToSats(amount, receiveInputCurrency);
}

function updateDepositEstimate(amount: number): void {
    const row = document.getElementById('deposit-estimate-row');
    const valueEl = document.getElementById('deposit-estimate-value');
    const generateBtn = document.getElementById('generate-invoice-btn') as HTMLButtonElement;
    if (generateBtn) generateBtn.disabled = !amount || amount <= 0;
    if (!row || !valueEl) return;
    if (!amount || amount <= 0) {
        row.classList.add('hidden');
        return;
    }

    // Show loading state while fetching rate
    valueEl.textContent = '≈ ...';
    row.classList.remove('hidden');

    // Use the shared currency display selection
    (async () => {
        const sats = await receiveAmountToSats(amount);
        if (!sats) {
            valueEl.textContent = '≈ rate unavailable';
            return;
        }

        const spotCurrency = receiveInputCurrency === 'sats' ? receiveDefaultFiat : receiveInputCurrency;
        const [defaultFiatAmount, spotPrice] = await Promise.all([
            satsToFiat(sats, receiveDefaultFiat),
            getBtcSpotPrice(spotCurrency),
        ]);
        const lines: string[] = [];
        if (receiveInputCurrency === 'sats') {
            if (defaultFiatAmount !== null) lines.push(`≈ ${formatFiat(defaultFiatAmount, receiveDefaultFiat)}`);
        } else {
            lines.push(`= ${sats.toLocaleString()} sats`);
            if (receiveInputCurrency !== receiveDefaultFiat && defaultFiatAmount !== null) {
                lines.push(`≈ ${formatFiat(defaultFiatAmount, receiveDefaultFiat)} ${receiveDefaultFiat.toUpperCase()}`);
            }
        }
        if (spotPrice) lines.push(spotPrice);
        valueEl.textContent = lines.join('\n') || '≈ rate unavailable';
        row.classList.remove('hidden');
    })();
}

export type DepositCallbacks = {
    updateBalanceDisplay: () => Promise<void>;
    loadTransactionHistory: () => Promise<void>;
    onPaymentReceived?: () => Promise<void>;
    getLightningAddress?: () => string | null;
};

let callbacks: DepositCallbacks | null = null;
let currentMonitoredInvoice: string | null = null;
let depositListenersInitialized = false;
let depositTab: 'lightning' | 'onchain' = 'lightning';
let onchainDepositPollingInterval: ReturnType<typeof setInterval> | null = null;
const claimedOnchainDeposits = new Set<string>();

export function setDepositCallbacks(cb: DepositCallbacks): void {
    callbacks = cb;
}

async function drawBrandedQR(canvas: HTMLCanvasElement, value: string, width: number): Promise<void> {
    await QRCode.toCanvas(canvas, value, {
        width,
        margin: 2,
        errorCorrectionLevel: 'H',
        color: { dark: '#000000', light: '#FFFFFF' }
    });

    const context = canvas.getContext('2d');
    if (!context) return;

    const logo = new Image();
    logo.src = chrome.runtime.getURL('icons/qr-brand-logo.png');
    await new Promise<void>((resolve) => {
        logo.onload = () => {
            // Long BOLT11 invoices produce much denser QR matrices. A logo
            // covering 30% of the canvas destroys too many contiguous modules
            // even with H-level error correction, so keep the branded overlay
            // deliberately small and give it a clean white isolation plate.
            const isDensePayload = value.length > 180;
            const logoRatio = isDensePayload ? 0.14 : 0.18;
            const plateRatio = isDensePayload ? 0.18 : 0.22;
            const plateSize = Math.round(canvas.width * plateRatio);
            const plateX = Math.round((canvas.width - plateSize) / 2);
            const plateY = Math.round((canvas.height - plateSize) / 2);
            context.fillStyle = '#FFFFFF';
            context.fillRect(plateX, plateY, plateSize, plateSize);

            const logoSize = Math.round(canvas.width * logoRatio);
            const logoX = Math.round((canvas.width - logoSize) / 2);
            const logoY = Math.round((canvas.height - logoSize) / 2);
            context.drawImage(logo, logoX, logoY, logoSize, logoSize);
            resolve();
        };
        logo.onerror = () => resolve();
    });
}

async function drawLightningAddressQR(canvas: HTMLCanvasElement, address: string): Promise<void> {
    await drawBrandedQR(canvas, address, 168);
}

async function renderReceiveLightningAddress(): Promise<void> {
    const card = document.getElementById('receive-lightning-address-card');
    const text = document.getElementById('receive-lightning-address-text') as HTMLInputElement | null;
    const canvas = document.getElementById('receive-lightning-address-qr') as HTMLCanvasElement | null;
    const address = callbacks?.getLightningAddress?.()?.trim() || '';

    if (!card || !text || !canvas || !address) {
        card?.classList.add('hidden');
        if (text) text.value = '';
        return;
    }

    text.value = address;
    try {
        await drawLightningAddressQR(canvas, address);
        card.classList.remove('hidden');
    } catch (error) {
        console.warn('[Deposit] Failed to render Lightning Address QR:', error);
        card.classList.add('hidden');
    }
}

export function setCurrentMonitoredInvoice(invoice: string | null): void {
    currentMonitoredInvoice = invoice;
}

export async function handlePaymentReceivedFromSDK(): Promise<void> {
    console.log('[Deposit] Payment received event from SDK - checking immediately');
    if (currentMonitoredInvoice) {
        await checkPaymentStatus(currentMonitoredInvoice);
    }
}

function stopOnchainDepositPolling(): void {
    if (onchainDepositPollingInterval) {
        clearInterval(onchainDepositPollingInterval);
        onchainDepositPollingInterval = null;
    }
}

function setOnchainDepositStatus(message: string): void {
    const statusEl = document.getElementById('onchain-deposit-status');
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.remove('hidden');
}

const depositClaimResults = new Map<string, ClaimRow>();

async function updateClaimRow(row: ClaimRow): Promise<void> {
    depositClaimResults.set(row.key, row);
    upsertProvisionalClaim(row);
    renderPendingDeposits();
    await callbacks?.loadTransactionHistory();
}


function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function showPendingDepositDetail(key: string): void {
    const deposit = depositClaimResults.get(key);
    if (!deposit) return;

    const content = document.getElementById('tx-detail-content');
    if (!content) return;

    const statusLabel = deposit.status === 'claiming'
        ? 'Claiming'
        : deposit.status === 'claimed'
            ? 'Claimed'
                : deposit.status === 'retrying'
                    ? 'Retrying'
                    : deposit.status === 'too-small'
                ? 'Too small'
                : 'Confirming';

    const failureRow = deposit.message
        ? `<div class="tx-detail-row">
                <span class="tx-detail-label">Failure reason</span>
                <span class="tx-detail-value">${escapeHtml(deposit.message)}</span>
            </div>`
        : '';

    content.innerHTML = `
        <div class="tx-detail-amount-section">
            <div class="tx-detail-amount positive">${deposit.amountSats.toLocaleString()} sats</div>
            <div class="tx-detail-status ${deposit.status === 'too-small' ? 'pending' : deposit.status === 'claimed' ? 'completed' : 'pending'}">${statusLabel}</div>
        </div>
        <div class="tx-detail-rows">
            <div class="tx-detail-row">
                <span class="tx-detail-label">Transaction ID</span>
                <span class="tx-detail-value">${escapeHtml(deposit.txid)}</span>
            </div>
            ${deposit.confirmations !== undefined ? `<div class="tx-detail-row"><span class="tx-detail-label">Confirmations</span><span class="tx-detail-value">${deposit.confirmations}/${deposit.requiredConfirmations || 3}</span></div>` : ''}
            ${failureRow}
        </div>`;

    showModal('transaction-detail-modal');
}

function renderPendingDeposits(): void {
    const section = document.getElementById('pending-deposits-section');
    const list = document.getElementById('pending-deposits-list');
    if (!section || !list) return;

    // Only show deposits from last 5 days
    const entries = Array.from(depositClaimResults.entries());
    if (entries.length === 0) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    list.innerHTML = entries.map(([key, d]) => {
        let statusText = '';
        let statusClass = '';
        switch (d.status) {
            case 'claiming':
                statusText = '⏳ Claiming...';
                statusClass = 'claiming';
                break;
            case 'claimed':
                statusText = '✅ Claimed';
                statusClass = 'claimed';
                break;
            case 'retrying':
                statusText = '⏳ Retrying';
                statusClass = 'claiming';
                break;
            case 'too-small':
                statusText = '⚠️ Too small to claim';
                statusClass = 'too-small';
                break;
            default:
                statusText = d.confirmations !== undefined ? `⏳ Confirming ${d.confirmations}/${d.requiredConfirmations || 3}` : '⏳ Confirming';
                statusClass = 'claiming';
        }
        const shortTxid = `${d.txid.slice(0, 8)}…${d.txid.slice(-6)}`;
        return `<div class="pending-deposit-item" data-deposit-key="${key}" role="button" tabindex="0" title="Tap for details">
            <div>
                <span class="deposit-amount">${d.amountSats.toLocaleString()} sats</span>
                <span style="color: var(--text-secondary); font-size: 10px; margin-left: 6px">${shortTxid}</span>
            </div>
            <span class="deposit-status ${statusClass}">${statusText}</span>
        </div>`;
    }).join('');

    list.querySelectorAll('.pending-deposit-item').forEach((item) => {
        const key = item.getAttribute('data-deposit-key');
        if (!key) return;

        item.addEventListener('click', () => showPendingDepositDetail(key));
        item.addEventListener('keydown', (e) => {
            const k = (e as KeyboardEvent).key;
            if (k === 'Enter' || k === ' ') {
                e.preventDefault();
                showPendingDepositDetail(key);
            }
        });
    });

}

async function checkAndClaimOnchainDeposits(): Promise<void> {
    if (!breezSDK || depositTab !== 'onchain') return;

    try {
        const response = await breezSDK.listUnclaimedDeposits({});
        const deposits = response?.deposits || [];

        // Hide old status indicator
        const statusEl = document.getElementById('onchain-deposit-status');
        if (statusEl) statusEl.classList.add('hidden');

        for (const deposit of deposits) {
            const depositInfo = deposit as typeof deposit & { isMature?: boolean; confirmations?: number };
            const key = getClaimKey(deposit.txid, deposit.vout);
            if (claimedOnchainDeposits.has(key)) continue;

            await updateClaimRow({
                key,
                status: depositInfo.isMature === false ? 'confirming' : 'claiming',
                amountSats: deposit.amountSats,
                txid: deposit.txid,
                vout: deposit.vout,
                confirmations: typeof depositInfo.confirmations === 'number' ? depositInfo.confirmations : undefined,
                requiredConfirmations: 3,
            });

            if (depositInfo.isMature === false) continue;

            try {
                await breezSDK.claimDeposit({
                    txid: deposit.txid,
                    vout: deposit.vout,
                    maxFee: { type: 'networkRecommended', leewaySatPerVbyte: 2 }
                });
                claimedOnchainDeposits.add(key);
                await updateClaimRow({ key, status: 'claimed', amountSats: deposit.amountSats, txid: deposit.txid, vout: deposit.vout });
                await callbacks?.updateBalanceDisplay();
                await callbacks?.loadTransactionHistory();
                showSuccess(`Receive of ${deposit.amountSats.toLocaleString()} sats claimed!`);

                // Remove claimed item after 5 seconds
                setTimeout(() => {
                    depositClaimResults.delete(key);
                    renderPendingDeposits();
                }, 5000);
            } catch (claimError) {
                const claimResult = classifyClaimError(claimError, Number(deposit.amountSats));
                console.warn(`[Deposit] Failed to claim ${key}:`, claimError);
                await updateClaimRow({
                    key,
                    status: claimResult.status,
                    amountSats: deposit.amountSats,
                    txid: deposit.txid,
                    vout: deposit.vout,
                    confirmations: typeof depositInfo.confirmations === 'number' ? depositInfo.confirmations : undefined,
                    requiredConfirmations: 3,
                    message: claimResult.message,
                });
            }
        }

        // If no deposits at all, clear the section
        if (deposits.length === 0 && depositClaimResults.size === 0) {
            const section = document.getElementById('pending-deposits-section');
            if (section) section.classList.add('hidden');
        }
    } catch (error) {
        console.warn('[Deposit] Failed to poll/claim on-chain deposits:', error);
    }
}

function startOnchainDepositPolling(): void {
    stopOnchainDepositPolling();
    void checkAndClaimOnchainDeposits();
    onchainDepositPollingInterval = setInterval(() => {
        void checkAndClaimOnchainDeposits();
    }, 15000);
}

export function showDepositInterface(): void {
    const mainInterface = document.getElementById('main-interface');
    const depositInterface = document.getElementById('deposit-interface');

    mainInterface?.classList.add('hidden');
    depositInterface?.classList.remove('hidden');

    showDepositTab('lightning');
    showDepositStep('deposit-amount-step');

    const amountInput = document.getElementById('deposit-amount') as HTMLInputElement;
    if (amountInput) amountInput.value = '';

    void loadReceiveCurrencySetting();
    void renderReceiveLightningAddress();

    setupDepositListeners();
}

export function hideDepositInterface(): void {
    if (paymentMonitoringInterval) {
        clearInterval(paymentMonitoringInterval);
        setPaymentMonitoringInterval(null);
    }
    stopOnchainDepositPolling();

    setCurrentMonitoredInvoice(null);

    const depositInterface = document.getElementById('deposit-interface');
    const mainInterface = document.getElementById('main-interface');

    depositInterface?.classList.add('hidden');
    mainInterface?.classList.remove('hidden');

    const amountInput = document.getElementById('deposit-amount') as HTMLInputElement;
    if (amountInput) amountInput.value = '';

    showDepositStep('deposit-amount-step');
    showDepositTab('lightning');
}

function showDepositTab(tab: 'lightning' | 'onchain'): void {
    depositTab = tab;

    const lightningBtn = document.getElementById('deposit-tab-lightning');
    const onchainBtn = document.getElementById('deposit-tab-onchain');
    const lightningContent = document.getElementById('deposit-lightning-content');
    const onchainContent = document.getElementById('deposit-onchain-content');

    lightningBtn?.classList.toggle('active', tab === 'lightning');
    onchainBtn?.classList.toggle('active', tab === 'onchain');
    lightningContent?.classList.toggle('hidden', tab !== 'lightning');
    onchainContent?.classList.toggle('hidden', tab !== 'onchain');

    if (tab === 'onchain') {
        void generateOnchainAddress();
    } else {
        stopOnchainDepositPolling();
    }
}

async function generateOnchainAddress(): Promise<void> {
    const loadingEl = document.getElementById('onchain-address-loading');
    const addressEl = document.getElementById('onchain-address-display');
    const copyBtn = document.getElementById('copy-onchain-address-btn') as HTMLButtonElement | null;
    const minDepositNoteEl = document.getElementById('onchain-min-deposit-note');
    const confNoteEl = document.getElementById('onchain-confirmation-note');
    const onchainQrContainer = document.getElementById('onchain-qr-container');
    const onchainQrCanvas = document.getElementById('onchain-qr-canvas') as HTMLCanvasElement | null;

    if (!loadingEl || !addressEl || !copyBtn) return;

    loadingEl.classList.remove('hidden');
    addressEl.classList.add('hidden');
    copyBtn.classList.add('hidden');
    onchainQrContainer?.classList.add('hidden');
    addressEl.textContent = '';
    setOnchainDepositStatus('Waiting for on-chain receive...');

    try {
        if (!breezSDK) {
            throw new Error('Wallet not connected. Please unlock your wallet first.');
        }

        const response = await breezSDK.receivePayment({
            paymentMethod: { type: 'bitcoinAddress' }
        } as any);

        const address = (response as any)?.paymentRequest || (response as any)?.bitcoinAddress || (response as any)?.address;
        if (!address) {
            throw new Error('Failed to generate Bitcoin address');
        }

        // Calculate minimum deposit from recommended fees
        // Dust limit is 546 sats; claim tx is ~140 vBytes; need amount > dust + claim fee
        let minDepositSats = (response as any)?.paymentMethod?.minAmountSats || (response as any)?.minAmountSats;
        if (!minDepositSats && breezSDK) {
            try {
                const fees = await breezSDK.recommendedFees();
                const claimFee = (fees.halfHourFee || 5) * 140; // ~140 vBytes for claim tx
                minDepositSats = 546 + claimFee + 200; // dust + fee + safety margin
            } catch { /* ignore */ }
        }
        if (!minDepositSats || minDepositSats < 1000) minDepositSats = 1000; // absolute minimum
        if (minDepositNoteEl) {
            minDepositNoteEl.textContent = `⚠️ Minimum receive: ${Number(minDepositSats).toLocaleString()} sats. Smaller amounts cannot be claimed due to network fees.`;
        }
        if (confNoteEl) {
            confNoteEl.textContent = 'It may take 1-3 confirmations before funds appear.';
        }

        addressEl.textContent = address;
        addressEl.classList.remove('hidden');
        copyBtn.classList.remove('hidden');

        // Render QR for easier scanning from another wallet/device
        if (onchainQrCanvas) {
            try {
                await drawBrandedQR(onchainQrCanvas, `bitcoin:${address}`, 200);
                onchainQrContainer?.classList.remove('hidden');
            } catch (qrError) {
                console.warn('Failed to generate on-chain QR code:', qrError);
                onchainQrContainer?.classList.add('hidden');
            }
        }

        startOnchainDepositPolling();
    } catch (error) {
        showError(error instanceof Error ? error.message : 'Failed to generate Bitcoin address');
    } finally {
        loadingEl.classList.add('hidden');
    }
}

export function setupDepositListeners(): void {
    if (depositListenersInitialized) return;
    depositListenersInitialized = true;

    const backBtn = document.getElementById('deposit-back-btn');
    if (backBtn) backBtn.onclick = () => hideDepositInterface();

    const tabLightning = document.getElementById('deposit-tab-lightning');
    const tabOnchain = document.getElementById('deposit-tab-onchain');
    tabLightning?.addEventListener('click', () => showDepositTab('lightning'));
    tabOnchain?.addEventListener('click', () => showDepositTab('onchain'));

    const depositAmount = document.getElementById('deposit-amount') as HTMLInputElement;
    const generateBtn = document.getElementById('generate-invoice-btn') as HTMLButtonElement;
    const currencySelect = document.getElementById('receive-currency-select') as HTMLSelectElement | null;
    const copyBtn = document.getElementById('copy-invoice-btn');
    const saveInvoiceQrBtn = document.getElementById('save-invoice-qr-btn');
    const newInvoiceBtn = document.getElementById('new-invoice-btn');
    const addressCopyBtn = document.getElementById('receive-lightning-address-copy');
    const addressSaveBtn = document.getElementById('receive-lightning-address-save');

    addressCopyBtn?.addEventListener('click', async () => {
        const address = callbacks?.getLightningAddress?.()?.trim();
        if (!address) return;
        try {
            await navigator.clipboard.writeText(address);
            showSuccess('Lightning Address copied');
        } catch {
            showError('Could not copy Lightning Address');
        }
    });

    addressSaveBtn?.addEventListener('click', () => {
        const canvas = document.getElementById('receive-lightning-address-qr') as HTMLCanvasElement | null;
        const address = callbacks?.getLightningAddress?.()?.trim();
        if (!canvas || !address) return;
        const link = document.createElement('a');
        link.download = `zaparc-${address.replace(/[^a-z0-9_-]+/gi, '-')}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
        showSuccess('Lightning Address QR saved');
    });

    document.querySelectorAll('.quick-amount-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            const amount = target.dataset.amount;
            if (depositAmount && amount) {
                depositAmount.value = amount;
                if (generateBtn) generateBtn.disabled = false;
                // Update selected state
                document.querySelectorAll('.quick-amount-btn').forEach(b => b.classList.remove('selected'));
                target.classList.add('selected');
                // Update estimate
                updateDepositEstimate(parseFloat(amount));
            }
        });
    });

    if (depositAmount) {
        depositAmount.addEventListener('input', () => {
            const amount = parseFloat(depositAmount.value);
            // Clear quick amount selection
            document.querySelectorAll('.quick-amount-btn').forEach(b => b.classList.remove('selected'));
            updateDepositEstimate(amount);
        });
    }

    currencySelect?.addEventListener('change', () => {
        const nextCurrency = currencySelect.value as ReceiveInputCurrency;
        if (nextCurrency !== 'sats' && nextCurrency !== 'usd' && nextCurrency !== 'eur') return;
        receiveInputCurrency = nextCurrency;
        void persistReceiveCurrencySetting(nextCurrency);
        if (depositAmount) depositAmount.value = '';
        updateReceiveCurrencyUI();
        updateDepositEstimate(0);
    });

    generateBtn?.addEventListener('click', async () => {
        const enteredAmount = parseFloat(depositAmount.value);
        const amountSats = await receiveAmountToSats(enteredAmount);
        if (amountSats && amountSats > 0) await generateDepositInvoice(amountSats);
    });

    copyBtn?.addEventListener('click', () => {
        const invoiceText = document.getElementById('invoice-text') as HTMLTextAreaElement;
        if (invoiceText) {
            navigator.clipboard.writeText(invoiceText.value);
            showSuccess('Invoice copied to clipboard!');
        }
    });

    saveInvoiceQrBtn?.addEventListener('click', () => {
        const canvas = document.getElementById('deposit-qr-canvas') as HTMLCanvasElement | null;
        if (!canvas || canvas.width === 0 || canvas.height === 0) {
            showError('Invoice QR is not ready yet');
            return;
        }
        const link = document.createElement('a');
        link.download = `zaparc-lightning-invoice-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
        showSuccess('Invoice QR image saved');
    });

    newInvoiceBtn?.addEventListener('click', () => showDepositStep('deposit-amount-step'));

    const onchainCopyBtn = document.getElementById('copy-onchain-address-btn');
    onchainCopyBtn?.addEventListener('click', async () => {
        const address = document.getElementById('onchain-address-display')?.textContent?.trim();
        if (!address) return;
        await navigator.clipboard.writeText(address);
        showSuccess('Bitcoin address copied to clipboard!');
    });
}

export async function generateDepositInvoice(amount: number): Promise<void> {
    const generateBtn = document.getElementById('generate-invoice-btn') as HTMLButtonElement;

    try {
        if (generateBtn) {
            generateBtn.disabled = true;
            generateBtn.textContent = 'Generating...';
        }

        if (!breezSDK) {
            showError('Wallet not connected. Please unlock your wallet first.');
            return;
        }

        const settingsResponse = await ExtensionMessaging.getUserSettings();
        const expirySecs = settingsResponse.success && settingsResponse.data ? settingsResponse.data.invoiceExpirySecs : DEFAULT_INVOICE_EXPIRY_SECS;
        const description = `Receive ${amount.toLocaleString()} sats in ZapArc Wallet`;
        const response = await breezSDK.receivePayment({
            paymentMethod: {
                type: 'bolt11Invoice',
                description,
                amountSats: amount,
                expirySecs
            }
        });

        const invoice = response.paymentRequest;
        await displayInvoice(invoice, amount);
        showDepositStep('deposit-invoice-step');
        startPaymentMonitoring(invoice, expirySecs);
    } catch (error) {
        showError(error instanceof Error ? error.message : 'Failed to generate invoice');
    } finally {
        if (generateBtn) {
            generateBtn.disabled = false;
            generateBtn.textContent = 'Generate Invoice';
        }
    }
}

export async function displayInvoice(invoice: string, amount: number): Promise<void> {
    const amountDisplay = document.getElementById('invoice-amount-display');
    if (amountDisplay) amountDisplay.textContent = amount.toLocaleString();

    const amountContext = document.getElementById('invoice-amount-context');
    if (amountContext) {
        const enteredAmount = (document.getElementById('deposit-amount') as HTMLInputElement | null)?.value.trim() || '';
        const spotCurrency = receiveInputCurrency === 'sats' ? receiveDefaultFiat : receiveInputCurrency;
        const [defaultFiatAmount, spotPrice] = await Promise.all([
            satsToFiat(amount, receiveDefaultFiat),
            getBtcSpotPrice(spotCurrency),
        ]);
        const lines: string[] = [];
        if (defaultFiatAmount !== null) {
            lines.push(`≈ ${formatFiat(defaultFiatAmount, receiveDefaultFiat)} ${receiveDefaultFiat.toUpperCase()}`);
        }
        const selectedAmount = formatSelectedCurrencyAmount(
            enteredAmount,
            receiveInputCurrency,
            receiveDefaultFiat
        );
        if (selectedAmount) lines.push(selectedAmount);
        if (spotPrice) lines.push(spotPrice);

        amountContext.textContent = lines.join('\n');
        amountContext.classList.toggle('hidden', lines.length === 0);
    }

    const invoiceText = document.getElementById('invoice-text') as HTMLTextAreaElement;
    if (invoiceText) invoiceText.value = invoice;

    const qrCanvas = document.getElementById('deposit-qr-canvas') as HTMLCanvasElement;
    if (qrCanvas) {
        try {
            // Preserve the proven pre-branding invoice settings. H-level error
            // correction makes long BOLT11 payloads substantially denser at
            // this canvas size and some mobile scanners cannot resolve the
            // resulting tiny modules. The qrcode default (M) scanned reliably.
            await QRCode.toCanvas(qrCanvas, invoice, {
                width: 200,
                margin: 2,
                color: { dark: '#000000', light: '#FFFFFF' }
            });
        } catch (error) {
            console.error('QR code generation error:', error);
            qrCanvas.style.display = 'none';
        }
    }
}

export function showDepositStep(stepId: string): void {
    const steps = ['deposit-amount-step', 'deposit-invoice-step'];
    steps.forEach(id => {
        const element = document.getElementById(id);
        if (element) element.classList.toggle('hidden', id !== stepId);
    });
}

export function startPaymentMonitoring(invoice: string, fallbackExpirySecs: number = DEFAULT_INVOICE_EXPIRY_SECS): void {
    setCurrentMonitoredInvoice(invoice);
    setInvoiceExpiryTime(getBolt11ExpiryTime(invoice, fallbackExpirySecs));

    if (paymentMonitoringInterval) clearInterval(paymentMonitoringInterval);

    const interval = setInterval(async () => {
        await checkPaymentStatus(invoice);
        updateInvoiceTimer();
    }, 2000);

    setPaymentMonitoringInterval(interval);
    void checkPaymentStatus(invoice);
}

export async function checkPaymentStatus(invoice: string): Promise<void> {
    try {
        if (!breezSDK) return;

        const response = await breezSDK.listPayments({});
        const payments = response?.payments || [];

        const matchingPayment = payments.find((p: any) => {
            if (p.paymentType !== 'receive') return false;
            const paymentInvoice = p.details?.bolt11 || p.details?.invoice || '';
            return paymentInvoice.includes(invoice.substring(0, 30));
        });

        if (matchingPayment) {
            const amountSats = Number(matchingPayment.amount || 0);
            showSuccess(`Received ${amountSats.toLocaleString()} sats!`);

            if (paymentMonitoringInterval) {
                clearInterval(paymentMonitoringInterval);
                setPaymentMonitoringInterval(null);
            }

            await callbacks?.updateBalanceDisplay();
            await callbacks?.loadTransactionHistory();
            hideDepositInterface();
        }
    } catch (error) {
        console.error('Payment status check error:', error);
    }
}

export function updateInvoiceTimer(): void {
    const timerElement = document.getElementById('invoice-timer');
    if (!timerElement) return;

    const remaining = Math.max(0, invoiceExpiryTime - Date.now());
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);

    timerElement.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;

    if (remaining <= 0) handlePaymentExpired();
}

export function handlePaymentReceived(): void {
    if (paymentMonitoringInterval) {
        clearInterval(paymentMonitoringInterval);
        setPaymentMonitoringInterval(null);
    }

    const statusIndicator = document.querySelector('.status-indicator');
    if (statusIndicator) {
        statusIndicator.textContent = '✅ Payment received!';
        statusIndicator.className = 'status-indicator success';
    }

    const timerElement = document.getElementById('invoice-timer');
    if (timerElement) timerElement.textContent = 'Completed';

    callbacks?.updateBalanceDisplay();
    showSuccess('Receive completed successfully!');

    setTimeout(() => hideDepositInterface(), 3000);
}

export function handlePaymentExpired(): void {
    if (paymentMonitoringInterval) {
        clearInterval(paymentMonitoringInterval);
        setPaymentMonitoringInterval(null);
    }

    const statusIndicator = document.querySelector('.status-indicator');
    if (statusIndicator) {
        statusIndicator.textContent = '⏰ Invoice expired';
        statusIndicator.className = 'status-indicator expired';
    }
}
