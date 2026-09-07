import http from "k6/http";
import { check } from "k6";

const targetUrl = __ENV.TARGET_URL;
if (!targetUrl) {
  throw new Error("Set TARGET_URL to your test endpoint");
}

export const options = {
  scenarios: {
    read: {
      executor: "constant-arrival-rate",
      rate: 5,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 5,
      maxVUs: 20,
      gracefulStop: "5s",
    },
  },
  thresholds: {
    checks: ["rate==1"],
    http_req_failed: ["rate==0"],
    http_req_duration: ["p(95)<500"],
    dropped_iterations: ["count==0"],
  },
};

export default function () {
  const response = http.get(targetUrl, { timeout: "2s", redirects: 0 });
  check(response, {
    "status is 200": (result) => result.status === 200,
  });
}
