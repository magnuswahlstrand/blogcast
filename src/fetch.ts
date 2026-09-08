const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0 Safari/537.36 blogcast/0.1";

export async function fetchUrl(
  url: string,
): Promise<{ html: string; finalUrl: string }> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  return { html: await res.text(), finalUrl: res.url || url };
}
