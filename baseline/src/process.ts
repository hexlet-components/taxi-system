import { pool, serve } from "./common.ts";
import { createTopic, publish, consume, summary } from "./events.ts";
import { notifications, notify } from "./notifications.ts";
const role = process.env.ROLE;
if (role === "topic") {
  await createTopic();
  await pool.end();
} else {
  serve(role === "notifications" ? notifications : summary);
  if (role === "publisher") await publish();
  if (role === "consumer") await consume();
  if (role === "notification-worker") await notify();
}
