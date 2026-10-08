import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";

export type DatabaseClient = SupabaseClient<Database>;
export type AuthContext = { supabase: DatabaseClient; userId: string };

type AtomicRateLimitDatabase = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Functions"> & {
    Functions: Database["public"]["Functions"] & {
      consume_rate_limit: {
        Args: { p_bucket: string; p_key_hash: string; p_window_start: string };
        Returns: number;
      };
    };
  };
};

/** RPC installed by 20260921173000, pending generated-schema refresh. */
export function rateLimitDatabase(client: DatabaseClient): SupabaseClient<AtomicRateLimitDatabase> {
  return client as SupabaseClient<AtomicRateLimitDatabase>;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function jsonValue(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, jsonValue(item)]),
    );
  }
  return null;
}
