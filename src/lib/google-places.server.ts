export type GooglePlaceReview = {
  author: string | null;
  authorUrl: string | null;
  authorPhotoUrl: string | null;
  rating: number;
  text: string;
  originalText: string | null;
  textLanguage: string | null;
  originalLanguage: string | null;
  publishedAt: string | null;
  relativePublishedAt: string | null;
  visitYear: number | null;
  visitMonth: number | null;
  reviewUrl: string;
  flagContentUrl: string | null;
};

export type GooglePlaceSnapshot = {
  placeId: string;
  name: string;
  address: string | null;
  coordinates: { latitude: number; longitude: number } | null;
  rating: number | null;
  ratingCount: number | null;
  reviews: GooglePlaceReview[];
  mapsUrl: string;
  scannedAt: string;
  reviewOrder: "google_selected";
};

export type GooglePlaceCandidate = {
  placeId: string;
  name: string;
  address: string;
};

export type GoogleMapsUrlResolution = GooglePlaceCandidate;

type PlacesReviewPayload = {
  rating?: unknown;
  text?: { text?: unknown; languageCode?: unknown } | null;
  originalText?: { text?: unknown; languageCode?: unknown } | null;
  authorAttribution?: { displayName?: unknown; uri?: unknown; photoUri?: unknown } | null;
  publishTime?: unknown;
  relativePublishTimeDescription?: unknown;
  visitDate?: { year?: unknown; month?: unknown } | null;
  googleMapsUri?: unknown;
  flagContentUri?: unknown;
};

type PlacePayload = {
  id?: unknown;
  displayName?: { text?: unknown } | null;
  formattedAddress?: unknown;
  location?: { latitude?: unknown; longitude?: unknown } | null;
  rating?: unknown;
  userRatingCount?: unknown;
  googleMapsUri?: unknown;
  reviews?: PlacesReviewPayload[];
};

type GoogleCoordinates = { latitude: number; longitude: number };

type PlacesError = {
  error?: {
    message?: string;
    status?: string;
    details?: Array<{ reason?: string }>;
  };
};

function googleUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/(^|\.)google\.com$/i.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function googleReportUrl(value: unknown) {
  const safe = googleUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  return url.hostname === "www.google.com" && url.pathname === "/local/review/rap/report"
    ? safe
    : null;
}

function googlePhotoUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/(^|\.)googleusercontent\.com$/i.test(url.hostname)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function readPlacesPayload<T>(response: Response): Promise<T & PlacesError> {
  try {
    return (await response.json()) as T & PlacesError;
  } catch {
    throw new Error(`Google Places returned an unreadable response (HTTP ${response.status}).`);
  }
}

function assertPlacesOk(response: Response, payload: PlacesError, operation: string) {
  if (response.ok) return;
  const detail = typeof payload.error?.message === "string" ? `: ${payload.error.message}` : "";
  const googleStatus =
    typeof payload.error?.status === "string" ? `; Google status ${payload.error.status}` : "";
  const reasons = [
    ...new Set(
      (payload.error?.details ?? [])
        .map((errorDetail) => errorDetail.reason)
        .filter((reason): reason is string => typeof reason === "string"),
    ),
  ];
  const reason = reasons.length ? `; reason ${reasons.join(", ")}` : "";
  throw new Error(
    `Google Places ${operation} failed (HTTP ${response.status}${googleStatus}${reason})${detail}`,
  );
}

type GeocodingPayload = {
  status?: unknown;
  error_message?: unknown;
  results?: Array<{ place_id?: unknown; formatted_address?: unknown }>;
};

async function readGoogleGeocodingPayload(response: Response): Promise<GeocodingPayload> {
  try {
    return (await response.json()) as GeocodingPayload;
  } catch {
    throw new Error(`Google Geocoding returned an unreadable response (HTTP ${response.status}).`);
  }
}

