import { setTimeout as delay } from "node:timers/promises";
import { call, nodes } from "./common.ts";
type Work = {
  city: number;
  booking: string;
  action: "reserve" | "release";
  amount: number;
  version: number;
};
export async function work(): Promise<never> {
  for (;;) {
    for (const url of Object.values(nodes)) {
      try {
        const jobs = await call<Work[]>(`${url}/work`);
        // One pass has at most four concurrent payment calls; no overlapping passes.
        for (let offset = 0; offset < jobs.length; offset += 4) {
          await Promise.all(
            jobs.slice(offset, offset + 4).map(async (job) => {
              const path = `${url}/cities/${job.city}/bookings/${job.booking}/result`;
              const headers = { "x-route-version": String(job.version) };
              let result: Record<string, unknown>;
              try {
                const payment = await call<{ state: string }>(
                  `http://payments:8080/reservations/${job.city}-${job.booking}/${job.action}`,
                  "POST",
                  { amount: job.amount },
                  { "x-request-budget-ms": "250" },
                  250,
                );
                result = { action: job.action, payment_state: payment.state };
              } catch (error) {
                result = { action: job.action, error: String(error) };
              }
              // Failure to record the response leaves the durable command available for replay.
              try {
                await call(path, "POST", result, headers);
              } catch (error) {
                console.error("result not recorded", String(error));
              }
            }),
          );
        }
      } catch (error) {
        console.error("participant unavailable", url, String(error));
      }
    }
    await delay(100);
  }
}
