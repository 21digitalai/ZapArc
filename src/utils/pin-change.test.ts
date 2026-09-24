import { describe, expect, it, vi } from 'vitest';
import { changeActiveWalletPin } from './pin-change';

function storage(overrides: Record<string, unknown> = {}) {
    return {
        isWalletUnlocked: vi.fn().mockResolvedValue(true),
        getMasterKeyMnemonic: vi.fn().mockResolvedValue('seed'),
        resetPinAttempts: vi.fn().mockResolvedValue(undefined),
        rotateMasterKeyPin: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe('changeActiveWalletPin background seam', () => {
    it('rotates only from an unlocked session and resets failed-attempt state after durable success', async () => {
        const manager = storage();
        await changeActiveWalletPin(manager, 'active', '111111', '222222');
        expect(manager.isWalletUnlocked).toHaveBeenCalledTimes(1);
        expect(manager.getMasterKeyMnemonic).toHaveBeenCalledWith('active', '111111');
        expect(manager.rotateMasterKeyPin).toHaveBeenCalledWith('active', '111111', '222222');
        expect(manager.resetPinAttempts).toHaveBeenCalledTimes(1);
    });

    it('rejects a stale session credential without incrementing the PIN lockout counter', async () => {
        const manager = storage({
            getMasterKeyMnemonic: vi.fn().mockRejectedValue(new Error('bad pin')),
        });
        await expect(changeActiveWalletPin(manager, 'active', '111111', '222222')).rejects.toThrow('Unlock the current wallet before changing PIN');
        expect(manager.rotateMasterKeyPin).not.toHaveBeenCalled();
        expect(manager.resetPinAttempts).not.toHaveBeenCalled();
    });

    it('requires the current wallet to be unlocked before rotating', async () => {
        const manager = storage({ isWalletUnlocked: vi.fn().mockResolvedValue(false) });
        await expect(changeActiveWalletPin(manager, 'active', '111111', '222222')).rejects.toThrow('Unlock the current wallet before changing PIN');
        expect(manager.getMasterKeyMnemonic).not.toHaveBeenCalled();
    });

    it('rejects invalid or reused PINs before touching storage', async () => {
        const manager = storage();
        await expect(changeActiveWalletPin(manager, 'active', '111111', '111111')).rejects.toThrow('New PIN must be different');
        await expect(changeActiveWalletPin(manager, 'active', 'bad', '222222')).rejects.toThrow('PIN must contain exactly 6 digits');
        expect(manager.isWalletUnlocked).not.toHaveBeenCalled();
    });
});
