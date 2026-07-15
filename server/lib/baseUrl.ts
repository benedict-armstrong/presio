import type express from "express";

/** Absolute origin for the current request (respects trust proxy). */
export function baseUrl(req: express.Request): string {
  return `${req.protocol}://${req.get("host")}`;
}
