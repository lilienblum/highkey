import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { PageLoading } from "@/components/loading";
import { routeTree } from "./routeTree.gen";
export function getRouter() {
  // One query cache per page load (and per server render), shared by route loaders and pages:
  // analytics, widget runs and dashboard documents stay cached across navigation.
  const queryClient = new QueryClient();
  return createRouter({
    routeTree,
    context: { queryClient },
    trailingSlash: "never",
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPendingComponent: PageLoading,
    defaultPendingMs: 150,
    defaultPendingMinMs: 0,
  });
}
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
