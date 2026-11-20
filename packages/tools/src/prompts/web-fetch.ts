export const description = [
  "Fetch a URL over HTTP/HTTPS, return the response body as text. Requires approval (URL shown in preview).",
  "",
  "For: docs you need inline, raw files (e.g. GitHub raw URLs), unauthenticated JSON APIs. Returns `{ url, status, contentType, body }`; body is truncated — narrow the URL (anchors, API filters) rather than re-fetching big pages.",
  "",
  "Not for: anything requiring auth (no header support), JS-driven sites (no JS execution), or search (fetch only knows the URL you give).",
].join("\n");
