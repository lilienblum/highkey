// Every minute, under Tako: rewrite the key registry, re-create missing project access (all of it
// after a release changes it) and apply pending retention changes. The next minute is the retry.
import { defineWorkflow } from "tako.sh";
import { apiContext } from "../server/api/context";
import { reconcileOnce } from "../server/registry";

export default defineWorkflow("reconcile", {
  schedule: "* * * * *",
  retries: 0,
  handler: async () => reconcileOnce(apiContext()),
});
