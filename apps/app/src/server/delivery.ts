import https from "node:https";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { LookupFunction } from "node:net";
import { pinnedAddress } from "./auth/cimd-fetch";
import { tako } from "tako.sh";
import { bad } from "./api/errors";
import { one } from "./db/db";
import type { ApiContext } from "./api/context";
export type DestinationKind = "slack" | "discord" | "webhook" | "email";
export type DeliveryConfig = {
  url: string;
  headers: Record<string, string>;
  email: string;
  body: unknown;
};
export type TemplateData = {
  name: string;
  country: string;
  properties: Record<string, unknown>;
  profile: Record<string, unknown>;
  message?: string;
};
export function renderText(text: string, data: TemplateData) {
  return text
    .replace(
      /\{\{\s*(name|country|message|(?:properties|profile)\.[\w./-]{1,64})\s*\}\}/g,
      (_, key: string) => {
        const [kind, ...rest] = key.split(".");
        const obj = rest.length ? data[kind as "profile" | "properties"] : data,
          k = rest.length ? rest.join(".") : kind;
        const v = Object.hasOwn(obj, k) ? (obj as Record<string, unknown>)[k] : undefined;
        return v == null ? "" : String(v);
      },
    )
    .slice(0, 4000);
}
export function bodyTemplate(value: unknown, data: TemplateData): unknown {
  if (typeof value === "string") return renderText(value, data);
  if (Array.isArray(value)) return value.map((v) => bodyTemplate(v, data));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bodyTemplate(v, data)]));
  return value;
}
function key(ctx: ApiContext) {
  if (!ctx.secret) throw bad("Configure a Highkey reader secret before saving destinations");
  return createHash("sha256").update("highkey-delivery-v1\0").update(ctx.secret).digest();
}
export function seal(ctx: ApiContext, id: string, config: DeliveryConfig) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(ctx), iv);
  cipher.setAAD(Buffer.from(id));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64");
}
export function unseal(ctx: ApiContext, id: string, value: string): DeliveryConfig {
  const bytes = Buffer.from(value, "base64"),
    cipher = createDecipheriv("aes-256-gcm", key(ctx), bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(id));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"),
  );
}
export async function webhookPost(url: URL, headers: Record<string, string>, body: string) {
  const address = await pinnedAddress(url);
  return new Promise<void>((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "POST",
        agent: false,
        signal: AbortSignal.timeout(5000),
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          host: url.host,
        },
        lookup: ((_h, o, cb) => {
          if (typeof o === "object" && o.all)
            (cb as (e: null, a: (typeof address)[]) => void)(null, [address]);
          else cb(null, address.address, address.family);
        }) as LookupFunction,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.destroy();
        if (status >= 200 && status < 300) resolve();
        else reject(Error(`Delivery HTTP ${status}`));
      },
    );
    request.once("error", () => reject(Error("Delivery unavailable")));
    request.end(body);
  });
}
export async function hasEmailAccess(ctx: ApiContext, id: string, email: string) {
  return !!(await one(
    ctx.db,
    `SELECT 1 FROM products p JOIN organization o ON o.id=p.org_id JOIN member m ON p.org_id=m.organizationId JOIN user u ON m.userId=u.id
 LEFT JOIN restricted_members r ON r.member_id=m.id LEFT JOIN member_projects g ON g.member_id=m.id AND g.project_id=p.id
  WHERE p.id=? AND p.deleted_at IS NULL AND NOT coalesce(u.banned,0) AND (NOT coalesce(o.requireTwoFactor,0) OR u.twoFactorEnabled=1) AND lower(u.email)=lower(?) AND (m.role IN ('owner','admin') OR r.member_id IS NULL OR g.project_id IS NOT NULL)`,
    [id, email],
  ));
}
export async function deliver(
  ctx: ApiContext,
  project: string,
  kind: DestinationKind,
  c: DeliveryConfig,
  id: string,
  message: string,
  payload: unknown,
) {
  if (kind === "email") {
    if (!(await hasEmailAccess(ctx, project, c.email)))
      throw Error("Email destination no longer has project access");
    const secret = (n: string) =>
      (tako.secrets as Record<string, string | undefined>)[n] ?? process.env[n];
    const uri = secret("HIGHKEY_SMTP_URL"),
      from = secret("HIGHKEY_EMAIL_FROM");
    if (!uri || !from) throw Error("SMTP not configured");
    const { createTransport } = await import("nodemailer");
    const client = createTransport(uri, { disableFileAccess: true, disableUrlAccess: true });
    try {
      await client.sendMail({
        to: c.email,
        from,
        subject: "Highkey notification",
        text: message,
        messageId: `<highkey-${id}@notifications.local>`,
      });
    } finally {
      client.close();
    }
    return;
  }
  const body = JSON.stringify(
    kind === "slack"
      ? { text: message, mrkdwn: false, unfurl_links: false, unfurl_media: false }
      : kind === "discord"
        ? { content: message.slice(0, 2000), allowed_mentions: { parse: [] } }
        : payload,
  );
  await webhookPost(new URL(c.url), { ...c.headers, "idempotency-key": id }, body);
}
