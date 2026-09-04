import type { DetailedSupportSnapshot } from './support-diagnostics';

export interface SupportExportButton {
    disabled: boolean;
    textContent: string | null;
}

interface DetailedExportDependencies {
    confirm(): Promise<boolean>;
    collect(): Promise<DetailedSupportSnapshot>;
    exportSnapshot(snapshot: DetailedSupportSnapshot): Promise<void>;
    reportError(error: unknown): void;
}

interface ClipboardExportDependencies {
    copy(text: string, successMessage: string): Promise<void>;
    download(text: string, filename: string): void;
    notifyFallback(): void;
    warn(error: unknown): void;
    now(): Date;
}

export async function copySupportExport(
    text: string,
    successMessage: string,
    filenamePrefix: string,
    dependencies: ClipboardExportDependencies,
): Promise<void> {
    try {
        await dependencies.copy(text, successMessage);
    } catch (error) {
        dependencies.download(text, `zaparc-${filenamePrefix}-${dependencies.now().toISOString().replace(/[:.]/g, '-')}.json`);
        dependencies.warn(error);
        dependencies.notifyFallback();
    }
}

/**
 * Keeps the confirmation, collection, and button recovery lifecycle testable
 * without making the transaction-detail renderer own another UI state machine.
 */
export function createDetailedSupportExportHandler(
    button: SupportExportButton,
    dependencies: DetailedExportDependencies,
): () => Promise<void> {
    return async () => {
        if (!await dependencies.confirm()) return;

        button.disabled = true;
        button.textContent = 'Collecting detailed export…';
        try {
            const snapshot = await dependencies.collect();
            await dependencies.exportSnapshot(snapshot);
        } catch (error) {
            dependencies.reportError(error);
        } finally {
            button.disabled = false;
            button.textContent = 'Copy detailed support export';
        }
    };
}
