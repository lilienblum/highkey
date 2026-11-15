// Every read of project data runs as that project's ClickHouse reader. A reader that does not
// exist yet, or a ClickHouse that is down, answers 503 analytics_unavailable rather than 500.
import type { ApiContext } from "../api/context";
import { analyticsUnavailable } from "../api/errors";
import { type ClickHouse, ClickHouseError } from "../clickhouse/client";

// AUTHENTICATION_FAILED, UNKNOWN_USER, UNKNOWN_DATABASE, UNKNOWN_TABLE.
const NOT_PROVISIONED = new Set([516, 192, 81, 60]);

export async function readAs<T>(
  ctx: ApiContext,
  productId: string,
  run: (reader: ClickHouse) => Promise<T>,
): Promise<T> {
  try {
    return await run(ctx.readers.reader(productId));
  } catch (error) {
    if (
      error instanceof ClickHouseError &&
      (error.transient || (error.code !== null && NOT_PROVISIONED.has(error.code)))
    )
      throw analyticsUnavailable();
    throw error;
  }
}
