// Settings page for ZapArc Extension

import './settings.css';
import { UserSettings } from '../types';
import { ExtensionMessaging } from '../utils/messaging';
import { DEFAULT_INVOICE_EXPIRY_SECS, customMinutesToExpirySecs, isInvoiceExpiryPreset } from '../utils/invoice-expiry';

console.log('ZapArc settings page loaded');

// DOM elements
let currentSettings: UserSettings;

// Initialize settings page
document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    setupEventListeners();
});

async function loadSettings(): Promise<void> {
    try {
        console.log('Loading settings...');
        const response = await ExtensionMessaging.getUserSettings();
        console.log('Settings response:', response);
        
        currentSettings = (response.success && response.data) ? response.data : getDefaultSettings();
        console.log('Current settings:', currentSettings);
        
        // Populate form with current settings
        populateForm();
    } catch (error) {
        console.error('Failed to load settings:', error);
        currentSettings = getDefaultSettings();
        populateForm();
    }
}

function getDefaultSettings(): UserSettings {
    return {
        useBuiltInWallet: true,
        floatingMenuEnabled: true,
        autoLockTimeout: 900,
        customLNURL: undefined,
        facebookPostingMode: 'global',
        allowedFacebookGroups: [],
        deniedFacebookGroups: [],
        fiatCurrency: 'usd',
        invoiceExpirySecs: DEFAULT_INVOICE_EXPIRY_SECS
    };
}

function populateForm(): void {
    // Wallet type
    const builtinRadio = document.getElementById('builtin-wallet') as HTMLInputElement;
    const customRadio = document.getElementById('custom-wallet') as HTMLInputElement;
    const customLnurlInput = document.getElementById('custom-lnurl') as HTMLInputElement;
    
    if (currentSettings.useBuiltInWallet) {
        builtinRadio.checked = true;
        customLnurlInput.disabled = true;
    } else {
        customRadio.checked = true;
        customLnurlInput.disabled = false;
    }
    
    if (currentSettings.customLNURL) {
        customLnurlInput.value = currentSettings.customLNURL;
    }
    
    // UI settings
    (document.getElementById('floating-menu-enabled') as HTMLInputElement).checked = currentSettings.floatingMenuEnabled;
    (document.getElementById('autolock-timeout') as HTMLSelectElement).value = currentSettings.autoLockTimeout.toString();
    (document.getElementById('fiat-currency') as HTMLSelectElement).value = currentSettings.fiatCurrency || 'usd';
    const expiry = currentSettings.invoiceExpirySecs || DEFAULT_INVOICE_EXPIRY_SECS;
    (document.getElementById('invoice-expiry') as HTMLSelectElement).value = isInvoiceExpiryPreset(expiry) ? String(expiry) : 'custom';
    (document.getElementById('invoice-expiry-custom') as HTMLInputElement).value = isInvoiceExpiryPreset(expiry) ? '' : String(Math.round(expiry / 60));
}

function setupEventListeners(): void {
    // Wallet type radio buttons
    const builtinRadio = document.getElementById('builtin-wallet') as HTMLInputElement;
    const customRadio = document.getElementById('custom-wallet') as HTMLInputElement;
    const customLnurlInput = document.getElementById('custom-lnurl') as HTMLInputElement;
    
    builtinRadio.addEventListener('change', () => {
        customLnurlInput.disabled = true;
        customLnurlInput.value = '';
        customLnurlInput.classList.remove('error');
    });
    
    customRadio.addEventListener('change', () => {
        customLnurlInput.disabled = false;
        customLnurlInput.focus();
    });
    
    // Real-time LNURL validation
    customLnurlInput.addEventListener('input', () => {
        const value = customLnurlInput.value.trim();
        if (value && !customRadio.checked) return; // Only validate if custom wallet is selected
        
        if (value && !isValidLNURL(value)) {
            customLnurlInput.classList.add('error');
            customLnurlInput.title = 'Invalid LNURL format';
        } else {
            customLnurlInput.classList.remove('error');
            customLnurlInput.title = '';
        }
    });
    
    // Save settings button
    const saveBtn = document.getElementById('save-settings') as HTMLButtonElement;
    saveBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        
        // Disable button during save
        saveBtn.disabled = true;
        saveBtn.classList.add('loading');
        const originalText = saveBtn.textContent;
        saveBtn.textContent = 'Saving...';
        
        try {
            await saveSettings();
        } finally {
            // Re-enable button
            saveBtn.disabled = false;
            saveBtn.classList.remove('loading');
            saveBtn.textContent = originalText;
        }
    });
    
    // Reset settings button
    const resetBtn = document.getElementById('reset-settings') as HTMLButtonElement;
    resetBtn.addEventListener('click', resetSettings);
    
    // Help button
    const helpBtn = document.getElementById('help-button') as HTMLButtonElement;
    helpBtn.addEventListener('click', showSettingsHelp);
    
    // Auto-save on certain changes (optional)
    const autoSaveElements = [
        'floating-menu-enabled',
        'autolock-timeout',
        'fiat-currency', 'invoice-expiry', 'invoice-expiry-custom'
    ];
    
    autoSaveElements.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('change', () => {
                // Debounce auto-save
                clearTimeout((window as any).autoSaveTimeout);
                (window as any).autoSaveTimeout = setTimeout(() => {
                    console.log('Auto-saving settings...');
                    saveSettings();
                }, 1000);
            });
        }
    });
}

