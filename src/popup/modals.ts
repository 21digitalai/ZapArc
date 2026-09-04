// Modal System for popup
// Handles modal overlay, show/hide, and common modal patterns

import { BIP39_WORDS } from './state';
import { createDebounce, PIN_AUTO_CONFIRM_DELAY_MS } from '../utils/debounce';

// ========================================
// Modal State
// ========================================

export interface ModalState {
    currentModal: string | null;
    resolveCallback: ((value: any) => void) | null;
    rejectCallback: ((error: any) => void) | null;
}

export const modalState: ModalState = {
    currentModal: null,
    resolveCallback: null,
    rejectCallback: null
};

// ========================================
// Core Modal Functions
// ========================================

export function showModalOverlay(): void {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) {
        overlay.classList.remove('hidden');
        document.body.classList.add('modal-open');
    }
}

export function hideModalOverlay(): void {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) {
        overlay.classList.add('hidden');
        document.body.classList.remove('modal-open');
    }
}

export function showModal(modalId: string): void {
    hideAllModals();
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('hidden');
        showModalOverlay();
        modalState.currentModal = modalId;

        // Focus first input if exists
        const firstInput = modal.querySelector('input') as HTMLInputElement;
        if (firstInput) {
            setTimeout(() => firstInput.focus(), 100);
        }
    }
}

export function hideModal(modalId: string): void {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('hidden');
    }
    if (modalState.currentModal === modalId) {
        hideModalOverlay();
        modalState.currentModal = null;
    }
}

export function hideAllModals(): void {
    const allModals = document.querySelectorAll('.modal');
    allModals.forEach(modal => modal.classList.add('hidden'));
}

export function closeCurrentModal(value: any): void {
    if (modalState.resolveCallback) {
        modalState.resolveCallback(value);
        modalState.resolveCallback = null;
        modalState.rejectCallback = null;
    }
    if (modalState.currentModal) {
        hideModal(modalState.currentModal);
    }
}

// ========================================
// Modal Event Listeners Setup
// ========================================

export function setupModalListeners(): void {
    // Close on overlay click
    const overlay = document.getElementById('modal-overlay');
    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closeCurrentModal(null);
            }
        });
    }

    // ESC key to close modals
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modalState.currentModal) {
            closeCurrentModal(null);
        }
    });

    // Setup all modal close buttons
    const closeButtons = document.querySelectorAll('.modal-close');
    closeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            closeCurrentModal(null);
        });
    });
}

// ========================================
// PIN Modal
// ========================================

