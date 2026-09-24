export type PinLockout = { locked: boolean; remainingMs?: number };

export type PinChangeStorage = {
    checkPinLockout(): Promise<PinLockout>;
    getMasterKeyMnemonic(masterKeyId: string, pin: string): Promise<string>;
    recordFailedPin(): Promise<void>;
    resetPinAttempts(): Promise<void>;
    rotateMasterKeyPin(masterKeyId: string, currentPin: string, newPin: string): Promise<void>;
};

export function pinChangeValidationError(masterKeyId: unknown, currentPin: unknown, newPin: unknown): string | null {
    if (!masterKeyId || typeof masterKeyId !== 'string') return 'Active wallet is required';
    if (!/^\d{6}$/.test(String(currentPin)) || !/^\d{6}$/.test(String(newPin))) return 'PIN must contain exactly 6 digits';
    if (currentPin === newPin) return 'New PIN must be different';
    return null;
}

export async function changeActiveWalletPin(
    storage: PinChangeStorage,
    masterKeyId: string,
    currentPin: string,
    newPin: string,
    formatLockoutDuration: (remainingMs: number) => string,
): Promise<void> {
    const validationError = pinChangeValidationError(masterKeyId, currentPin, newPin);
    if (validationError) throw new Error(validationError);

    const lockout = await storage.checkPinLockout();
    if (lockout.locked) throw new Error(`Too many failed attempts. Try again in ${formatLockoutDuration(lockout.remainingMs || 0)}.`);

    try {
        await storage.getMasterKeyMnemonic(masterKeyId, currentPin);
    } catch {
        await storage.recordFailedPin();
        const updatedLockout = await storage.checkPinLockout();
        if (updatedLockout.locked) {
            throw new Error(`Too many failed attempts. Try again in ${formatLockoutDuration(updatedLockout.remainingMs || 0)}.`);
        }
        throw new Error('Incorrect PIN');
    }

    await storage.rotateMasterKeyPin(masterKeyId, currentPin, newPin);
    await storage.resetPinAttempts();
}
