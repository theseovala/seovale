export const settingsTabIds = [
  "business",
  "platforms",
  "integrations",
  "notifications",
  "locations",
  "account",
] as const;

export type SettingsTab = (typeof settingsTabIds)[number];

export function validateSettingsSearch(search: Record<string, unknown>): { tab?: SettingsTab } {
  const tab = settingsTabIds.find((id) => id === search["tab"]);
  return tab ? { tab } : {};
}
