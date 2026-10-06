import { afterEach, describe, expect, mock, test } from "bun:test";
import { scanGooglePlace, searchGooglePlaces } from "../src/lib/google-places.server";
import { testApiKeyProvider } from "../src/lib/integrations/providers.server";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Google Places API (New)", () => {
  test("searches businesses with Text Search and keeps the key in a header", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      request = { url: String(input), init };
      return Response.json({
        places: [
          {
            id: "ChIJFixtureCafe",
            displayName: { text: "Fixture Cafe" },
            formattedAddress: "1 Example Street, Example City",
          },
        ],
      });
    }) as typeof fetch;

    const places = await searchGooglePlaces("Fixture Cafe, Example City", "fixture-secret");

    expect(request?.url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(request?.url).not.toContain("fixture-secret");
    expect(new Headers(request?.init?.headers).get("X-Goog-Api-Key")).toBe("fixture-secret");
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      textQuery: "Fixture Cafe, Example City",
    });
    expect(places).toEqual([
      {
        placeId: "ChIJFixtureCafe",
        name: "Fixture Cafe",
        address: "1 Example Street, Example City",
      },
    ]);
  });

  test("maps transient details, preserves Google review order and accepts only Google's report URI", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        id: "ChIJFixtureCafe",
        displayName: { text: "Fixture Cafe" },
        rating: 4.6,
        userRatingCount: 28,
        googleMapsUri: "https://maps.google.com/?cid=fixture",
        reviews: Array.from({ length: 6 }, (_, index) => ({
          rating: 5 - (index % 5),
          text: { text: `FIXTURE review ${index + 1}`, languageCode: "en" },
          originalText: { text: `FIXTURE original ${index + 1}`, languageCode: "en" },
          authorAttribution: {
            displayName: `Fixture author ${index + 1}`,
            uri: "https://www.google.com/maps/contrib/fixture",
            photoUri: "https://lh3.googleusercontent.com/fixture",
          },
          googleMapsUri: `https://www.google.com/maps/reviews/data=fixture-${index + 1}`,
          flagContentUri:
            index === 0
              ? "https://www.google.com/local/review/rap/report?reviewId=fixture"
              : "https://attacker.example/local/review/rap/report",
          publishTime: "2025-01-02T00:00:00Z",
          relativePublishTimeDescription: "a year ago",
        })),
      }),
    ) as typeof fetch;

    const snapshot = await scanGooglePlace("ChIJFixtureCafe", "fixture-secret");

    expect(snapshot.placeId).toBe("ChIJFixtureCafe");
    expect(snapshot.rating).toBe(4.6);
    expect(snapshot.ratingCount).toBe(28);
    expect(snapshot.mapsUrl).toBe("https://maps.google.com/?cid=fixture");
    expect(snapshot.reviews).toHaveLength(5);
    expect(snapshot.reviews.map((review) => review.author)).toEqual([
      "Fixture author 1",
      "Fixture author 2",
      "Fixture author 3",
      "Fixture author 4",
      "Fixture author 5",
    ]);
    expect(snapshot.reviews[0]?.flagContentUrl).toBe(
      "https://www.google.com/local/review/rap/report?reviewId=fixture",
    );
    expect(snapshot.reviews[1]?.flagContentUrl).toBeNull();
    expect(snapshot.reviews[0]?.originalText).toBe("FIXTURE original 1");
  });

  test("preserves the real Google HTTP status, API status and reason on scan errors", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          error: {
            code: 403,
            message: "Places API has not been used in this project.",
            status: "PERMISSION_DENIED",
            details: [{ reason: "API_DISABLED" }],
          },
        },
        { status: 403 },
      ),
    ) as typeof fetch;

    await expect(scanGooglePlace("ChIJFixtureCafe", "fixture-secret")).rejects.toThrow(
      "HTTP 403; Google status PERMISSION_DENIED; reason API_DISABLED",
    );
  });

  test("rejects invented report URLs and non-Google Maps review links", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        id: "ChIJFixtureCafe",
        reviews: [
          {
            rating: 1,
            text: { text: "FIXTURE review" },
            googleMapsUri: "https://attacker.example/review",
            flagContentUri: "https://attacker.example/local/review/rap/report",
          },
        ],
      }),
    ) as typeof fetch;

    const snapshot = await scanGooglePlace("ChIJFixtureCafe", "fixture-secret");
    expect(snapshot.reviews).toEqual([]);
  });
});

describe("Google Maps provider verification", () => {
  test("uses a real Text Search request before a Place ID is selected", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      request = { url: String(input), init };
      return Response.json({ places: [] });
    }) as typeof fetch;

    const result = await testApiKeyProvider("google_maps", null, {
      GOOGLE_MAPS_API_KEY: "fixture-secret",
    });

    expect(request?.url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(new Headers(request?.init?.headers).get("X-Goog-Api-Key")).toBe("fixture-secret");
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.message).toContain("SearchText verified");
  });

  test("reports upstream HTTP status, Google status and API-disabled reason", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          error: {
            code: 403,
            message: "Places API is disabled.",
            status: "PERMISSION_DENIED",
            details: [{ reason: "API_DISABLED" }],
          },
        },
        { status: 403 },
      ),
    ) as typeof fetch;

    const result = await testApiKeyProvider("google_maps", null, {
      GOOGLE_MAPS_API_KEY: "fixture-secret",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.code).toBe("APPROVAL_REQUIRED");
    expect(result.message).toContain("HTTP 403");
    expect(result.message).toContain("PERMISSION_DENIED");
    expect(result.message).toContain("API_DISABLED");
    expect(result.message).not.toContain("fixture-secret");
  });
});
