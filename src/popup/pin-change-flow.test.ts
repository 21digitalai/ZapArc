import { describe, expect, it, vi } from 'vitest';
import { runPinChangeFlow } from './pin-change-flow';

function flow(
    prompts: Array<string | null>,
    rotate = vi.fn().mockResolvedValue({ success: true }),
    sessionPin: string | null = '111111',
) {
    const persistSessionPin = vi.fn().mockResolvedValue(undefined);
    const showError = vi.fn();
    const showSuccess = vi.fn();
    const promptForPin = vi.fn().mockImplementation(() => Promise.resolve(prompts.shift() || null));
    return {
        rotate, persistSessionPin, showError, showSuccess, promptForPin,
        run: () => runPinChangeFlow({
            getActiveWallet: vi.fn().mockResolvedValue({ id: 'active', name: 'Primary' }),
            getAuthenticatedSessionPin: vi.fn().mockResolvedValue(sessionPin),
            promptForPin,
            rotate,
            persistSessionPin,
            showError,
            showSuccess,
        }),
    };
}

describe('Settings Change PIN popup flow seam', () => {
    it('does not send a rotation request for a confirmation mismatch', async () => {
        const fixture = flow(['222222', '333333']);
        await fixture.run();
        expect(fixture.rotate).not.toHaveBeenCalled();
        expect(fixture.persistSessionPin).not.toHaveBeenCalled();
        expect(fixture.showError).toHaveBeenCalledWith('New PINs do not match');
    });

    it('updates the session only after a durable background success', async () => {
        let resolveRotation: ((value: { success: boolean }) => void) | undefined;
        const rotate = vi.fn().mockImplementation(() => new Promise<{ success: boolean }>(resolve => { resolveRotation = resolve; }));
        const fixture = flow(['222222', '222222'], rotate);
        const running = fixture.run();
        await vi.waitFor(() => expect(rotate).toHaveBeenCalledTimes(1));
        expect(fixture.persistSessionPin).not.toHaveBeenCalled();
        resolveRotation!({ success: true });
        await running;
        expect(fixture.persistSessionPin).toHaveBeenCalledWith('222222');
        expect(fixture.showSuccess).toHaveBeenCalledTimes(1);
    });

    it('keeps the existing session PIN when the background rotation fails', async () => {
        const fixture = flow(['222222', '222222'], vi.fn().mockResolvedValue({ success: false, error: 'Storage unavailable' }));
        await fixture.run();
        expect(fixture.persistSessionPin).not.toHaveBeenCalled();
        expect(fixture.showError).toHaveBeenCalledWith('Storage unavailable');
    });

    it('requires an authenticated session without prompting for the old PIN', async () => {
        const fixture = flow(['222222', '222222'], undefined, null);
        await fixture.run();
        expect(fixture.rotate).not.toHaveBeenCalled();
        expect(fixture.promptForPin).toHaveBeenCalledTimes(2);
        expect(fixture.showError).toHaveBeenCalledWith('Unlock the current wallet before changing PIN');
    });

    it('rejects a wallet switch between opening the modal and commit', async () => {
        const getActiveWallet = vi.fn()
            .mockResolvedValueOnce({ id: 'active', name: 'Primary' })
            .mockResolvedValueOnce({ id: 'other', name: 'Other' });
        const rotate = vi.fn().mockResolvedValue({ success: true });
        const showError = vi.fn();
        await runPinChangeFlow({
            getActiveWallet,
            getAuthenticatedSessionPin: vi.fn().mockResolvedValue('111111'),
            promptForPin: vi.fn().mockResolvedValue('222222'),
            rotate,
            persistSessionPin: vi.fn(),
            showError,
            showSuccess: vi.fn(),
        });
        expect(rotate).not.toHaveBeenCalled();
        expect(showError).toHaveBeenCalledWith('Active wallet changed; try again');
    });
});
