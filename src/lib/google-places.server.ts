export type GooglePlaceReview = {
  author: string;
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
  rating: number | null;
  ratingCount: number;
  reviews: GooglePlaceReview[];
  mapsUrl: string;
  scannedAt: string;
};

export type GooglePlaceCandidate = {
  placeId: string;
  name: string;
  address: string;
};

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
  rating?: unknown;
  userRatingCount?: unknown;
  googleMapsUri?: unknown;
  reviews?: PlacesReviewPayload[];
};

type PlacesError = {
  error?: {
    message?: string;
    status?: string;
    details?: Array<{
      reason?: string;
      metadata?: { reason?: string };
    }>;
  };
};

function googleUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/(^|\.)google\.com$/i.test(url.hostname)) {
      return null;
    }
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
  const status =
    typeof payload.error?.status === "string" ? `; Google status ${payload.error.status}` : "";
  const reasons = [
    ...new Set(
      (payload.error?.details ?? [])
        .map((item) => item.reason ?? item.metadata?.reason)
        .filter((reason): reason is string => typeof reason === "string"),
    ),
  ];
  const reason = reasons.length ? `; reason ${reasons.join(", ")}` : "";
  throw new Error(
    `Google Places ${operation} failed (HTTP ${response.status}${status}${reason})${detail}`,
  );
}

export async function searchGooglePlaces(
  query: string,
  apiKey: string,
): Promise<GooglePlaceCandidate[]> {
  const textQuery = query.trim();
  if (textQuery.length < 3) throw new Error("Enter at least 3 characters to search Google Maps.");
  if (textQuery.length > 200) {
    throw new Error("Google Maps search must be 200 characters or fewer.");
  }
  if (!apiKey) throw new Error("Google Places API key is not configured.");

  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress",
    },
    body: JSON.stringify({ textQuery }),
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

export async function scanGooglePlace(
  placeId: string,
  apiKey: string,
): Promise<GooglePlaceSnapshot> {
  const normalizedPlaceId = placeId.trim();
  if (!normalizedPlaceId) throw new Error("Choose a Google Place before scanning.");
  if (!apiKey) throw new Error("Google Places API key is not configured.");

  const response = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(normalizedPlaceId)}`,
    {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "id,displayName,rating,userRatingCount,googleMapsUri,reviews.rating,reviews.text,reviews.originalText,reviews.publishTime,reviews.relativePublishTimeDescription,reviews.visitDate,reviews.authorAttribution.displayName,reviews.authorAttribution.uri,reviews.authorAttribution.photoUri,reviews.googleMapsUri,reviews.flagContentUri",
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  const payload = await readPlacesPayload<PlacePayload>(response);
  assertPlacesOk(response, payload, "scan");
  if (typeof payload.id !== "string" || !payload.id) {
    throw new Error("Google Places returned no place ID. Check the saved Place ID and API key.");
  }

  const rating =
    typeof payload.rating === "number" && payload.rating >= 1 && payload.rating <= 5
      ? payload.rating
      : null;
  const ratingCount =
    typeof payload.userRatingCount === "number" && payload.userRatingCount >= 0
      ? payload.userRatingCount
      : 0;
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
              : "Google user",
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

  return {
    placeId: payload.id,
    name: typeof payload.displayName?.text === "string" ? payload.displayName.text : payload.id,
    rating,
    ratingCount,
    reviews,
    mapsUrl:
      googleUrl(payload.googleMapsUri) ??
      `https://www.google.com/maps/search/?api=1&query_place_id=${encodeURIComponent(payload.id)}`,
    scannedAt: new Date().toISOString(),
  };
}
