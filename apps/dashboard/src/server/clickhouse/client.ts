// A small client for ClickHouse's HTTP interface. Values reach ClickHouse as bound query
// parameters, never spliced into SQL text.

export interface ClickHouseConfig {
  url: string;
  user: string;
  password: string;
}

export type ParamValue = string | number | boolean | null | readonly string[];

export interface QueryOptions {
  params?: Record<string, ParamValue>;
  settings?: Record<string, string | number>;
  signal?: AbortSignal;
  queryId?: string;
}

export interface ChResult<Row> {
  meta: { name: string; type: string }[];
  data: Row[];
  rows: number;
}

// Codes that mean "try again later" rather than "this request is wrong".
const TRANSIENT_CODES = new Set([159, 202, 209, 210, 241, 252]);

export class ClickHouseError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly status: number,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "ClickHouseError";
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/** Encodes a parameter in the text form ClickHouse parses for `{name:Type}`. */
export function encodeParam(value: ParamValue): string {
  if (value === null) return "\\N";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string")
    return value
      .replaceAll("\\", "\\\\")
      .replaceAll("\t", "\\t")
      .replaceAll("\n", "\\n")
      .replaceAll("\r", "\\r");
  return `[${value.map(quote).join(",")}]`;
}

export class ClickHouse {
  constructor(readonly config: ClickHouseConfig) {}

  private async send(
    sql: string,
    options: QueryOptions,
    extra: Record<string, string> = {},
  ): Promise<string> {
    const url = new URL(this.config.url);
    url.pathname = "/";
    for (const [name, value] of Object.entries(extra)) url.searchParams.set(name, value);
    for (const [name, value] of Object.entries(options.settings ?? {}))
      url.searchParams.set(name, String(value));
    for (const [name, value] of Object.entries(options.params ?? {}))
      url.searchParams.set(`param_${name}`, encodeParam(value));
    if (options.queryId) url.searchParams.set("query_id", options.queryId);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "X-ClickHouse-User": this.config.user,
          "X-ClickHouse-Key": this.config.password,
          "Content-Type": "text/plain; charset=utf-8",
        },
        body: sql,
        signal: options.signal,
      });
    } catch (error) {
      // The caller's own deadline or cancellation, not ClickHouse failing.
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ClickHouseError(`ClickHouse is unreachable: ${message}`, null, 0, true);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      throw error;
    }
    if (!response.ok) {
      const header = response.headers.get("x-clickhouse-exception-code");
      const parsed = header ?? /^Code: (\d+)/.exec(text)?.[1] ?? null;
      const code = parsed === null ? null : Number(parsed);
      const transient = response.status >= 500 && (code === null || TRANSIENT_CODES.has(code));
      throw new ClickHouseError(text.trim(), code, response.status, transient);
    }
    return text;
  }

  /** Runs a query and returns its rows. The whole result is buffered, so errors are not lost. */
  async query<Row = Record<string, unknown>>(
    sql: string,
    options: QueryOptions = {},
  ): Promise<ChResult<Row>> {
    const text = await this.send(sql, options, {
      default_format: "JSON",
      wait_end_of_query: "1",
    });
    const parsed = JSON.parse(text) as ChResult<Row>;
    return { meta: parsed.meta, data: parsed.data, rows: parsed.rows };
  }

  /** Runs a statement that returns nothing. */
  async command(sql: string, options: QueryOptions = {}): Promise<void> {
    await this.send(sql, options);
  }

  /** Inserts rows as JSONEachRow; columns missing from a row take their defaults. */
  async insert(table: string, rows: readonly object[], options: QueryOptions = {}): Promise<void> {
    if (rows.length === 0) return;
    const body = rows.map((row) => JSON.stringify(row)).join("\n");
    await this.send(`INSERT INTO ${table} FORMAT JSONEachRow\n${body}`, options);
  }
}

export function adminClient(env: Record<string, string | undefined> = process.env): ClickHouse {
  return new ClickHouse({
    url: env.PIKO_CLICKHOUSE_URL ?? "http://127.0.0.1:8123",
    user: env.PIKO_CLICKHOUSE_USER ?? "piko_admin",
    password: env.PIKO_CLICKHOUSE_PASSWORD ?? "",
  });
}
