import { defineWorkflow } from "tako.sh";
import { apiContext } from "../server/api/context";
import { notifyTick } from "../server/notifications";
export default defineWorkflow("notify", {
  schedule: "* * * * *",
  retries: 0,
  handler: async (_payload, ctx) => {
    for (let i = 0; i < 12; i++) {
      if (i) await ctx.sleep(`wait-${i}`, 5000);
      if (!(await ctx.run(`deliver-${i}`, () => notifyTick(apiContext())))) break;
    }
  },
});
