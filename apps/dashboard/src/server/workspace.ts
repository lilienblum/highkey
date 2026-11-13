import { createServerFn } from "@tanstack/react-start";
import type { Product } from "../lib/api";

export const getWorkspace = createServerFn({ method: "GET" }).handler(
  async (): Promise<Product[]> => {
    const { proxyApi } = await import("./api-gateway");
    const response = await proxyApi(new Request("http://localhost/api/products"));
    if (!response.ok)
      throw new Error("Could not load the workspace. Check that the API is running and try again.");
    const projects = await response.json();
    if (!Array.isArray(projects)) throw new Error("The API returned an invalid project list.");
    return projects as Product[];
  },
);
