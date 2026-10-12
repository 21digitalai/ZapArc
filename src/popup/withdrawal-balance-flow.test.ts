import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const state = vi.hoisted(() => ({ balance: 10_000, preparedPayment: { paymentMethod: {} } as any, sdk: { sendPayment: vi.fn(), lnurlPay: vi.fn(), prepareSendPayment: vi.fn() } }));
const notifications = vi.hoisted(() => ({ showError: vi.fn(), showConfirmDialog: vi.fn(async () => true) }));

vi.mock('./state', () => ({
    get breezSDK() { return state.sdk; },
    get currentBalance() { return state.balance; },
    get preparedPayment() { return state.preparedPayment; },
    setPreparedPayment: vi.fn((payment: any) => { state.preparedPayment = payment; })
}));
vi.mock('./contacts', () => ({ isExistingContact: vi.fn(), openContactModalWithAddress: vi.fn(), openContactPicker: vi.fn(), showContactsInterface: vi.fn() }));
vi.mock('./notifications', () => ({ ...notifications, showSuccess: vi.fn() }));
vi.mock('../utils/currency', () => ({ currencyService: {}, fiatToSats: vi.fn(), satsToFiat: vi.fn(async () => null), formatFiat: vi.fn(), formatSelectedCurrencyAmount: vi.fn(), getBtcSpotPrice: vi.fn(async () => null) }));
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
        'payment-preview', 'send-payment-btn', 'preview-recipient', 'preview-amount', 'preview-fee', 'preview-total', 'send-balance-preview',
        'preview-comment-row', 'preview-comment', 'send-balance-entry-status', 'send-balance-amount', 'send-balance-fee', 'send-balance-total', 'send-balance-result', 'send-balance-spot',
        'send-balance-result-label', 'send-balance-summary', 'preview-balance-result-label', 'preview-remaining', 'preview-balance-status', 'send-balance-privacy-toggle',
        'payment-input', 'withdrawal-amount', 'withdrawal-comment', 'preview-payment-btn',
        'onchain-address-input', 'onchain-amount-input', 'preview-onchain-payment-btn', 'send-onchain-payment-btn',
        'onchain-payment-preview', 'onchain-network-fee', 'onchain-preview-recipient', 'onchain-preview-amount', 'onchain-preview-fee', 'onchain-preview-speed', 'onchain-preview-total',
        'onchain-send-estimate', 'onchain-estimate-amount', 'onchain-estimate-fee', 'onchain-estimate-total', 'onchain-estimate-result-label', 'onchain-estimate-result', 'onchain-estimate-status', 'onchain-estimate-spot',
        'onchain-preview-result-label', 'onchain-preview-remaining', 'onchain-preview-status', 'onchain-balance-preview', 'onchain-balance-privacy-toggle'
    ].forEach(id => { elements[id] = new FakeElement(); });
    elements['payment-input'].value = 'lnbc1invoice';
    return elements;
}

async function previewOnchain(
    elements: Record<string, FakeElement>,
    balance: number,
    amount: string,
    fee: { userFeeSat: number, l1BroadcastFeeSat: number } | undefined
): Promise<void> {
    state.balance = balance;
    elements['onchain-address-input'].value = 'bc1q' + 'a'.repeat(38);
    elements['onchain-amount-input'].value = amount;
    state.sdk.prepareSendPayment.mockResolvedValue({ paymentMethod: { feeQuote: { speedMedium: fee } } });
    vi.stubGlobal('document', {
        getElementById: (id: string) => elements[id] || null,
        createElement: () => new FakeElement(),
        querySelectorAll: () => []
    });
    const { setupWithdrawalListeners } = await import('./withdrawal');
    setupWithdrawalListeners();
    await (elements['preview-onchain-payment-btn'].listeners.get('click')?.[0] as any)();
}

