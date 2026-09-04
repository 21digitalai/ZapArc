import { afterEach, describe, expect, it } from 'vitest';
import { promptForText, showPINModal } from './modals';

type Listener = (event: { key?: string; target: FakeInput }) => void;

class FakeInput {
    value = '';
    attributes = new Map<string, string>();
    listeners = new Map<string, Listener[]>();

    constructor(private readonly replace: (input: FakeInput) => void) {}

    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
    removeAttribute(name: string): void { this.attributes.delete(name); }
    addEventListener(name: string, listener: Listener): void {
        this.listeners.set(name, [...(this.listeners.get(name) || []), listener]);
    }
    cloneNode(_deep?: boolean): FakeInput {
        const clone = new FakeInput(this.replace);
        clone.attributes = new Map(this.attributes);
        return clone;
    }
    replaceWith(input: FakeInput): void { this.replace(input); }
    dispatch(name: string): void {
        (this.listeners.get(name) || []).forEach(listener => listener({ target: this }));
    }
    focus(): void {}
}

class FakeButton {
    listeners = new Map<string, Listener[]>();
    constructor(private readonly replace: (button: FakeButton) => void) {}
    addEventListener(name: string, listener: Listener): void {
        this.listeners.set(name, [...(this.listeners.get(name) || []), listener]);
    }
    cloneNode(_deep?: boolean): FakeButton { return new FakeButton(this.replace); }
    replaceWith(button: FakeButton): void { this.replace(button); }
    click(): void { (this.listeners.get('click') || []).forEach(listener => listener({ target: null as any })); }
}

function createModalDocument(): { document: any; input: () => FakeInput; confirm: () => FakeButton; error: any } {
    let currentInput: FakeInput;
    let currentConfirm: FakeButton;
    let currentCancel: FakeButton;
    const error = { textContent: '', classList: { add: () => {}, remove: () => {} } };
    const modal = { classList: { add: () => {}, remove: () => {} }, querySelector: () => currentInput };
    currentInput = new FakeInput(input => { currentInput = input; });
    currentConfirm = new FakeButton(button => { currentConfirm = button; });
    currentCancel = new FakeButton(button => { currentCancel = button; });
    const elements: Record<string, any> = {
        'pin-modal-input': () => currentInput,
        'pin-modal-confirm': () => currentConfirm,
        'pin-modal-cancel': () => currentCancel,
        'pin-modal-message': { textContent: '' },
        'pin-modal-error': error,
        'pin-modal': modal,
        'modal-overlay': { classList: { add: () => {}, remove: () => {} } },
    };
    return {
        document: {
            body: { classList: { add: () => {}, remove: () => {} } },
            getElementById: (id: string) => typeof elements[id] === 'function' ? elements[id]() : elements[id] || null,
            querySelectorAll: () => [],
        },
        input: () => currentInput,
        confirm: () => currentConfirm,
        error,
    };
}

describe('wallet name prompts', () => {
    const originalDocument = globalThis.document;

    afterEach(() => Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument }));

    it('accepts alphabetic, mixed, Unicode, hyphenated, and apostrophe wallet names after a PIN prompt', async () => {
        const fixture = createModalDocument();
        Object.defineProperty(globalThis, 'document', { configurable: true, value: fixture.document });

        void showPINModal('PIN');
        const pinInput = fixture.input();
        pinInput.value = '12abc';
        pinInput.dispatch('input');

        const prompt = promptForText('Name', '', 'Wallet name');
        const nameInput = fixture.input();
        nameInput.value = "Каса O'Brien-2";
        nameInput.dispatch('input');
        fixture.confirm().click();

        await expect(prompt).resolves.toBe("Каса O'Brien-2");
        expect(nameInput.attributes.get('inputmode')).toBeUndefined();
        expect(nameInput.attributes.get('maxlength')).toBe('30');
    });

    it('keeps empty wallet names inline-invalid', () => {
        const fixture = createModalDocument();
        Object.defineProperty(globalThis, 'document', { configurable: true, value: fixture.document });

        void promptForText('Name', '', 'Wallet name');
        fixture.confirm().click();

        expect(fixture.error.textContent).toBe('Please enter a value');
    });
});
