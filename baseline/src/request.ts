// A small HTTP client for internal experiment endpoints; no host ports are needed.
const [url, method = "GET", body, headers = "{}"] = process.argv.slice(2);
const options: RequestInit = {
  method,
  headers: { "content-type": "application/json", ...JSON.parse(headers) },
  signal: AbortSignal.timeout(5000),
};
if (body && method !== "GET") options.body = body;
const response = await fetch(url, options);
console.log(response.status, JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;
