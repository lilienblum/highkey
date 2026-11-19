import { authPost } from "@/lib/auth-client";

/** A short slug from a new organization's name; a taken one gets a number. */
function slugFor(name: string): string {
  return (
    name
      .toLowerCase()
      .split(/[^a-z0-9]/)
      .filter(Boolean)
      .join("-")
      .slice(0, 48)
      .replace(/-+$/, "") || "organization"
  );
}

/**
 * Creates an organization the signed-in person owns and returns its slug. Its address comes from
 * the name; a taken or reserved one gets a number. Throws with a message to show on failure.
 */
export async function createOrganization(name: string): Promise<string> {
  const base = slugFor(name);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const slug = attempt === 1 ? base : `${base}-${attempt}`;
    const created = await authPost<{ slug?: string }>("/organization/create", { name, slug });
    if (created.ok && created.data?.slug) return created.data.slug;
    if (created.status !== 400)
      throw new Error(created.error ?? "Could not create the organization.");
  }
  throw new Error("That name’s address is taken. Try another name.");
}