export async function searchGooglePlaces(
  query: string,
  apiKey: string,
  locationBias?: GoogleCoordinates,
): Promise<GooglePlaceCandidate[]> {
  const textQuery = query.trim();
  if (textQuery.length < 3) throw new Error("Enter at least 3 characters to search Google Maps.");
  if (textQuery.length > 200)
    throw new Error("Google Maps search must be 200 characters or fewer.");
  if (!apiKey) throw new Error("Google Places API key is not configured.");

  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress",
    },
    body: JSON.stringify({
      textQuery,
      ...(locationBias
        ? {
            locationBias: {
              circle: {
                center: locationBias,
                radius: 5000,
              },
            },
          }
        : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await readPlacesPayload<{
    places?: Array<{
      id?: unknown;
      displayName?: { text?: unknown } | null;
      formattedAddress?: unknown;
    }>;
  }>(response);
  assertPlacesOk(response, payload, "place search");
  return (Array.isArray(payload.places) ? payload.places : []).flatMap(
    (place): GooglePlaceCandidate[] => {
      if (typeof place.id !== "string" || !place.id.trim()) return [];
      return [
        {
          placeId: place.id,
          name: typeof place.displayName?.text === "string" ? place.displayName.text : place.id,
          address: typeof place.formattedAddress === "string" ? place.formattedAddress : "",
        },
      ];
    },
  );
}

function isGoogleMapsUrl(value: URL) {
  const host = value.hostname.toLowerCase();
  return (
    host === "maps.app.goo.gl" ||
    host === "goo.gl" ||
    host === "g.page" ||
    /(^|\.)google\.(com|[a-z]{2,3})(\.[a-z]{2})?$/.test(host)
  );
}

function parseCoordinates(value: string | null | undefined): GoogleCoordinates | null {
  if (!value) return null;
  const match = value.trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*[,/]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return { latitude, longitude };
}

function placeIdFrom(value: string | null | undefined) {
  if (!value) return null;
  const placeId = value.match(/(?:!1s|place_id:)((?!0x)[A-Za-z0-9_-]{10,})(?:!|$)/i)?.[1];
  return placeId ?? null;
}

function googleMapsUrlDetails(url: URL) {
  const explicitPlaceId =
    url.searchParams.get("query_place_id") ?? url.searchParams.get("place_id");
  const placePathSegment = decodeURIComponent(url.pathname).match(/\/maps\/place\/([^/]+)/i)?.[1];
  const placeId =
    (explicitPlaceId && /^[A-Za-z0-9_-]{10,}$/.test(explicitPlaceId) ? explicitPlaceId : null) ??
    placeIdFrom(url.searchParams.get("q")) ??
    placeIdFrom(url.searchParams.get("query")) ??
    placeIdFrom(url.pathname) ??
    (placePathSegment && /^(ChIJ|Ei)[A-Za-z0-9_-]{10,}$/i.test(placePathSegment)
      ? placePathSegment
      : null);
  if (placeId) return { placeId, query: null, coordinates: null };

  const path = decodeURIComponent(url.pathname);
  const coordinates =
    parseCoordinates(url.searchParams.get("query")) ??
    parseCoordinates(url.searchParams.get("q")) ??
    parseCoordinates(
      path
        .match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/)
        ?.slice(1)
        .join(","),
    ) ??
    parseCoordinates(placePathSegment) ??
    parseCoordinates(path.match(/\/maps\/search\/([^/]+)/i)?.[1]) ??
    parseCoordinates(url.searchParams.get("center")) ??
    parseCoordinates(url.searchParams.get("ll")) ??
    parseCoordinates(path.match(/@(-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?)/)?.[1]);
  const queryParameter =
    url.searchParams.get("query") ??
    url.searchParams.get("q") ??
    url.searchParams.get("destination");
  const searchQuery = queryParameter?.trim() || null;
  const placePath = path.match(/\/maps\/place\/([^/]+)/i)?.[1];
  const searchPath = path.match(/\/maps\/search\/([^/]+)/i)?.[1];
  const pathQuery =
    placePath && !/^data=/i.test(placePath)
      ? placePath.replace(/\+/g, " ").trim()
      : searchPath
        ? searchPath.replace(/\+/g, " ").trim()
        : null;
  const query =
    searchQuery && !parseCoordinates(searchQuery)
      ? searchQuery
      : pathQuery && !parseCoordinates(pathQuery)
        ? pathQuery
        : null;
  return { placeId: null, query, coordinates };
}

async function resolveGoogleMapsShortUrl(url: URL): Promise<URL> {
  let current = url;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, current);
      if (next.protocol !== "https:" || !isGoogleMapsUrl(next) || next.username || next.password) {
        throw new Error("Google Maps short link redirected outside Google Maps.");
      }
      current = next;
      continue;
    }
    if (!response.ok) {
      throw new Error(`Google Maps short link could not be resolved (HTTP ${response.status}).`);
    }
    if (response.url) {
      const finalUrl = new URL(response.url);
      if (!isGoogleMapsUrl(finalUrl)) {
        throw new Error("Google Maps short link resolved outside Google Maps.");
      }
      return finalUrl;
    }
    return current;
  }
  throw new Error("Google Maps short link exceeded the redirect limit.");
}

