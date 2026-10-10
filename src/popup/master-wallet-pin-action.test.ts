import { describe, expect, it, vi } from 'vitest';
import { attachMasterWalletPinActions } from './master-wallet-pin-action';
import { runPinChangeFlow } from './pin-change-flow';

type ClickListener = (event: Event) => void;

function button(masterId: string) {
    let listener: ClickListener | undefined;
    return {
        getAttribute: vi.fn((name: string) => name === 'data-master-id' ? masterId : null),
        addEventListener: vi.fn((_type: 'click', nextListener: ClickListener) => { listener = nextListener; }),
        click: async () => {
            const event = { stopPropagation: vi.fn() } as unknown as Event;
            listener!(event);
            await vi.waitFor(() => expect(event.stopPropagation).toHaveBeenCalledOnce());
        },
    };
}

function attach(
    buttons: ReturnType<typeof button>[],
    activeWallet: { masterId: string; subWalletIndex: number } | null,
    switchToMaster = vi.fn().mockResolvedValue(undefined),
) {
    const getActiveWallet = vi.fn().mockResolvedValue(activeWallet);
    const dispatchPinChange = vi.fn();
    attachMasterWalletPinActions(
        { querySelectorAll: vi.fn().mockReturnValue(buttons) },
        { switchToMaster, getActiveWallet, dispatchPinChange },
    );
    return { switchToMaster, getActiveWallet, dispatchPinChange };
}

describe('master-wallet Change PIN action', () => {
    it('drives the actual master-menu listener to select and rotate only the target master', async () => {
        const targetButton = button('target');
        let activeMasterId = 'former-active';
        const rotate = vi.fn().mockResolvedValue({ success: true });
        const switchToMaster = vi.fn().mockImplementation(async (masterId: string) => {
            activeMasterId = masterId;
        });
        const dispatchPinChange = vi.fn().mockImplementation(async () => {
            await runPinChangeFlow({
                getActiveWallet: async () => ({ id: activeMasterId, name: activeMasterId }),
                getAuthenticatedSessionPin: async () => activeMasterId === 'target' ? '111111' : null,
                promptForPin: vi.fn().mockResolvedValue('222222'),
                rotate,
                persistSessionPin: vi.fn(),
                showError: vi.fn(),
                showSuccess: vi.fn(),
            });
        });
        attachMasterWalletPinActions(
            { querySelectorAll: vi.fn().mockReturnValue([targetButton]) },
            {
                switchToMaster,
                getActiveWallet: async () => ({ masterId: activeMasterId, subWalletIndex: 0 }),
                dispatchPinChange,
            },
        );

        await targetButton.click();

        await vi.waitFor(() => expect(rotate).toHaveBeenCalledWith('target', '111111', '222222'));
        expect(rotate).not.toHaveBeenCalledWith('former-active', expect.anything(), expect.anything());
        expect(switchToMaster).toHaveBeenCalledWith('target');
    });

    it('has no sub-wallet listener and aborts a cancelled or raced switch before PIN rotation dispatch', async () => {
        const masterButton = button('target');
        const fixture = attach([masterButton], { masterId: 'former-active', subWalletIndex: 0 });

        await masterButton.click();

        expect(fixture.switchToMaster).toHaveBeenCalledWith('target');
        expect(fixture.dispatchPinChange).not.toHaveBeenCalled();
        expect(fixture.getActiveWallet).toHaveBeenCalledOnce();
    });
});
