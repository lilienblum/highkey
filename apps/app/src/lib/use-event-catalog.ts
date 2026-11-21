import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { EventDefinition } from "./event-catalog";
export function useEventCatalog(id?: string) {
  return useQuery({
    queryKey: ["event-catalog", id],
    enabled: !!id,
    staleTime: 60000,
    queryFn: ({ signal }) =>
      api<EventDefinition[]>(`/products/${id}/event-catalog`, "GET", undefined, signal),
  });
}
