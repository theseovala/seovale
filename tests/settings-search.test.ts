import { describe, expect, test } from "bun:test";
import { settingsTabIds, validateSettingsSearch } from "../src/lib/settings-search";

describe("Settings search", () => {
  test.each(settingsTabIds)("accepts the %s deep link", (tab) => {
    expect(validateSettingsSearch({ tab })).toEqual({ tab });
  });

  test("invalid, missing and non-string tabs use the default panel", () => {
    for (const tab of [undefined, null, 12, [], {}, "unknown"]) {
      expect(validateSettingsSearch({ tab })).toEqual({});
    }
  });
});
