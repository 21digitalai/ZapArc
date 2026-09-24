export type PinChangeStorage = {
    isWalletUnlocked(): Promise<boolean>;
    getMasterKeyMnemonic(masterKeyId: string, pin: string): Promise<string>;
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
): Promise<void> {
    const validationError = pinChangeValidationError(masterKeyId, currentPin, newPin);
    if (validationError) throw new Error(validationError);

    if (!await storage.isWalletUnlocked()) {
        throw new Error('Unlock the current wallet before changing PIN');
    }

    try {
        await storage.getMasterKeyMnemonic(masterKeyId, currentPin);
    } catch {
        throw new Error('Unlock the current wallet before changing PIN');
    }

    await storage.rotateMasterKeyPin(masterKeyId, currentPin, newPin);
    await storage.resetPinAttempts();
}
