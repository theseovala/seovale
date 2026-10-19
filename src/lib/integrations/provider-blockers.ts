/** Safe, persistent provider diagnostics: never return credentials or project identifiers. */
export function safeProviderMessage(message: string): string {
  return message
    .replace(/AIza[\w-]+/g, "[redacted key]")
    .replace(/([?&](?:key|api_key|access_token)=)[^\s&"']+/gi, "$1[redacted]")
    .replace(/https:\/\/console\.(?:cloud|developers)\.google\.com\/[^\s"']+/g, "Google Cloud Console")
    .replace(/\bproject\s+\d+\b/gi, "the key's Google Cloud project")
    .slice(0, 500);
}

export function googleFailureMessage(payload: Record<string, any>, fallback: string): string {
  const details = payload["error"]?.["details"];
  const reason = Array.isArray(details)
    ? details.map((detail: any) => detail?.reason).find((value: unknown) => typeof value === "string" && /^[A-Z_]+$/.test(value))
    : undefined;
  return safeProviderMessage(`${reason ? `${reason}: ` : ""}${fallback}`);
}

export function googleBlockerAction(provider: string, message: string | null | undefined): string {
  const api = provider === "pagespeed" ? "PageSpeed Insights API (pagespeedonline.googleapis.com)" : "Safe Browsing API (safebrowsing.googleapis.com)";
  if (/SERVICE_DISABLED|has not been used|is disabled|not enabled|accessNotConfigured/i.test(message ?? ""))
    return `Enable ${api} in the project that owns the saved key, wait for activation, then Test connection again.`;
  if (/API_KEY_SERVICE_BLOCKED|requests.*blocked/i.test(message ?? ""))
    return `Allow ${api} under the saved key's API restrictions, then Test connection again.`;
  if (/API_KEY_HTTP_REFERRER_BLOCKED|referer|referrer/i.test(message ?? ""))
    return "Use a dedicated server-side key; browser HTTP-referrer restrictions do not authorize these server calls. Keep API restrictions enabled.";
  if (/API_KEY_IP_ADDRESS_BLOCKED|IP address/i.test(message ?? ""))
    return "The key's IP restriction rejects the server. Use an approved fixed-egress server or a compatible dedicated server key; do not allow an arbitrary IP.";
  if (/API_KEY_INVALID|API key not valid/i.test(message ?? ""))
    return "Replace the invalid key with a valid key from the intended Google Cloud project, then Test connection again.";
  return `Check ${api}, key API/application restrictions and project quotas in Google Cloud; the last response does not establish which setting is wrong.`;
}