describe('withdrawal balance flow', () => {
    beforeEach(() => {
        vi.resetModules();
        state.balance = 10_000;
        state.preparedPayment = { paymentMethod: {} };
        state.sdk.prepareSendPayment.mockReset();
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
        expect(elements['send-balance-total'].children[0].textContent).toBe('2,575 sats');
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
        expect(elements['send-balance-privacy-toggle'].textContent).toBe('🙈');
        expect(elements['onchain-balance-privacy-toggle'].attributes.get('aria-label')).toBe('Show balance values');

        elements['send-balance-privacy-toggle'].click();
        expect(elements['preview-fee'].children[0].textContent).toBe('75 sats');
        expect(elements['preview-remaining'].textContent).toBe('7,425 sats');
        expect(elements['send-balance-privacy-toggle'].textContent).toBe('👁');
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
        expect(elements['send-balance-fee'].textContent).toBe('Calculated at preview');
        expect(elements['send-balance-total'].textContent).toBe('Calculated at preview');
        expect(elements['send-balance-result-label'].textContent).toBe('Remaining before fees');
        expect(elements['send-balance-result'].children[0].textContent).toBe('7,500 sats');

        displayPaymentPreview({ recipient: 'Lightning Payment', amount: 9_950, fee: 75, type: 'bolt11' });
        expect(elements['send-payment-btn'].disabled).toBe(true);
        expect(elements['preview-balance-result-label'].textContent).toBe('Short by:');
        expect(elements['preview-remaining'].textContent).toBe('25 sats');
        expect(elements['send-balance-preview'].classList.toggle).toHaveBeenCalledWith('insufficient', true);
        await sendPayment();
        expect(notifications.showError).toHaveBeenCalledWith('Insufficient funds for this payment amount and fee.');
    });

    it('shows an explicit shortfall when the entered amount alone exceeds the balance before a fee is known', async () => {
        const elements = createFixture();
        elements['withdrawal-amount'].value = '10001';
        vi.stubGlobal('document', {
            getElementById: (id: string) => elements[id] || null,
            createElement: () => new FakeElement(),
            querySelectorAll: () => []
        });
        const { setupWithdrawalListeners } = await import('./withdrawal');
        setupWithdrawalListeners();
        elements['withdrawal-amount'].click();
        const inputListener = elements['withdrawal-amount'].listeners.get('input')?.[0];
        inputListener?.();

        expect(elements['send-balance-entry-status'].textContent).toContain('Insufficient balance');
        expect(elements['send-balance-result-label'].textContent).toBe('Short by');
        expect(elements['send-balance-result'].children[0].textContent).toBe('1 sats');
    });

    it('keeps every known fee, total, and shortfall value masked in the unified card', async () => {
        const elements = createFixture();
        vi.stubGlobal('document', {
            getElementById: (id: string) => elements[id] || null,
            createElement: () => new FakeElement(),
            querySelectorAll: () => []
        });
        const { displayPaymentPreview, setupWithdrawalListeners } = await import('./withdrawal');
        setupWithdrawalListeners();
        displayPaymentPreview({ recipient: 'Lightning Payment', amount: 9_950, fee: 75, type: 'bolt11' });
        elements['send-balance-privacy-toggle'].click();

        expect(elements['send-balance-fee'].children[0].textContent).toBe('••••••');
        expect(elements['send-balance-total'].children[0].textContent).toBe('••••••');
        expect(elements['send-balance-result'].children[0].textContent).toBe('••••••');
        expect(elements['preview-remaining'].textContent).toBe('••••••');
    });

    it('uses exactly one lower estimate card with conversion, fee, total, and result rows', () => {
        const html = readFileSync(new URL('./popup.html', import.meta.url), 'utf8');
        expect((html.match(/id="send-balance-summary"/g) || [])).toHaveLength(1);
        expect(html).toContain('id="send-conversion-hint"');
        expect(html).toContain('id="send-balance-fee"');
        expect(html).toContain('id="send-balance-amount"');
        expect(html).toContain('id="send-balance-spot"');
        expect(html).toContain('id="send-balance-total"');
        expect(html).toContain('id="send-balance-result"');
        expect(html).not.toContain('Spendable balance');
        expect(html.indexOf('id="withdrawal-comment"')).toBeLessThan(html.indexOf('id="send-balance-summary"'));
        expect(html.indexOf('id="send-balance-summary"')).toBeLessThan(html.indexOf('id="preview-payment-btn"'));
    });

    it('places one fee-inclusive on-chain estimate before its preview action', () => {
        const html = readFileSync(new URL('./popup.html', import.meta.url), 'utf8');
        const estimateIndex = html.indexOf('id="onchain-send-estimate"');
        const previewActionIndex = html.indexOf('id="preview-onchain-payment-btn"');

        expect(estimateIndex).toBeGreaterThan(-1);
        expect(estimateIndex).toBeLessThan(previewActionIndex);
        expect(html).toContain('id="onchain-estimate-fee"');
        expect(html).toContain('id="onchain-estimate-amount"');
        expect(html).toContain('id="onchain-estimate-spot"');
        expect(html).toContain('id="onchain-estimate-total"');
        expect(html).toContain('id="onchain-estimate-result"');
        expect(html).toContain('id="onchain-preview-remaining"');
    });

    it('renders selected on-chain quote amounts with sats and fiat-secondary slots before enabling Send', async () => {
        const elements = createFixture();
        await previewOnchain(elements, 10_000, '9000', { userFeeSat: 500, l1BroadcastFeeSat: 501 });

        expect(elements['onchain-estimate-fee'].children[0].textContent).toBe('1,001 sats');
        expect(elements['onchain-estimate-total'].children[0].textContent).toBe('10,001 sats');
        expect(elements['send-onchain-payment-btn'].disabled).toBe(true);
    });

    it.each([
        ['zero balance', 0, '1000', { userFeeSat: 0, l1BroadcastFeeSat: 0 }, true, '1,000 sats'],
        ['exact balance', 10_000, '9000', { userFeeSat: 500, l1BroadcastFeeSat: 500 }, false, '0 sats'],
        ['one-sat short', 10_000, '9000', { userFeeSat: 500, l1BroadcastFeeSat: 501 }, true, '1 sats'],
        ['fee-caused shortfall', 10_000, '10000', { userFeeSat: 1, l1BroadcastFeeSat: 0 }, true, '1 sats']
    ])('applies the fee-inclusive affordability guard for %s', async (_name, balance, amount, fee, disabled, result) => {
        const elements = createFixture();
        await previewOnchain(elements, balance, amount, fee);

        expect(elements['send-onchain-payment-btn'].disabled).toBe(disabled);
        expect(elements['onchain-estimate-result'].children[0].textContent).toBe(result);
    });

    it('keeps an unknown fee non-precise and Send unavailable', async () => {
        const elements = createFixture();
        await previewOnchain(elements, 10_000, '9000', undefined);

        expect(elements['onchain-estimate-fee'].textContent).toBe('Waiting for fee quote');
        expect(elements['send-onchain-payment-btn'].disabled).toBe(true);
    });

    it('invalidates a prepared preview synchronously when the quote input changes', async () => {
        const elements = createFixture();
        await previewOnchain(elements, 10_000, '9000', { userFeeSat: 500, l1BroadcastFeeSat: 0 });
        expect(elements['send-onchain-payment-btn'].disabled).toBe(false);

        elements['onchain-amount-input'].value = '9001';
        elements['onchain-amount-input'].listeners.get('input')?.[0]();

        expect(elements['send-onchain-payment-btn'].disabled).toBe(true);
        expect(elements['send-onchain-payment-btn'].classList.add).toHaveBeenCalledWith('hidden');
        expect(elements['onchain-payment-preview'].classList.add).toHaveBeenCalledWith('hidden');
    });

    it('masks on-chain estimate values when privacy is enabled', async () => {
        const elements = createFixture();
        await previewOnchain(elements, 10_000, '9000', { userFeeSat: 500, l1BroadcastFeeSat: 0 });
        elements['onchain-balance-privacy-toggle'].click();

        expect(elements['onchain-estimate-fee'].children[0].textContent).toBe('••••••');
        expect(elements['onchain-estimate-total'].children[0].textContent).toBe('••••••');
    });
});
