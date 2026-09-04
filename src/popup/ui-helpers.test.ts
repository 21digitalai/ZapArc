import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearWalletDisplay, resetWalletPinStep } from './ui-helpers';

describe('clearWalletDisplay', () => {
    const originalDocument = globalThis.document;

    afterEach(() => {
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: originalDocument,
        });
    });

    it('clears sats and fiat together when creating or switching wallets', () => {
        const elements: Record<string, any> = {
            balance: { textContent: '22,831 sats' },
            'balance-fiat': {
                textContent: '$0.09',
                classList: { add: vi.fn() },
            },
            'withdraw-balance-display': { textContent: '22,831' },
            'transaction-list': { style: {}, innerHTML: 'old transactions' },
        };

        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: { getElementById: (id: string) => elements[id] || null },
        });

        clearWalletDisplay();

        expect(elements.balance.textContent).toBe('-- sats');
        expect(elements['balance-fiat'].textContent).toBe('');
        expect(elements['balance-fiat'].classList.add).toHaveBeenCalledWith('hidden');
        expect(elements['withdraw-balance-display'].textContent).toBe('—');
        expect(elements['transaction-list'].innerHTML).toBe('');
    });
});

describe('resetWalletPinStep', () => {
    const originalDocument = globalThis.document;

    afterEach(() => {
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: originalDocument,
        });
    });

    it('restores a completed import PIN form for the next wallet import', () => {
        const elements: Record<string, any> = {
            'pin-input': { value: '123456' },
            'pin-confirm': { value: '123456' },
            'pin-strength': {
                textContent: 'PIN is valid',
                classList: { add: vi.fn() },
            },
            'pin-continue-btn': {
                disabled: true,
                textContent: 'Creating wallet...',
            },
        };

        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: { getElementById: (id: string) => elements[id] || null },
        });

        resetWalletPinStep();

        expect(elements['pin-input'].value).toBe('');
        expect(elements['pin-confirm'].value).toBe('');
        expect(elements['pin-strength'].textContent).toBe('');
        expect(elements['pin-strength'].classList.add).toHaveBeenCalledWith('hidden');
        expect(elements['pin-continue-btn']).toMatchObject({
            disabled: true,
            textContent: 'Create Wallet',
        });

        elements['pin-input'].value = '654321';
        elements['pin-confirm'].value = '654321';
        elements['pin-strength'].textContent = 'PIN is valid';
        elements['pin-continue-btn'].textContent = 'Creating wallet...';

        resetWalletPinStep();

        expect(elements['pin-input'].value).toBe('');
        expect(elements['pin-confirm'].value).toBe('');
        expect(elements['pin-strength'].textContent).toBe('');
        expect(elements['pin-continue-btn']).toMatchObject({
            disabled: true,
            textContent: 'Create Wallet',
        });
    });
});
