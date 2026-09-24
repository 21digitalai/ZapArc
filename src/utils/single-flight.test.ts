import { describe, expect, it, vi } from 'vitest';
import { createSingleFlight } from './single-flight';

describe('createSingleFlight', () => {
    it('coalesces duplicate clicks into one in-flight operation and permits a later retry', async () => {
        let resolveTask: (() => void) | undefined;
        const task = vi.fn().mockImplementation(() => new Promise<void>(resolve => { resolveTask = resolve; }));
        const run = createSingleFlight(task);
        const first = run();
        const duplicate = run();
        expect(task).toHaveBeenCalledTimes(1);
        expect(duplicate).toBe(first);
        resolveTask!();
        await first;
        const retry = run();
        expect(task).toHaveBeenCalledTimes(2);
        resolveTask!();
        await retry;
    });
});
