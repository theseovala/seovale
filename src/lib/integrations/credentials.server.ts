// Encrypted, server-only credential vault for provider applications
// (client IDs, client secrets, API keys). Values are AES-GCM encrypted before
// they touch the database and are never returned to the browser — only a
// masked hint (last 4 characters) is ever exposed.
import { credentialGroupOf, integrationById } from "./registry";
import { decryptValue, encryptValue } from "./crypto.server";

export type CredentialBag = Record<string, string>;

/** Merged credentials for a provider: vault first, server environment as fallback. */
export async function loadProviderCredentials(
  admin: import("../backend-types").DatabaseClient,
  workspaceId: string,
  providerId: string,
): Promise<CredentialBag> {
  const group = credentialGroupOf(providerId);
  const bag: CredentialBag = {};
  const { data, error } = await admin
    .from("integration_provider_credentials")
    .select("field_key,value_ciphertext")
    .eq("workspace_id", workspaceId)
    .eq("provider", group);
  if (error) throw error;
  for (const row of data ?? []) {
    try {
      bag[row.field_key] = await decryptValue(row.value_ciphertext);
    } catch {
      // A value that cannot be decrypted is treated as missing — never as valid.
    }
  }
  return bag;
}

export function maskCredential(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

export async function saveProviderCredentials(
  admin: import("../backend-types").DatabaseClient,
  workspaceId: string,
  providerId: string,
  userId: string,
  values: Record<string, string>,
) {
  const definition = integrationById(providerId);
  const schema = definition?.credentialFields ?? [];
  const group = credentialGroupOf(providerId);
  const saved: string[] = [];
  for (const [key, raw] of Object.entries(values)) {
    if (!schema.some((field) => field.key === key)) continue;
    const value = raw.trim();
    if (!value) continue;
    const { error } = await admin.from("integration_provider_credentials").upsert(
      {
        workspace_id: workspaceId,
        provider: group,
        field_key: key,
        value_ciphertext: await encryptValue(value),
        masked_hint: maskCredential(value),
        updated_by: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,provider,field_key" },
    );
    if (error) throw error;
    saved.push(key);
  }
  return saved;
}

export async function deleteProviderCredentials(
  admin: import("../backend-types").DatabaseClient,
  workspaceId: string,
  providerId: string,
) {
  const { error } = await admin
    .from("integration_provider_credentials")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("provider", credentialGroupOf(providerId));
  if (error) throw error;
}

/** Masked, browser-safe view of which credential fields are stored. */
export async function credentialHints(
  admin: import("../backend-types").DatabaseClient,
  workspaceId: string,
) {
  const { data, error } = await admin
    .from("integration_provider_credentials")
    .select("provider,field_key,masked_hint,updated_at")
    .eq("workspace_id", workspaceId);
  if (error) throw error;
  return (data ?? []) as {
    provider: string;
    field_key: string;
    masked_hint: string;
    updated_at: string;
  }[];
}
