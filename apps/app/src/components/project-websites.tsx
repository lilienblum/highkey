import type { ComponentProps } from "react";
import type { Product } from "@/lib/api";
import { Field, FieldDescription, FieldLabel } from "./ui/field";

export const websiteList = (project: Pick<Product, "website_url" | "website_urls">) =>
  project.website_urls ?? (project.website_url ? [project.website_url] : []);

export const parseWebsites = (text: string) =>
  text
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean);

export function ProjectWebsites({ id, ...props }: ComponentProps<"textarea"> & { id: string }) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>Websites</FieldLabel>
      <textarea
        {...props}
        id={id}
        name="websites"
        data-slot="input"
        rows={2}
        className="w-full min-w-0 resize-y rounded-md border border-input bg-surface-inset px-3 py-2 text-base text-foreground placeholder:text-muted-foreground md:text-sm"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-describedby={`${id}-hint`}
        placeholder={"example.com\n*.example.com"}
      />
      <FieldDescription id={`${id}-hint`}>
        Optional. Separate sites with commas or new lines (up to 16). Use *.example.com for
        subdomains.
        <span className="mt-1 block">
          By default, any website with the key can send events. To limit that to specific sites, set
          the key’s allowed origins in Settings.
        </span>
      </FieldDescription>
    </Field>
  );
}
