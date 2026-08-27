import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPaymentComment, renderTransactionCommentDetailRow } from './payment-comment';

const state = vi.hoisted(() => ({ sdk: null as any, preparedPayment: null as any }));

vi.mock('./state', () => ({
    get breezSDK() { return state.sdk; },
    get preparedPayment() { return state.preparedPayment; },
    currentBalance: 0,
    setPreparedPayment: vi.fn((payment: any) => { state.preparedPayment = payment; })
}));
vi.mock('./contacts', () => ({ isExistingContact: vi.fn(), openContactModalWithAddress: vi.fn(), openContactPicker: vi.fn(), showContactsInterface: vi.fn() }));
vi.mock('./notifications', () => ({ showError: vi.fn(), showSuccess: vi.fn(), showConfirmDialog: vi.fn(async () => true) }));
vi.mock('../utils/currency', () => ({ currencyService: {}, fiatToSats: vi.fn(), satsToFiat: vi.fn(), formatFiat: vi.fn(), formatSelectedCurrencyAmount: vi.fn(), getBtcSpotPrice: vi.fn() }));
vi.mock('./currency-pref', () => ({ getUserFiatCurrency: vi.fn(), getDisplayCurrency: vi.fn(), persistDisplayCurrency: vi.fn() }));

type TestElement = {
    value: string;
    textContent: string;
    disabled: boolean;
    placeholder: string;
    className: string;
    classList: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
    removeAttribute: ReturnType<typeof vi.fn>;
};

function element(value = ''): TestElement {
    return {
        value, textContent: '', disabled: false, placeholder: '', className: '',
        classList: { add: vi.fn(), remove: vi.fn() }, removeAttribute: vi.fn()
    };
}

describe('withdrawal comment flow', () => {
    beforeEach(() => {
        vi.resetModules();
        state.sdk = null;
        state.preparedPayment = null;
        vi.stubGlobal('setTimeout', vi.fn());
    });

    it('persists the previewed comment after an edit and renders it in transaction details', async () => {
        const storage: Record<string, any> = {
            multiWalletData: JSON.stringify({ activeWalletId: 'wallet-a', activeSubWalletIndex: 2 })
        };
        const elements: Record<string, TestElement> = {
            'payment-input': element('lnbc1invoice'),
            'withdrawal-amount': element('21'),
            'withdrawal-comment': element('comment approved in preview'),
            'preview-payment-btn': element(),
            'send-payment-btn': element(),
            'withdrawal-status': element(),
            'withdrawal-status-text': element()
        };
        vi.stubGlobal('document', {
            getElementById: (id: string) => elements[id] || null,
            querySelectorAll: () => []
        });
        vi.stubGlobal('chrome', {
            storage: { local: {
                get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter(key => key in storage).map(key => [key, storage[key]]))),
                set: vi.fn(async (values: Record<string, any>) => Object.assign(storage, values))
            } }
        });
        state.sdk = {
            prepareSendPayment: vi.fn(async () => ({ amount: 21, paymentMethod: { type: 'bolt11Invoice', lightningFeeSats: 1 } })),
            sendPayment: vi.fn(async () => ({ payment: { id: 'completed-payment', status: 'complete' } }))
        };

        const { previewPayment, sendPayment, setWithdrawalCallbacks } = await import('./withdrawal');
        setWithdrawalCallbacks({ updateBalanceDisplay: vi.fn(async () => {}), loadTransactionHistory: vi.fn(async () => {}) });

        await previewPayment();
        elements['withdrawal-comment'].value = 'later composer edit';
        await sendPayment();

        const persisted = await loadPaymentComment('wallet-a', 2, 'completed-payment');
        const detailHtml = renderTransactionCommentDetailRow('Provider description', persisted, value => value);
        expect(state.sdk.sendPayment).toHaveBeenCalledOnce();
        expect(persisted).toBe('comment approved in preview');
        expect(detailHtml).toContain('Comment');
        expect(detailHtml).toContain('comment approved in preview');
        expect(detailHtml).not.toContain('later composer edit');
    });
});
