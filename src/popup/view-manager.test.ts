import { afterEach, describe, expect, it, vi } from 'vitest';
import { hideAllViews } from './view-manager';

describe('hideAllViews', () => {
    const originalDocument = globalThis.document;

    afterEach(() => {
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: originalDocument,
        });
    });

    it('closes the main wallet and every other top-level view', () => {
        const elements = new Map<string, { classList: { add: ReturnType<typeof vi.fn> } }>();
        const getElementById = vi.fn((id: string) => {
            if (!elements.has(id)) {
                elements.set(id, { classList: { add: vi.fn() } });
            }
            return elements.get(id) ?? null;
        });

        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: { getElementById },
        });

        hideAllViews();

        expect(elements.get('main-interface')?.classList.add).toHaveBeenCalledWith('hidden');
        expect(elements.get('wallet-selection-interface')?.classList.add).toHaveBeenCalledWith('hidden');
        expect(elements.get('settings-interface')?.classList.add).toHaveBeenCalledWith('hidden');
        expect(elements.get('wallet-management-interface')?.classList.add).toHaveBeenCalledWith('hidden');
        expect(elements.get('transaction-history-view')?.classList.add).toHaveBeenCalledWith('hidden');
    });
});
