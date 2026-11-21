import { expect, test } from "bun:test";
import { call, project, testContext, seedEvents, seedLogs } from "./helpers";
import { nightlyProject, insights } from "../src/server/insights";
test("nightly windows flag a referrer spike, retain quiet service evidence and send one weekly digest", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx),
      day = 86400000;
    const monday = new Date();
    monday.setUTCHours(0, 0, 0, 0);
    monday.setUTCDate(monday.getUTCDate() + 7 - ((monday.getUTCDay() + 6) % 7));
    const now = +monday + 3600000;
    const empty = (await call(ctx, "POST", `/api/products/${p.id}/sources`, { name: "No traffic" }))
      .json;
    await ctx.db.execute("UPDATE sources SET created_at=? WHERE id=?", [
      new Date(now - 3 * day).toISOString(),
      empty.id,
    ]);
    for (const kind of ["health", "digest"])
      expect(
        (await call(ctx, "POST", `/api/products/${p.id}/notifications/rules`, { name: kind, kind }))
          .status,
      ).toBe(200);
    await seedEvents(
      p.id,
      Array.from({ length: 12 }, (_, i) => ({
        event_id: `v${i}`,
        time: new Date(+monday - 3600000),
        identity_kind: "visitor",
        actor_id: `a${i}`,
        session_id: "s",
        properties: { path: "/docs", referrer: "example.com" },
      })),
    );
    await seedLogs(p.id, [{ log_id: "l", service: "payments" }]);
    ctx.now = () => new Date(now);
    await nightlyProject(ctx, p.id);
    await nightlyProject(ctx, p.id);
    const report = await insights(ctx, p.id, {
      from: new Date(+monday - day).toISOString(),
      to: monday.toISOString(),
    });
    expect(report.find((t) => t.spike)).toMatchObject({
      current: 12,
      prior: 0,
      label: "example.com",
    });
    expect(report.some((t) => t.dimension === "entry" && t.days === 7)).toBe(true);
    let notices = (await call(ctx, "GET", `/api/products/${p.id}/notifications/history`)).json.map(
      (n: { message: string }) => n.message,
    );
    expect(notices.filter((s: string) => s.startsWith("Weekly digest"))).toHaveLength(1);
    expect(notices).toContain("No data yet from No traffic");
    ctx.now = () => new Date(now + 3 * day);
    await nightlyProject(ctx, p.id);
    notices = (await call(ctx, "GET", `/api/products/${p.id}/notifications/history`)).json.map(
      (n: { message: string }) => n.message,
    );
    expect(notices.some((s: string) => s.includes("payments logs"))).toBe(true);
    expect(notices.filter((s: string) => s.includes("No data yet"))).toHaveLength(1);
  } finally {
    ctx.cleanup();
  }
}, 30000);
