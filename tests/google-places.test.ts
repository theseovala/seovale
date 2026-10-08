import { afterEach, describe, expect, test } from "bun:test";
import {
  resolveGoogleMapsUrl,
  scanGooglePlace,
  searchGooglePlaces,
} from "../src/lib/google-places.server";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("uses a Place ID embedded in a Google Maps URL without a manual ID field", async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const result = await resolveGoogleMapsUrl(
    "https://www.google.com/maps/search/?api=1&query_place_id=ChIJN1t_tDeuEmsRUsoyG83frY4",
    "places-test-key",
  );

  expect(result.placeId).toBe("ChIJN1t_tDeuEmsRUsoyG83frY4");
  expect(called).toBe(false);
});

describe("public Google Places review scan", () => {
  test.each([
    "https://maps.google.com/?q=37.7936,-122.3972",
    "https://www.google.com/maps/search/?api=1&query=37.7936,-122.3972",
    "https://www.google.com/maps/place/37.7936,-122.3972",
  ])("resolves coordinate parameters and paths: %s", async (url) => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return Response.json({
        status: "OK",
        results: [{ place_id: "ChIJCoordinateAddress", formatted_address: "An address" }],
      });
    }) as typeof fetch;
    await resolveGoogleMapsUrl(url, "test-key");
    expect(new URL(requestedUrl).searchParams.get("latlng")).toBe("37.7936,-122.3972");
  });

  test("preserves an address containing numbers separated by a comma", async () => {
    let textQuery = "";
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      textQuery = JSON.parse(String(init?.body)).textQuery;
      return Response.json({
        places: [{ id: "ChIJAddress", displayName: { text: "An address" } }],
      });
    }) as typeof fetch;
    await resolveGoogleMapsUrl("https://maps.google.com/?q=Shop+12,+34+Main+Street", "test-key");
    expect(textQuery).toBe("Shop 12, 34 Main Street");
  });

  test("uses listing coordinates rather than viewport coordinates or hex feature IDs", async () => {
    let requestBody: unknown;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ places: [{ id: "ChIJActualPlace", displayName: { text: "Cafe" } }] });
    }) as typeof fetch;
    const result = await resolveGoogleMapsUrl(
      "https://www.google.com/maps/place/Cafe/@40,-74,12z/data=!4m2!1s0x808fba027:0x12345678!3d37.7936!4d-122.3972",
      "test-key",
    );
    expect(result.placeId).toBe("ChIJActualPlace");
    expect(requestBody).toMatchObject({
      locationBias: { circle: { center: { latitude: 37.7936, longitude: -122.3972 } } },
    });
  });

  test("fetches the selected place rating and only the public excerpts Google returns", async () => {
    let requestedUrl = "";
    let sentHeaders = new Headers();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      sentHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          id: "ChIJplace",
          displayName: { text: "Example Cafe" },
          formattedAddress: "1 Main St, Example City",
          location: { latitude: 37.422, longitude: -122.084 },
          rating: 4.7,
          userRatingCount: 128,
          googleMapsUri: "https://maps.google.com/?cid=123",
          reviews: [
            {
              rating: 5,
              text: { text: "Excellent coffee.", languageCode: "en" },
              originalText: { text: "Excellent coffee.", languageCode: "en" },
              authorAttribution: {
                displayName: "A Reviewer",
                uri: "https://www.google.com/maps/contrib/123",
                photoUri: "https://lh3.googleusercontent.com/a/reviewer",
              },
              publishTime: "2026-10-01T10:00:00Z",
              relativePublishTimeDescription: "2 weeks ago",
              visitDate: { year: 2026, month: 9 },
              googleMapsUri: "https://www.google.com/maps/reviews/data=!4m6!14m5",
              flagContentUri: "https://www.google.com/local/review/rap/report?postId=CJ2&t=1",
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await scanGooglePlace("ChIJplace", "places-test-key");

    expect(requestedUrl).toBe("https://places.googleapis.com/v1/places/ChIJplace");
    expect(requestedUrl).not.toContain("places-test-key");
    expect(sentHeaders.get("X-Goog-Api-Key")).toBe("places-test-key");
    expect(sentHeaders.get("X-Goog-FieldMask")).toContain("reviews.flagContentUri");
    expect(sentHeaders.get("X-Goog-FieldMask")).toContain("formattedAddress");
    expect(sentHeaders.get("X-Goog-FieldMask")).toContain("location");
    expect(sentHeaders.get("X-Goog-FieldMask")).toContain("reviews.googleMapsUri");
    expect(sentHeaders.get("X-Goog-FieldMask")).toContain("reviews.authorAttribution.uri");
    expect(sentHeaders.get("X-Goog-FieldMask")).toContain("reviews.authorAttribution.photoUri");
    expect(sentHeaders.get("X-Goog-FieldMask")).toContain("reviews.originalText");
    expect(sentHeaders.get("X-Goog-FieldMask")).toContain("reviews.visitDate");
    expect(result).toMatchObject({
      placeId: "ChIJplace",
      name: "Example Cafe",
      address: "1 Main St, Example City",
      coordinates: { latitude: 37.422, longitude: -122.084 },
      rating: 4.7,
      ratingCount: 128,
      reviews: [
        {
          author: "A Reviewer",
          authorPhotoUrl: "https://lh3.googleusercontent.com/a/reviewer",
          rating: 5,
          text: "Excellent coffee.",
          originalText: "Excellent coffee.",
          textLanguage: "en",
          originalLanguage: "en",
          authorUrl: "https://www.google.com/maps/contrib/123",
          publishedAt: "2026-10-01T10:00:00Z",
          relativePublishedAt: "2 weeks ago",
          visitYear: 2026,
          visitMonth: 9,
          reviewUrl: "https://www.google.com/maps/reviews/data=!4m6!14m5",
          flagContentUrl: "https://www.google.com/local/review/rap/report?postId=CJ2&t=1",
        },
      ],
      mapsUrl: "https://maps.google.com/?cid=123",
      reviewOrder: "google_selected",
    });
    expect(result.scannedAt).toBeTruthy();
  });

  test("preserves rating-only excerpts without inventing review text", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "ChIJplace",
          displayName: { text: "Example Cafe" },
          rating: 3.8,
          userRatingCount: 12,
          reviews: [
            {
              rating: 4,
              googleMapsUri: "https://www.google.com/maps/reviews/data=!4m6!14m5",
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const result = await scanGooglePlace("ChIJplace", "places-test-key");

    expect(result.reviews).toEqual([
      {
        author: null,
        authorUrl: null,
        authorPhotoUrl: null,
        rating: 4,
        text: "",
        originalText: null,
        textLanguage: null,
        originalLanguage: null,
        publishedAt: null,
        relativePublishedAt: null,
        visitYear: null,
        visitMonth: null,
        reviewUrl: "https://www.google.com/maps/reviews/data=!4m6!14m5",
        flagContentUrl: null,
      },
    ]);
  });

  test("caps the displayed excerpts at five even if a provider response contains more", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "ChIJplace",
          displayName: { text: "Example Cafe" },
          reviews: Array.from({ length: 8 }, (_, index) => ({
            rating: 5,
            authorAttribution: { displayName: `Reviewer ${index}` },
            googleMapsUri: `https://www.google.com/maps/reviews/data=!4m6!14m${index}`,
          })),
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const result = await scanGooglePlace("ChIJplace", "places-test-key");

    expect(result.reviews).toHaveLength(5);
  });

  test("surfaces provider errors instead of returning a success-shaped fallback", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "This API is not activated on your API project.",
            status: "PERMISSION_DENIED",
            details: [{ reason: "SERVICE_DISABLED" }],
          },
        }),
        { status: 403 },
      )) as unknown as typeof fetch;

    await expect(scanGooglePlace("ChIJplace", "places-test-key")).rejects.toThrow(
      "Google Places scan failed (HTTP 403; Google status PERMISSION_DENIED; reason SERVICE_DISABLED): This API is not activated on your API project.",
    );
  });

  test("rejects missing place IDs before making a request", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(scanGooglePlace(" ", "places-test-key")).rejects.toThrow(
      "Enter a Google Place ID",
    );
    expect(called).toBe(false);
  });

  test("place search resolves real Places IDs without exposing the key in the request URL", async () => {
    let requestedUrl = "";
    let requestBody = "";
    let sentHeaders = new Headers();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestBody = String(init?.body ?? "");
      sentHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          places: [
            {
              id: "ChIJplace",
              displayName: { text: "Example Cafe" },
              formattedAddress: "1 Main St, Example City",
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await searchGooglePlaces("Example Cafe, Example City", "places-test-key");

    expect(requestedUrl).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(requestedUrl).not.toContain("places-test-key");
    expect(sentHeaders.get("X-Goog-Api-Key")).toBe("places-test-key");
    expect(sentHeaders.get("X-Goog-FieldMask")).toBe(
      "places.id,places.displayName,places.formattedAddress",
    );
    expect(JSON.parse(requestBody)).toEqual({ textQuery: "Example Cafe, Example City" });
    expect(result).toEqual([
      { placeId: "ChIJplace", name: "Example Cafe", address: "1 Main St, Example City" },
    ]);
  });

  test("discards a provider-supplied report URL that is not Google's exact hosted flag path", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "ChIJplace",
          displayName: { text: "Example Cafe" },
          reviews: [
            {
              rating: 1,
              flagContentUri: "https://attacker.example/local/review/rap/report?postId=forged",
              googleMapsUri: "https://www.google.com/maps/reviews/data=!4m6!14m5",
              authorAttribution: {
                displayName: "A Reviewer",
                uri: "javascript:alert(1)",
                photoUri: "https://attacker-googleusercontent.com/avatar",
              },
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const result = await scanGooglePlace("ChIJplace", "places-test-key");

    expect(result.reviews).toMatchObject([
      {
        authorUrl: null,
        authorPhotoUrl: null,
        reviewUrl: "https://www.google.com/maps/reviews/data=!4m6!14m5",
        flagContentUrl: null,
      },
    ]);
  });

  test("rejects too-short place searches before making a provider call", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(searchGooglePlaces("ab", "places-test-key")).rejects.toThrow(
      "at least 3 characters",
    );
    expect(called).toBe(false);
  });

  test("resolves a Google Maps search URL using Google Places Text Search and its coordinates", async () => {
    let requestedUrl = "";
    let requestBody: unknown;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          places: [
            {
              id: "ChIJGoogleplex",
              displayName: { text: "Googleplex" },
              formattedAddress: "1600 Amphitheatre Pkwy, Mountain View, CA",
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await resolveGoogleMapsUrl(
      "https://www.google.com/maps/search/?api=1&query=Googleplex&center=37.422,-122.084",
      "places-test-key",
    );

    expect(requestedUrl).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(requestBody).toEqual({
      textQuery: "Googleplex",
      locationBias: {
        circle: { center: { latitude: 37.422, longitude: -122.084 }, radius: 5000 },
      },
    });
    expect(result).toEqual({
      placeId: "ChIJGoogleplex",
      name: "Googleplex",
      address: "1600 Amphitheatre Pkwy, Mountain View, CA",
    });
  });

  test("uses Google Geocoding to resolve coordinate-only Maps URLs", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          status: "OK",
          results: [
            {
              place_id: "ChIJTadichGrill",
              formatted_address: "240 California St, San Francisco, CA",
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await resolveGoogleMapsUrl(
      "https://www.google.com/maps/@37.7936,-122.3972,17z",
      "places-test-key",
    );

    const requestUrl = new URL(requestedUrl);
    expect(requestUrl.origin).toBe("https://maps.googleapis.com");
    expect(requestUrl.pathname).toBe("/maps/api/geocode/json");
    expect(requestUrl.searchParams.get("latlng")).toBe("37.7936,-122.3972");
    expect(requestUrl.searchParams.get("key")).toBe("places-test-key");
    expect(result).toEqual({
      placeId: "ChIJTadichGrill",
      name: "240 California St, San Francisco, CA",
      address: "240 California St, San Francisco, CA",
    });
  });

  test("follows a Google Maps short link and resolves the resulting listing query", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const requestedUrl = String(input);
      requestedUrls.push(requestedUrl);
      if (requestedUrl === "https://maps.app.goo.gl/shortCode") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://www.google.com/maps/place/Tadich+Grill/" },
        });
      }
      return new Response(
        JSON.stringify({
          places: [
            {
              id: "ChIJTadichGrill",
              displayName: { text: "Tadich Grill" },
              formattedAddress: "240 California St, San Francisco, CA",
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await resolveGoogleMapsUrl(
      "https://maps.app.goo.gl/shortCode",
      "places-test-key",
    );

    expect(requestedUrls[0]).toBe("https://maps.app.goo.gl/shortCode");
    expect(requestedUrls[1]).toBe("https://www.google.com/maps/place/Tadich+Grill/");
    expect(requestedUrls[2]).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(result.placeId).toBe("ChIJTadichGrill");
  });

  test("geocodes a Maps address only when Places Text Search found no candidates", async () => {
    let callCount = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      callCount += 1;
      if (callCount === 1) return new Response(JSON.stringify({ places: [] }), { status: 200 });
      const url = new URL(String(input));
      expect(url.searchParams.get("address")).toBe("1 Market St, San Francisco");
      return new Response(
        JSON.stringify({
          status: "OK",
          results: [
            { place_id: "ChIJMarketAddress", formatted_address: "1 Market St, San Francisco, CA" },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await resolveGoogleMapsUrl(
      "https://www.google.com/maps/search/?api=1&query=1+Market+St%2C+San+Francisco",
      "places-test-key",
    );

    expect(callCount).toBe(2);
    expect(result.placeId).toBe("ChIJMarketAddress");
  });

  test("rejects unsupported map URLs and does not fetch outside Google", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      resolveGoogleMapsUrl("https://maps.example.com/place", "places-test-key"),
    ).rejects.toThrow("valid HTTPS Google Maps");
    expect(called).toBe(false);
  });

  test("does not treat a place with no usable review excerpts as a successful scan", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "ChIJplace",
          displayName: { text: "Example Cafe" },
          reviews: [],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    await expect(scanGooglePlace("ChIJplace", "places-test-key")).rejects.toThrow(
      "no usable public review excerpts",
    );
  });

  test("does not substitute a Place ID for a missing provider place name", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "ChIJplace", reviews: [] }), {
        status: 200,
      })) as unknown as typeof fetch;

    await expect(scanGooglePlace("ChIJplace", "places-test-key")).rejects.toThrow(
      "Google Places returned no place name",
    );
  });
});
