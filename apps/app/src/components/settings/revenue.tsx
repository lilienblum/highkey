import { useState } from "react";
import { api } from "@/lib/api";
import { ErrorState } from "@/components/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { PageLoading } from "../loading";
import { Switch } from "@/components/ui/switch";
import { oversees, useOrganizationRole } from "./settings-nav";
import { useLoaded } from "./use-loaded";

export function RevenueSettings({ projectId }: { projectId: string }) {
  const editable = oversees(useOrganizationRole());
  const path = `/products/${projectId}/revenue/settings`;
  const settings = useLoaded((signal) =>
    api<{ allow_browser_revenue: boolean }>(path, "GET", undefined, signal),
  );
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState<boolean>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue</CardTitle>
        <CardDescription>
          Send integer cents with a secret server key. Zero-value purchases and negative refunds are
          supported. Use one currency per project.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {settings.error ? (
          <ErrorState message={settings.error} retry={settings.reload} />
        ) : !settings.data ? (
          <PageLoading label="Loading revenue settings" />
        ) : (
          <Field orientation="horizontal">
            <div>
              <FieldLabel htmlFor="browser-revenue">Allow browser revenue</FieldLabel>
              <FieldDescription id="browser-revenue-description">
                Accept revenue from public keys, including checkout tracking. Off by default.
                Browser values can be changed by visitors; use server events for payment totals.
                {!editable && " Only owners and admins can change this setting."}
              </FieldDescription>
            </div>
            <Switch
              id="browser-revenue"
              aria-describedby="browser-revenue-description"
              checked={saved ?? settings.data.allow_browser_revenue}
              disabled={!editable || pending}
              onCheckedChange={async (allow) => {
                if (pending) return;
                setPending(true);
                setError("");
                setNotice("");
                try {
                  const result = await api<{ allow_browser_revenue: boolean }>(path, "PATCH", {
                    allow_browser_revenue: allow,
                  });
                  setSaved(result.allow_browser_revenue);
                  setNotice("Revenue settings saved. Collection updates within a few seconds.");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setPending(false);
                }
              }}
            />
          </Field>
        )}
        {error && <ErrorState message={error} />}
        <p className="quiet mt-3" role="status">
          {pending ? "Saving…" : notice}
        </p>
      </CardContent>
    </Card>
  );
}
