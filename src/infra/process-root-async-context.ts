import { AsyncLocalStorage } from "node:async_hooks";

// The process entry loads this module before any turn or request store exists.
// Process-owned work that starts lazily inside a turn (the CLI loopback listener)
// runs in this context so later requests inherit none of that turn's stores.
export const runInProcessRootAsyncContext = AsyncLocalStorage.snapshot();
