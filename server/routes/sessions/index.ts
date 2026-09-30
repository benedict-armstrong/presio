// The /api/sessions routes, by concern. Order matters where paths overlap:
// GET /api/sessions/mine (sync) must come before GET /api/sessions/:id (access).

import type express from "express";
import type { AppDeps } from "../../app.js";
import { registerAccessRoutes } from "./access.js";
import { registerDeckRoutes } from "./deck.js";
import { registerHandoffRoutes } from "./handoff.js";
import { registerSyncRoutes } from "./sync.js";

export function registerSessionRoutes(app: express.Express, deps: AppDeps) {
  registerSyncRoutes(app, deps);
  registerHandoffRoutes(app, deps);
  registerDeckRoutes(app, deps);
  registerAccessRoutes(app, deps);
}
