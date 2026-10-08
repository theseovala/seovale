import { useMemo, useState, type ReactNode } from "react";
import { useLocations, useBrandSettings } from "./seovale-db";
import { BRAND } from "./domain";

import { ALL_LOCATIONS, AppStateContext, type AppState } from "./app-state";

export function AppProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<string>(ALL_LOCATIONS);
  const { data: locations } = useLocations();
  const { data: brand } = useBrandSettings();

  const value = useMemo<AppState>(
    () => ({
      location,
      setLocation,
      locationNames: [ALL_LOCATIONS, ...(locations ?? []).map((l) => l.name)],
      brandName: brand?.brand_name ?? BRAND.name,
    }),
    [location, locations, brand],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}
