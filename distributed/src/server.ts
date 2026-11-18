import { serve } from "./common.ts";
import { gateway } from "./gateway.ts";
import { payments } from "./payments.ts";
import { seed, shard } from "./shard.ts";
import { work } from "./worker.ts";
const role = process.env.ROLE;
if (role === "shard") await seed();
serve(async (method, path, body, request) => {
  if (role === "gateway") return gateway(method, path, body, request);
  if (role === "payments")
    return payments(method, path, body, Number(request.headers["x-request-budget-ms"] ?? 1000));
  if (role === "shard")
    return shard(method, path, body, Number(request.headers["x-route-version"]));
  return { role };
});
if (role === "worker") await work();
