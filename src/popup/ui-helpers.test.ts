import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearWalletDisplay } from './ui-helpers';

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
