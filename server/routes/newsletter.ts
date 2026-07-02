import type express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidEmail } from "../validation.js";

// Email list signups from the in-app prompt. Insert-only from the client's
// perspective; duplicates are treated as success so the endpoint is idempotent
// and doesn't leak whether an address was already subscribed.
export function registerNewsletterRoutes(app: express.Express, supabase: SupabaseClient) {
  app.post("/api/newsletter", async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!isValidEmail(email)) {
      res.status(400).json({ error: "A valid email address is required" });
      return;
    }

    const { error } = await supabase
      .from("newsletter_signups")
      .upsert({ email }, { onConflict: "email", ignoreDuplicates: true });

    if (error) {
      console.error("Newsletter signup failed:", error);
      res.status(500).json({ error: "Failed to sign up. Please try again later." });
      return;
    }

    res.json({ ok: true });
  });
}