export async function showPINModal(message: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
        modalState.resolveCallback = resolve;
        modalState.rejectCallback = reject;

        const messageEl = document.getElementById('pin-modal-message');
        let inputEl = document.getElementById('pin-modal-input') as HTMLInputElement;
        const errorEl = document.getElementById('pin-modal-error');
        const confirmBtn = document.getElementById('pin-modal-confirm');
        const cancelBtn = document.getElementById('pin-modal-cancel');

        if (!messageEl || !inputEl || !confirmBtn || !cancelBtn) {
            resolve(null);
            return;
        }

        inputEl = replaceModalInput(inputEl);

        // Setup modal
        messageEl.textContent = message;
        inputEl.value = '';
        errorEl?.classList.add('hidden');

        // Force numeric PIN input (only digits allowed) with 6-digit limit
        inputEl.setAttribute('type', 'password');
        inputEl.setAttribute('placeholder', 'Enter PIN');
        inputEl.setAttribute('inputmode', 'numeric');
        inputEl.setAttribute('pattern', '[0-9]*');
        inputEl.setAttribute('maxlength', '6');
        
        // Restore PIN modal title
        const modal = document.getElementById('pin-modal');
        const titleEl = modal?.querySelector('h2, h3');
        if (titleEl) {
            titleEl.textContent = 'Enter PIN';
        }

        // Remove old listeners
        const newConfirmBtn = confirmBtn.cloneNode(true) as HTMLButtonElement;
        const newCancelBtn = cancelBtn.cloneNode(true) as HTMLButtonElement;
        confirmBtn.replaceWith(newConfirmBtn);
        cancelBtn.replaceWith(newCancelBtn);

        // Confirm button
        newConfirmBtn.addEventListener('click', () => {
            const pin = inputEl.value.trim();
            if (!pin || pin.length < 4) {
                if (errorEl) {
                    errorEl.textContent = 'PIN must be at least 4 digits';
                    errorEl.classList.remove('hidden');
                }
                return;
            }
            if (!/^\d+$/.test(pin)) {
                if (errorEl) {
                    errorEl.textContent = 'PIN must contain only numbers';
                    errorEl.classList.remove('hidden');
                }
                return;
            }
            closeCurrentModal(pin);
        });

        // Cancel button
        newCancelBtn.addEventListener('click', () => {
            closeCurrentModal(null);
        });

        // Filter input to only allow digits
        const filterInput = (e: Event) => {
            const target = e.target as HTMLInputElement;
            const value = target.value;
            // Remove any non-digit characters
            const filtered = value.replace(/\D/g, '');
            if (value !== filtered) {
                target.value = filtered;
            }
        };

        inputEl.addEventListener('input', filterInput);

        // Enter key to confirm
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                newConfirmBtn.click();
            }
        });

        // Auto-confirm with debounce when PIN reaches valid length (6+ digits)
        const autoConfirm = createDebounce((pin: string) => {
            closeCurrentModal(pin);
        }, PIN_AUTO_CONFIRM_DELAY_MS);

        inputEl.addEventListener('input', () => {
            const pin = inputEl.value.trim();

            // Cancel any pending auto-confirm
            autoConfirm.cancel();

            // Hide error on new input
            errorEl?.classList.add('hidden');

            // Only auto-confirm if PIN is at least 6 digits (our standard PIN length)
            if (pin.length >= 6 && /^\d+$/.test(pin)) {
                autoConfirm.call(pin);
            }
        });

        showModal('pin-modal');
    });
}

// Legacy function for backward compatibility
export async function promptForPIN(message: string): Promise<string | null> {
    return showPINModal(message);
}

/**
 * Show a text input modal with a message and optional default value
 */
export async function promptForText(message: string, defaultValue: string = '', placeholder: string = ''): Promise<string | null> {
    return new Promise((resolve, reject) => {
        modalState.resolveCallback = resolve;
        modalState.rejectCallback = reject;

        const messageEl = document.getElementById('pin-modal-message');
        let inputEl = document.getElementById('pin-modal-input') as HTMLInputElement;
        const errorEl = document.getElementById('pin-modal-error');
        const confirmBtn = document.getElementById('pin-modal-confirm');
        const cancelBtn = document.getElementById('pin-modal-cancel');

        if (!messageEl || !inputEl || !confirmBtn || !cancelBtn) {
            resolve(null);
            return;
        }

        inputEl = replaceModalInput(inputEl);

        // Setup modal for text input
        messageEl.textContent = message;
        inputEl.value = defaultValue;
        inputEl.setAttribute('type', 'text');
        inputEl.setAttribute('placeholder', placeholder || 'Enter text');
        inputEl.removeAttribute('inputmode');
        inputEl.removeAttribute('pattern');
        inputEl.setAttribute('maxlength', '30');
        errorEl?.classList.add('hidden');
        
        // Update modal title (find h2/h3 in the modal)
        const modal = document.getElementById('pin-modal');
        const titleEl = modal?.querySelector('h2, h3');
        if (titleEl) {
            titleEl.textContent = 'Enter Name';
        }

        // Remove old listeners
        const newConfirmBtn = confirmBtn.cloneNode(true) as HTMLButtonElement;
        const newCancelBtn = cancelBtn.cloneNode(true) as HTMLButtonElement;
        confirmBtn.replaceWith(newConfirmBtn);
        cancelBtn.replaceWith(newCancelBtn);

        // Confirm button
        newConfirmBtn.addEventListener('click', () => {
            const text = inputEl.value.trim();
            if (!text) {
                if (errorEl) {
                    errorEl.textContent = 'Please enter a value';
                    errorEl.classList.remove('hidden');
                }
                return;
            }
            closeCurrentModal(text);
        });

        // Cancel button
        newCancelBtn.addEventListener('click', () => {
            closeCurrentModal(null);
        });

        // Enter key to confirm
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                newConfirmBtn.click();
            }
        });

        // Hide error on input
        inputEl.addEventListener('input', () => {
            errorEl?.classList.add('hidden');
        });

        showModal('pin-modal');
    });
}

