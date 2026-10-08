import { createContext, useContext } from "react";

export const ALL_LOCATIONS = "All locations";

export interface AppState {
  location: string;
  setLocation: (name: string) => void;
  locationNames: string[];
  brandName: string;
}

export const AppStateContext = createContext<AppState | null>(null);

export function useApp() {
  const value = useContext(AppStateContext);
  if (!value) throw new Error("useApp outside AppProvider");
  return value;
}
