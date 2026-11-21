import { expect, test } from "bun:test";
import { project, testContext } from "./helpers";
import { deliver } from "../src/server/delivery";
test("SMTP uses the actual transport and refuses a recipient whose project membership has ended", async () => {
  const ctx = await testContext(),
    p = await project(ctx),
    messages: string[] = [];
  const listener = Bun.listen<{ buf: string; body: boolean }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.data = { buf: "", body: false };
        s.write("220 local test\r\n");
      },
      data(s, chunk) {
        s.data.buf += chunk.toString();
        for (;;) {
          if (s.data.body) {
            const end = s.data.buf.indexOf("\r\n.\r\n");
            if (end < 0) return;
            messages.push(s.data.buf.slice(0, end));
            s.data.buf = s.data.buf.slice(end + 5);
            s.data.body = false;
            s.write("250 accepted\r\n");
            continue;
          }
          const end = s.data.buf.indexOf("\r\n");
          if (end < 0) return;
          const line = s.data.buf.slice(0, end);
          s.data.buf = s.data.buf.slice(end + 2);
          if (line === "DATA") {
            s.data.body = true;
            s.write("354 end with dot\r\n");
          } else if (line === "QUIT") {
            s.end("221 bye\r\n");
            return;
          } else s.write("250 OK\r\n");
        }
      },
    },
  });
  const uri = process.env.HIGHKEY_SMTP_URL,
    from = process.env.HIGHKEY_EMAIL_FROM,
    config = { email: "owner@highkey.test", body: null, headers: {}, url: "" };
  try {
    process.env.HIGHKEY_SMTP_URL = `smtp://127.0.0.1:${listener.port}`;
    process.env.HIGHKEY_EMAIL_FROM = "sender@highkey.test";
    await deliver(ctx, p.id, "email", config, "123", "Release 12", null);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Release 12");
    expect(messages[0]).toContain("Message-ID: <highkey-123@notifications.local>");
    await ctx.db.execute("DELETE FROM member WHERE userId IN (SELECT id FROM user WHERE email=?)", [
      config.email,
    ]);
    await expect(
      deliver(ctx, p.id, "email", config, "124", "Private update", null),
    ).rejects.toThrow("no longer has project access");
    expect(messages).toHaveLength(1);
  } finally {
    listener.stop(true);
    ctx.cleanup();
    if (uri == null) delete process.env.HIGHKEY_SMTP_URL;
    else process.env.HIGHKEY_SMTP_URL = uri;
    if (from == null) delete process.env.HIGHKEY_EMAIL_FROM;
    else process.env.HIGHKEY_EMAIL_FROM = from;
  }
});
