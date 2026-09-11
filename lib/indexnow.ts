const INDEXNOW_KEY = "8547ec4f3bb695f8c79ed5b373636a71d86b8f48576ce415c4abb240e675ce8d";
const INDEXNOW_HOST = "tenderfans.com";
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

export async function submitIndexNow(urls: string[]) {
  const uniqueUrls = [...new Set(urls)]
    .filter((url) => url.startsWith("https://tenderfans.com/"))
    .slice(0, 10000);

  if (!uniqueUrls.length) {
    return {
      ok: true,
      status: 200,
      submitted: 0,
    };
  }

  const response = await fetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      host: INDEXNOW_HOST,
      key: INDEXNOW_KEY,
      keyLocation: `https://tenderfans.com/${INDEXNOW_KEY}.txt`,
      urlList: uniqueUrls,
    }),
    cache: "no-store",
  });

  return {
    ok: response.ok,
    status: response.status,
    submitted: uniqueUrls.length,
    responseText: await response.text(),
  };
}

export { INDEXNOW_KEY };
