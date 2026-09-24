import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ balance: 10_000, preparedPayment: { paymentMethod: {} } as any }));
const notifications = vi.hoisted(() => ({ showError: vi.fn(), showConfirmDialog: vi.fn(async () => true) }));

vi.mock('./state', () => ({
    get breezSDK() { return { sendPayment: vi.fn(), lnurlPay: vi.fn() }; },
    get currentBalance() { return state.balance; },
    get preparedPayment() { return state.preparedPayment; },
    setPreparedPayment: vi.fn((payment: any) => { state.preparedPayment = payment; })
}));
vi.mock('./contacts', () => ({ isExistingContact: vi.fn(), openContactModalWithAddress: vi.fn(), openContactPicker: vi.fn(), showContactsInterface: vi.fn() }));
vi.mock('./notifications', () => ({ ...notifications, showSuccess: vi.fn() }));
vi.mock('../utils/currency', () => ({ currencyService: {}, fiatToSats: vi.fn(), satsToFiat: vi.fn(async () => null), formatFiat: vi.fn(), formatSelectedCurrencyAmount: vi.fn(), getBtcSpotPrice: vi.fn() }));
vi.mock('./currency-pref', () => ({ getUserFiatCurrency: vi.fn(async () => 'usd'), getDisplayCurrency: vi.fn(), persistDisplayCurrency: vi.fn() }));

class FakeElement {
    private content = '';
    value = '';
    disabled = false;
    className = '';
    children: FakeElement[] = [];
    attributes = new Map<string, string>();
    listeners = new Map<string, Array<() => void>>();
    classList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() };
    get textContent(): string { return this.content; }
    set textContent(value: string) {
        this.content = value;
        this.children = [];
    }
    append(...children: FakeElement[]): void { this.children.push(...children); }
    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
    addEventListener(name: string, listener: () => void): void {
        this.listeners.set(name, [...(this.listeners.get(name) || []), listener]);
    }
    click(): void { (this.listeners.get('click') || []).forEach(listener => listener()); }
}

function createFixture(): Record<string, FakeElement> {
    const elements: Record<string, FakeElement> = {};
    [
        'payment-preview', 'send-payment-btn', 'preview-recipient', 'preview-amount', 'preview-fee', 'preview-total',
        'preview-comment-row', 'preview-comment', 'send-balance-entry-status', 'send-balance-fee', 'send-balance-result',
        'send-balance-result-label', 'send-balance-summary', 'preview-balance-result-label', 'preview-remaining', 'preview-balance-status', 'send-balance-privacy-toggle',
        'payment-input', 'withdrawal-amount', 'withdrawal-comment', 'preview-payment-btn'
    ].forEach(id => { elements[id] = new FakeElement(); });
    elements['payment-input'].value = 'lnbc1invoice';
    return elements;
}

describe('withdrawal balance flow', () => {
    beforeEach(() => {
        vi.resetModules();
        state.balance = 10_000;
        state.preparedPayment = { paymentMethod: {} };
        notifications.showError.mockReset();
    });

    it('renders the same known-fee balance state in entry and preview surfaces', async () => {
        const elements = createFixture();
        vi.stubGlobal('document', {
            getElementById: (id: string) => elements[id] || null,
            createElement: () => new FakeElement(),
            querySelectorAll: () => []
        });
        const { displayPaymentPreview } = await import('./withdrawal');

        displayPaymentPreview({ recipient: 'Lightning Payment', amount: 2_500, fee: 75, type: 'bolt11' });

        expect(elements['preview-remaining'].textContent).toBe('7,425 sats');
        expect(elements['preview-total'].children[0].textContent).toBe('2,575 sats');
        expect(elements['send-payment-btn'].disabled).toBe(false);
    });

    it('rerenders every prepared preview value when privacy is toggled without losing the known fee', async () => {
        const elements = createFixture();
        vi.stubGlobal('document', {
            getElementById: (id: string) => elements[id] || null,
            createElement: () => new FakeElement(),
            querySelectorAll: () => []
        });
        const { displayPaymentPreview, setupWithdrawalListeners } = await import('./withdrawal');
        setupWithdrawalListeners();
        displayPaymentPreview({ recipient: 'Lightning Payment', amount: 2_500, fee: 75, type: 'bolt11' });

        elements['send-balance-privacy-toggle'].click();
        expect(elements['preview-remaining'].textContent).toBe('••••••');
        expect(elements['preview-fee'].children[0].textContent).toBe('••••••');

        elements['send-balance-privacy-toggle'].click();
        expect(elements['preview-fee'].children[0].textContent).toBe('75 sats');
        expect(elements['preview-remaining'].textContent).toBe('7,425 sats');
    });

    it('keeps unknown-fee and insufficient previews disabled and blocks dispatch', async () => {
        const elements = createFixture();
        vi.stubGlobal('document', {
            getElementById: (id: string) => elements[id] || null,
            createElement: () => new FakeElement(),
            querySelectorAll: () => []
        });
        const { displayPaymentPreview, sendPayment } = await import('./withdrawal');

        displayPaymentPreview({ recipient: 'Lightning Payment', amount: 2_500, fee: undefined, type: 'bolt11' });
        expect(elements['send-payment-btn'].disabled).toBe(true);

        displayPaymentPreview({ recipient: 'Lightning Payment', amount: 9_950, fee: 75, type: 'bolt11' });
        expect(elements['send-payment-btn'].disabled).toBe(true);
        expect(elements['preview-balance-result-label'].textContent).toBe('Short by:');
        expect(elements['preview-remaining'].textContent).toBe('25 sats');
        await sendPayment();
        expect(notifications.showError).toHaveBeenCalledWith('Insufficient funds for this payment amount and fee.');
    });
});
