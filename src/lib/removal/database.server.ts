import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import type { DatabaseClient } from "../backend-types";

type RemovalColumns = {
  route: string | null;
  evidence: Json | null;
  outcome: string | null;
  outcome_at: string | null;
};
type WithColumns<T extends { Row: object; Insert: object; Update: object }, Columns> = Omit<
  T,
  "Row" | "Insert" | "Update"
> & {
  Row: T["Row"] & Columns;
  Insert: T["Insert"] & Partial<Columns>;
  Update: T["Update"] & Partial<Columns>;
};
type RemovalDatabase = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Tables"> & {
    Tables: Omit<Database["public"]["Tables"], "reviews" | "removal_cases"> & {
      reviews: WithColumns<Database["public"]["Tables"]["reviews"], { review_url: string | null }>;
      removal_cases: WithColumns<Database["public"]["Tables"]["removal_cases"], RemovalColumns>;
    };
  };
};

/** Columns installed by 20260922040000, not yet included in the generated schema. */
export function removalDatabase(client: DatabaseClient): SupabaseClient<RemovalDatabase> {
  return client as SupabaseClient<RemovalDatabase>;
}
