import { createServerFn } from "@tanstack/react-start";
import type { Product } from "../lib/api";

export const getWorkspace = createServerFn({ method: "GET" }).handler(
  async (): Promise<Product[]> => {
    const { serveApi, visitorRequest } = await import("./api/serve");
    const { getRequest } = await import("@tanstack/react-start/server");
    const response = await serveApi(visitorRequest(getRequest(), "/api/products"));
    if (!response.ok)
      throw new Error(
        "Could not load the workspace. Check that ClickHouse is running and try again.",
      );
    const projects = await response.json();
    if (!Array.isArray(projects)) throw new Error("The API returned an invalid project list.");
    return projects as Product[];
  },
);
