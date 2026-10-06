import type { UpdateCommandOptions } from "./shared.js";

/** Reuse the admitted update budget for its own durable ledger operations. */
export function updateRunLedgerOptions(
  run: Pick<NonNullable<UpdateCommandOptions["run"]>, "env" | "ledgerBusyTimeoutMs">,
) {
  return { env: run.env, busyTimeoutMs: run.ledgerBusyTimeoutMs };
}