/**
 * Each modal mode registers mode-specific input listeners. Replacing the shared
 * input clears listeners from the previous mode, so a PIN-only digit filter
 * cannot leak into a later wallet-name prompt.
 */
function replaceModalInput(input: HTMLInputElement): HTMLInputElement {
    const replacement = input.cloneNode(true) as HTMLInputElement;
    input.replaceWith(replacement);
    return replacement;
}

// ========================================
// Modal Word Autocomplete Helpers
// ========================================

export function setupModalWordAutocomplete(
    input: HTMLInputElement, 
    suggestionsDiv: HTMLElement, 
    confirmBtn: HTMLButtonElement
): void {
    input.addEventListener('input', () => {
        const value = input.value.toLowerCase().trim();

        if (value.length < 2) {
            suggestionsDiv.style.display = 'none';
            validateModalWordInput(input);
            checkModalImportComplete(confirmBtn);
            return;
        }

        const matches = BIP39_WORDS.filter(word => word.startsWith(value)).slice(0, 10);

        if (matches.length === 0) {
            suggestionsDiv.style.display = 'none';
            validateModalWordInput(input);
            checkModalImportComplete(confirmBtn);
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
                validateModalWordInput(input);

                // Focus next input
                const wordIndex = parseInt(input.dataset.wordIndex || '0');
                if (wordIndex < 11) {
                    const nextInput = document.getElementById(`modal-import-word-${wordIndex + 2}`) as HTMLInputElement;
                    if (nextInput) nextInput.focus();
                }

                checkModalImportComplete(confirmBtn);
            });
            suggestionsDiv.appendChild(div);
        });

        // Position suggestions below input
        const rect = input.getBoundingClientRect();
        suggestionsDiv.style.display = 'block';
        suggestionsDiv.style.left = rect.left + 'px';
        suggestionsDiv.style.top = (rect.bottom + 4) + 'px';
        suggestionsDiv.style.width = rect.width + 'px';

        validateModalWordInput(input);
        checkModalImportComplete(confirmBtn);
    });

    // Hide suggestions on blur
    input.addEventListener('blur', () => {
        setTimeout(() => {
            suggestionsDiv.style.display = 'none';
        }, 200);
    });

    // Enter key handler
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const firstSuggestion = suggestionsDiv.querySelector('.word-suggestion') as HTMLElement;
            if (firstSuggestion && suggestionsDiv.style.display === 'block') {
                firstSuggestion.click();
            } else {
                const value = input.value.toLowerCase().trim();
                if (BIP39_WORDS.includes(value)) {
                    const wordIndex = parseInt(input.dataset.wordIndex || '0');
                    if (wordIndex < 11) {
                        const nextInput = document.getElementById(`modal-import-word-${wordIndex + 2}`) as HTMLInputElement;
                        if (nextInput) nextInput.focus();
                    }
                }
            }
        }
    });
}

export function validateModalWordInput(input: HTMLInputElement): void {
    const value = input.value.toLowerCase().trim();
    if (value.length === 0) {
        input.classList.remove('valid', 'invalid');
    } else if (BIP39_WORDS.includes(value)) {
        input.classList.add('valid');
        input.classList.remove('invalid');
    } else {
        input.classList.add('invalid');
        input.classList.remove('valid');
    }
}

export function checkModalImportComplete(confirmBtn: HTMLButtonElement): void {
    let allValid = true;
    for (let i = 1; i <= 12; i++) {
        const input = document.getElementById(`modal-import-word-${i}`) as HTMLInputElement;
        if (input) {
            const value = input.value.toLowerCase().trim();
            if (!BIP39_WORDS.includes(value)) {
                allValid = false;
                break;
            }
        }
    }
    confirmBtn.disabled = !allValid;
}
