import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { oversees, useOrganizationRole } from "./settings/settings-nav";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { Switch } from "./ui/switch";
export function ExportSettings({ id }: { id: string }) {
  const role = useOrganizationRole(),
    [pending, setPending] = useState(""),
    [error, setError] = useState("");
  const info = useQuery({
    queryKey: ["continuous-export", id],
    enabled: oversees(role),
    queryFn: ({ signal }) =>
      api<{
        configured: boolean;
        streams: { signal: string; enabled: number; updated_ms: number | null }[];
      }>(`/products/${id}/export`, "GET", undefined, signal),
  });
  if (!oversees(role)) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Continuous export</CardTitle>
        <CardDescription>
          Send new events or logs to the server’s private object-storage bucket every minute.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {info.data && !info.data.configured && (
          <p>Configure the server’s export bucket and credentials to enable delivery.</p>
        )}
        {["events", "logs"].map((signal) => {
          const row = info.data?.streams.find((s) => s.signal === signal);
          return (
            <label className="flex items-center justify-between gap-3" key={signal}>
              Export {signal}
              {row?.updated_ms && (
                <small>Last upload {new Date(row.updated_ms).toISOString().slice(0, 19)} UTC</small>
              )}
              <Switch
                checked={!!row?.enabled}
                disabled={!!pending || (!row?.enabled && !info.data?.configured)}
                onCheckedChange={async (enabled) => {
                  setPending(signal);
                  setError("");
                  try {
                    await api(`/products/${id}/export`, "PUT", { signal, enabled });
                    await info.refetch();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setPending("");
                  }
                }}
              />
            </label>
          );
        })}
        {(error || info.error) && <p role="alert">{error || info.error?.message}</p>}
      </CardContent>
    </Card>
  );
}
