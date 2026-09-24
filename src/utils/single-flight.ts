export function createSingleFlight(task: () => Promise<void>): () => Promise<void> {
    let inFlight: Promise<void> | null = null;

    return () => {
        if (inFlight) return inFlight;
        inFlight = task().finally(() => { inFlight = null; });
        return inFlight;
    };
}
