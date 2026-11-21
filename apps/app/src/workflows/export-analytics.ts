import { defineWorkflow } from "tako.sh";
import { apiContext } from "../server/api/context";
import { exportTick } from "../server/export";
export default defineWorkflow("export-analytics", {
  schedule: "* * * * *",
  retries: 0,
  handler: async () => {
    await exportTick(apiContext());
  },
});
