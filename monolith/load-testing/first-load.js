import http from "k6/http";
import { sleep } from "k6";

export const options = { vus: 2, duration: "10s" };

export default function () {
  http.get(__ENV.TARGET_URL, { timeout: "2s", redirects: 0 });
  sleep(1);
}
