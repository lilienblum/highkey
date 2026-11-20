// Every minute, under Tako: rewrite the key registry, re-create missing project access (all of it
// after a release changes it), apply pending retention changes, and enqueue the wipe of a project
// whose 7-day grace has passed. The next minute is the retry.
import { defineWorkflow } from "tako.sh";
import { apiContext } from "../server/api/context";
import { reconcileOnce } from "../server/registry";
import { wipeRunId } from "../server/wipe";
import wipeProject from "./wipe-project";

export default defineWorkflow("reconcile", {
  schedule: "* * * * *",
  retries: 0,
  handler: async () =>
    reconcileOnce(apiContext(), {
      wipe: (payload) => wipeProject.enqueue(payload, { id: wipeRunId(payload) }),
    }),
});
