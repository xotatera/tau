import { test } from "node:test";
import { smokeIsolation } from "./tau-isolation-smoke.mjs";

test("real source and bundled namespaces preserve imported legacy extension registrations", { timeout: 60000 }, smokeIsolation);
