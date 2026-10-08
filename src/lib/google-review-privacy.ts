export function isGoogleReview(review: { platform?: unknown; source?: unknown }): boolean {
  return [review.platform, review.source].some(
    (value) => typeof value === "string" && value.trim().toLowerCase().startsWith("google"),
  );
}

export function assertReviewAiAllowed(review: { platform?: unknown; source?: unknown }): void {
  if (isGoogleReview(review)) {
    throw new Error(
      "Google review content cannot be sent to an AI service. Write a reply manually.",
    );
  }
}
