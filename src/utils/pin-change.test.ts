import { describe, expect, it, vi } from 'vitest';
import { changeActiveWalletPin } from './pin-change';

function storage(overrides: Record<string, unknown> = {}) {
    return {
        checkPinLockout: vi.fn().mockResolvedValue({ locked: false }),
        getMasterKeyMnemonic: vi.fn().mockResolvedValue('seed'),
        recordFailedPin: vi.fn().mockResolvedValue(undefined),
        resetPinAttempts: vi.fn().mockResolvedValue(undefined),
        rotateMasterKeyPin: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe('changeActiveWalletPin background seam', () => {
    it('rotates only after current-PIN proof and clears failed-attempt state after durable success', async () => {
        const manager = storage();
        await changeActiveWalletPin(manager, 'active', '111111', '222222', ms => `${ms}ms`);
        expect(manager.getMasterKeyMnemonic).toHaveBeenCalledWith('active', '111111');
        expect(manager.rotateMasterKeyPin).toHaveBeenCalledWith('active', '111111', '222222');
        expect(manager.resetPinAttempts).toHaveBeenCalledTimes(1);
    });

    it('records a wrong current PIN and returns lockout-safe feedback without rotating', async () => {
        const manager = storage({
            getMasterKeyMnemonic: vi.fn().mockRejectedValue(new Error('bad pin')),
            checkPinLockout: vi.fn().mockResolvedValueOnce({ locked: false }).mockResolvedValueOnce({ locked: true, remainingMs: 1200 }),
        });
        await expect(changeActiveWalletPin(manager, 'active', '111111', '222222', ms => `${ms}ms`)).rejects.toThrow('Too many failed attempts. Try again in 1200ms.');
        expect(manager.recordFailedPin).toHaveBeenCalledTimes(1);
        expect(manager.rotateMasterKeyPin).not.toHaveBeenCalled();
        expect(manager.resetPinAttempts).not.toHaveBeenCalled();
    });

    it('rejects invalid or reused PINs before touching storage', async () => {
        const manager = storage();
        await expect(changeActiveWalletPin(manager, 'active', '111111', '111111', ms => `${ms}ms`)).rejects.toThrow('New PIN must be different');
        await expect(changeActiveWalletPin(manager, 'active', 'bad', '222222', ms => `${ms}ms`)).rejects.toThrow('PIN must contain exactly 6 digits');
        expect(manager.checkPinLockout).not.toHaveBeenCalled();
    });
});
