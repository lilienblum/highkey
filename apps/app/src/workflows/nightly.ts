import { defineWorkflow } from "tako.sh";
import { apiContext } from "../server/api/context";
import { nightlyTick } from "../server/insights";
export default defineWorkflow("nightly", {
  schedule: "8 * * * *",
  retries: 0,
  handler: async () => nightlyTick(apiContext()),
});