async function geocodeGoogleLocation(
  location: { address: string } | { coordinates: GoogleCoordinates },
  apiKey: string,
): Promise<GooglePlaceCandidate | null> {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  if ("address" in location) {
    url.searchParams.set("address", location.address);
  } else {
    url.searchParams.set(
      "latlng",
      `${location.coordinates.latitude},${location.coordinates.longitude}`,
    );
  }
  url.searchParams.set("key", apiKey);
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const payload = await readGoogleGeocodingPayload(response);
  if (!response.ok) {
    throw new Error(`Google Geocoding failed (HTTP ${response.status}).`);
  }
  const result = payload.results?.[0];
  if (payload.status === "ZERO_RESULTS") return null;
  if (payload.status !== "OK") {
    const detail = typeof payload.error_message === "string" ? `: ${payload.error_message}` : "";
    throw new Error(
      `Google Geocoding failed (${String(payload.status ?? "unknown status")})${detail}`,
    );
  }
  if (typeof result?.place_id !== "string" || !result.place_id) return null;
  return {
    placeId: result.place_id,
    name: typeof result.formatted_address === "string" ? result.formatted_address : result.place_id,
    address: typeof result.formatted_address === "string" ? result.formatted_address : "",
  };
}

export async function resolveGoogleMapsUrl(
  input: string,
  apiKey: string,
): Promise<GoogleMapsUrlResolution> {
  const value = input.trim();
  if (!value || value.length > 2048) {
    throw new Error("Paste a Google Maps URL up to 2,048 characters long.");
  }
  if (!apiKey) throw new Error("Google Places API key is not configured.");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a complete Google Maps URL.");
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (
    url.protocol !== "https:" ||
    !isGoogleMapsUrl(url) ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    throw new Error("Enter a valid HTTPS Google Maps or Google Maps share URL.");
  }

  let details = googleMapsUrlDetails(url);
  if (!details.placeId && !details.query && !details.coordinates) {
    if (
      url.hostname === "maps.app.goo.gl" ||
      url.hostname === "goo.gl" ||
      url.hostname === "g.page"
    ) {
      url = await resolveGoogleMapsShortUrl(url);
      details = googleMapsUrlDetails(url);
    }
  }
  if (details.placeId) {
    return { placeId: details.placeId, name: details.placeId, address: "" };
  }

  let candidates: GooglePlaceCandidate[] = [];
  if (details.query) {
    candidates = await searchGooglePlaces(details.query, apiKey, details.coordinates ?? undefined);
  }
  if (candidates[0]) return candidates[0];

  const geocoded = details.coordinates
    ? await geocodeGoogleLocation({ coordinates: details.coordinates }, apiKey)
    : details.query
      ? await geocodeGoogleLocation({ address: details.query }, apiKey)
      : null;
  if (geocoded) return geocoded;
  throw new Error(
    "Google Maps URL did not resolve to a place. Use a listing, search, or share URL that identifies a business or address.",
  );
}

