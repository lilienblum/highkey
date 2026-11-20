// Wipes a deleted project once its 7-day grace has passed (enqueued by `reconcile` with the id
// `wipe:<project>:<deletedAt>`). Each part is a step, so a retry resumes where the last attempt
// stopped; a project restored meanwhile is left alone.
import { defineWorkflow } from "tako.sh";
import { apiContext } from "../server/api/context";
import { type WipePayload, wipeProject } from "../server/wipe";

export default defineWorkflow<WipePayload>("wipe-project", {
  retries: 5,
  handler: async (payload, ctx) => {
    const result = await wipeProject(apiContext(), payload, (name, work) => ctx.run(name, work));
    if (result === "skipped") await ctx.bail("The project was restored, or is already wiped");
  },
});