async function saveSettings(): Promise<void> {
    try {
        const builtinRadio = document.getElementById('builtin-wallet') as HTMLInputElement;
        const customLnurlInput = document.getElementById('custom-lnurl') as HTMLInputElement;
        
        // Clear any existing error states
        clearFieldErrors();
        
        // Validate wallet configuration
        const walletValidation = validateWalletConfiguration(builtinRadio.checked, customLnurlInput.value);
        if (!walletValidation.isValid) {
            showFieldError('custom-lnurl', walletValidation.error!);
            showError(walletValidation.error!);
            return;
        }
        
        // Validate auto-lock timeout
        const autoLockTimeout = validateAutoLockTimeout();
        if (!autoLockTimeout.isValid) {
            showError(autoLockTimeout.error!);
            return;
        }
        
        const expirySelect = document.getElementById('invoice-expiry') as HTMLSelectElement;
        const customExpiry = document.getElementById('invoice-expiry-custom') as HTMLInputElement;
        const invoiceExpirySecs = expirySelect.value === 'custom' ? customMinutesToExpirySecs(customExpiry.value) : Number(expirySelect.value);
        if (!invoiceExpirySecs) { showFieldError('invoice-expiry-custom', 'Enter a duration from 1 minute to 7 days.'); return; }
        // Collect settings
        const newSettings: UserSettings = {
            useBuiltInWallet: builtinRadio.checked,
            customLNURL: builtinRadio.checked ? undefined : customLnurlInput.value.trim() || undefined,
            floatingMenuEnabled: (document.getElementById('floating-menu-enabled') as HTMLInputElement).checked,
            autoLockTimeout: autoLockTimeout.timeout!,
            facebookPostingMode: currentSettings.facebookPostingMode,
            allowedFacebookGroups: currentSettings.allowedFacebookGroups,
            deniedFacebookGroups: currentSettings.deniedFacebookGroups,
            fiatCurrency: (document.getElementById('fiat-currency') as HTMLSelectElement).value as 'usd' | 'eur',
            invoiceExpirySecs
        };
        
        // Save settings
        console.log('Saving settings:', newSettings);
        const response = await ExtensionMessaging.saveUserSettings(newSettings);
        console.log('Save response:', response);
        
        if (response.success) {
            showSuccess('Settings saved successfully!');
            currentSettings = newSettings;
            console.log('Settings saved and updated locally:', currentSettings);
        } else {
            showError('Failed to save settings: ' + (response.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Failed to save settings:', error);
        showError('Failed to save settings: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
}

async function resetSettings(): Promise<void> {
    if (confirm('Reset all settings to defaults?')) {
        currentSettings = getDefaultSettings();
        populateForm();
        
        try {
            const response = await ExtensionMessaging.saveUserSettings(currentSettings);
            if (response.success) {
                showSuccess('Settings reset to defaults');
            } else {
                showError('Failed to reset settings');
            }
        } catch (error) {
            console.error('Failed to reset settings:', error);
            showError('Failed to reset settings');
        }
    }
}

function isValidLNURL(lnurl: string): boolean {
    // Enhanced LNURL validation
    if (!lnurl || typeof lnurl !== 'string') {
        return false;
    }
    
    const trimmed = lnurl.trim();
    
    // Check if it starts with lnurl (case insensitive)
    if (!trimmed.toLowerCase().startsWith('lnurl')) {
        return false;
    }
    
    // Check minimum length (LNURL should be at least 50+ characters)
    if (trimmed.length < 50) {
        return false;
    }
    
    // Check if it contains only valid bech32 characters after 'lnurl'
    const lnurlPart = trimmed.substring(5); // Remove 'lnurl' prefix
    const validBech32Chars = /^[023456789acdefghjklmnpqrstuvwxyz]+$/;
    
    return validBech32Chars.test(lnurlPart);
}

function showSuccess(message: string): void {
    showMessage(message, 'success');
}

function showError(message: string): void {
    showMessage(message, 'error');
}

function showMessage(message: string, type: 'success' | 'error'): void {
    // Remove existing messages
    const existing = document.querySelector('.settings-message');
    if (existing) {
        existing.remove();
    }
    
    const messageEl = document.createElement('div');
    messageEl.className = 'settings-message';
    messageEl.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 12px 16px;
        border-radius: 6px;
        color: white;
        font-weight: bold;
        z-index: 1000;
        background: ${type === 'success' ? '#4CAF50' : '#f44336'};
    `;
    messageEl.textContent = message;
    
    document.body.appendChild(messageEl);
    
    setTimeout(() => {
        messageEl.remove();
    }, 3000);
}

// Enhanced validation functions
interface ValidationResult {
    isValid: boolean;
    error?: string;
    amounts?: [number, number, number];
    timeout?: number;
}

function validateWalletConfiguration(useBuiltIn: boolean, customLnurl: string): ValidationResult {
    if (useBuiltIn) {
        return { isValid: true };
    }
    
    // Custom LNURL is required when not using built-in wallet
    if (!customLnurl || !customLnurl.trim()) {
        return { 
            isValid: false, 
            error: 'Custom LNURL is required when not using built-in wallet' 
        };
    }
    
    const trimmedLnurl = customLnurl.trim();
    
    if (!isValidLNURL(trimmedLnurl)) {
        return { 
            isValid: false, 
            error: 'Invalid LNURL format. Please enter a valid LNURL starting with "lnurl" and containing valid bech32 characters.' 
        };
    }
    
    return { isValid: true };
}

function validateAutoLockTimeout(): ValidationResult {
    const select = document.getElementById('autolock-timeout') as HTMLSelectElement;
    const value = select.value;
    
    if (!value && value !== '0') {
        return { 
            isValid: false, 
            error: 'Auto-lock timeout is required' 
        };
    }
    
    const timeout = parseInt(value);
    
    if (isNaN(timeout)) {
        return { 
            isValid: false, 
            error: 'Auto-lock timeout must be a valid number' 
        };
    }
    
    if (timeout < 0) {
        return { 
            isValid: false, 
            error: 'Auto-lock timeout cannot be negative' 
        };
    }
    
    // Maximum 24 hours (86400 seconds)
    if (timeout > 86400) {
        return { 
            isValid: false, 
            error: 'Auto-lock timeout cannot exceed 24 hours' 
        };
    }
    
    return { 
        isValid: true, 
        timeout 
    };
}

function showFieldError(fieldId: string, message: string): void {
    const field = document.getElementById(fieldId) as HTMLInputElement;
    if (field) {
        field.classList.add('error');
        field.title = message;
        
        // Remove error state after user starts typing
        const clearError = () => {
            field.classList.remove('error');
            field.title = '';
            field.removeEventListener('input', clearError);
        };
        field.addEventListener('input', clearError);
    }
}

function clearFieldErrors(): void {
    const errorFields = document.querySelectorAll('.error');
    errorFields.forEach(field => {
        field.classList.remove('error');
        (field as HTMLElement).title = '';
    });
}

// Additional helper functions
function formatSatsAmount(sats: number): string {
    if (sats >= 100000000) {
        return `${(sats / 100000000).toFixed(2)} BTC`;
    } else if (sats >= 1000) {
        return `${(sats / 1000).toFixed(1)}k sats`;
    } else {
        return `${sats} sats`;
    }
}

function addAmountFormatting(): void {
    const amountInputs = document.querySelectorAll('input[type="number"][id*="amount"]');
    
    amountInputs.forEach(input => {
        const inputEl = input as HTMLInputElement;
        
        inputEl.addEventListener('blur', () => {
            const value = parseInt(inputEl.value);
            if (!isNaN(value) && value > 0) {
                // Add formatted display next to input
                let display = inputEl.nextElementSibling;
                if (!display || !display.classList.contains('amount-display')) {
                    display = document.createElement('span');
                    display.className = 'amount-display';
                    (display as HTMLElement).style.cssText = 'font-size: 11px; color: #666; margin-left: 8px;';
                    inputEl.parentNode?.insertBefore(display, inputEl.nextSibling);
                }
                display.textContent = `(${formatSatsAmount(value)})`;
            }
        });
    });
}

function showSettingsHelp(): void {
    const helpText = `
Settings Help:

WALLET CONFIGURATION:
• Built-in Wallet: Recommended for most users. Uses Breez SDK for full Lightning functionality.
• Custom LNURL: For advanced users with existing Lightning wallets or services.

    SECURITY:
• Auto-lock: Automatically locks wallet after inactivity.
• Shorter timeouts are more secure but less convenient.

Need help? Check the extension documentation or contact support.
    `;
    
    alert(helpText);
}

// Enhanced debug functions
(window as any).debugSettings = {
    getCurrentSettings: () => currentSettings,
    loadSettings: loadSettings,
    validateCurrentForm: () => {
        const builtinRadio = document.getElementById('builtin-wallet') as HTMLInputElement;
        const customLnurlInput = document.getElementById('custom-lnurl') as HTMLInputElement;
        
        console.log('Wallet validation:', validateWalletConfiguration(builtinRadio.checked, customLnurlInput.value));
        console.log('Auto-lock validation:', validateAutoLockTimeout());
    },
    testStorage: async () => {
        const result = await chrome.storage.local.get(['userSettings']);
        console.log('Raw storage result:', result);
        return result;
    },
    showHelp: showSettingsHelp,
    formatSats: formatSatsAmount
};

// Initialize amount formatting when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(addAmountFormatting, 100);
});