export async function scanGooglePlace(
  placeId: string,
  apiKey: string,
): Promise<GooglePlaceSnapshot> {
  const normalizedPlaceId = placeId.trim();
  if (!normalizedPlaceId) throw new Error("Enter a Google Place ID before scanning.");
  if (!apiKey) throw new Error("Google Places API key is not configured.");

  const response = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(normalizedPlaceId)}`,
    {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "id,displayName,formattedAddress,location,rating,userRatingCount,googleMapsUri,reviews.rating,reviews.text,reviews.originalText,reviews.publishTime,reviews.relativePublishTimeDescription,reviews.visitDate,reviews.authorAttribution.displayName,reviews.authorAttribution.uri,reviews.authorAttribution.photoUri,reviews.googleMapsUri,reviews.flagContentUri",
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  const payload = await readPlacesPayload<PlacePayload>(response);
  assertPlacesOk(response, payload, "scan");
  if (typeof payload.id !== "string" || !payload.id) {
    throw new Error("Google Places returned no place ID. Check the saved Place ID and API key.");
  }
  if (typeof payload.displayName?.text !== "string" || !payload.displayName.text.trim()) {
    throw new Error("Google Places returned no place name for this Place ID.");
  }

  const rating =
    typeof payload.rating === "number" && payload.rating >= 1 && payload.rating <= 5
      ? payload.rating
      : null;
  const ratingCount =
    typeof payload.userRatingCount === "number" && payload.userRatingCount >= 0
      ? payload.userRatingCount
      : null;
  const coordinates =
    typeof payload.location?.latitude === "number" &&
    Number.isFinite(payload.location.latitude) &&
    Math.abs(payload.location.latitude) <= 90 &&
    typeof payload.location.longitude === "number" &&
    Number.isFinite(payload.location.longitude) &&
    Math.abs(payload.location.longitude) <= 180
      ? { latitude: payload.location.latitude, longitude: payload.location.longitude }
      : null;
  const reviews = (Array.isArray(payload.reviews) ? payload.reviews : [])
    .flatMap((review): GooglePlaceReview[] => {
      if (typeof review.rating !== "number" || review.rating < 1 || review.rating > 5) return [];
      const reviewUrl = googleUrl(review.googleMapsUri);
      if (!reviewUrl) return [];
      const visitDate = review.visitDate;
      return [
        {
          author:
            typeof review.authorAttribution?.displayName === "string"
              ? review.authorAttribution.displayName
              : null,
          authorUrl: googleUrl(review.authorAttribution?.uri),
          authorPhotoUrl: googlePhotoUrl(review.authorAttribution?.photoUri),
          rating: review.rating,
          text: typeof review.text?.text === "string" ? review.text.text : "",
          originalText:
            typeof review.originalText?.text === "string" ? review.originalText.text : null,
          textLanguage:
            typeof review.text?.languageCode === "string" ? review.text.languageCode : null,
          originalLanguage:
            typeof review.originalText?.languageCode === "string"
              ? review.originalText.languageCode
              : null,
          publishedAt: typeof review.publishTime === "string" ? review.publishTime : null,
          relativePublishedAt:
            typeof review.relativePublishTimeDescription === "string"
              ? review.relativePublishTimeDescription
              : null,
          visitYear: typeof visitDate?.year === "number" ? visitDate.year : null,
          visitMonth: typeof visitDate?.month === "number" ? visitDate.month : null,
          reviewUrl,
          flagContentUrl: googleReportUrl(review.flagContentUri),
        },
      ];
    })
    .slice(0, 5);
  if (reviews.length === 0) {
    throw new Error("Google Places returned no usable public review excerpts for this place.");
  }

  return {
    placeId: payload.id,
    name: payload.displayName.text,
    address: typeof payload.formattedAddress === "string" ? payload.formattedAddress : null,
    coordinates,
    rating,
    ratingCount,
    reviews,
    mapsUrl:
      googleUrl(payload.googleMapsUri) ??
      `https://www.google.com/maps/search/?api=1&query_place_id=${encodeURIComponent(payload.id)}`,
    scannedAt: new Date().toISOString(),
    reviewOrder: "google_selected",
  };
}
