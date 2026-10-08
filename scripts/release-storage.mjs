export const RELEASE_BUCKET = "license-releases";

export async function requirePrivateReleaseBucket(baseUrl, serviceKey, request = fetch) {
  const endpoint = new URL(`/storage/v1/bucket/${RELEASE_BUCKET}`, baseUrl);
  const response = await request(endpoint, {
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    throw new Error(
      `Release storage preflight failed (HTTP ${response.status}). Provision the private ${RELEASE_BUCKET} bucket using the release-storage migration before packaging.`,
    );
  }
  const bucket = await response.json();
  if (bucket.id !== RELEASE_BUCKET || bucket.public !== false) {
    throw new Error(
      `Release storage preflight failed: ${RELEASE_BUCKET} must be a private bucket.`,
    );
  }
}
