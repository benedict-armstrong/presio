// Standalone harness for the Playwright E2E suite. Lives under server/ so Node
// resolves express/socket.io from server/node_modules. Boots the real Express
// app (createApp) and socket handlers wired to an in-memory FakeSupabase, serves
// the built client from client/dist, and serves the example PDF so the viewer
// can actually render slides. No real Supabase project required.
import http from "http";
import path from "path";
import express from "express";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApp } from "./app.js";
import { registerSocketHandlers, createSocketState } from "./socket.js";
import { FakeSupabase } from "./test/fakeSupabase.js";
import { PORT, SESSION_ID, CONTROLLER_TOKEN, TOTAL_SLIDES } from "../e2e/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || PORT);

// Allow the harness's own origin so the browser's API/socket requests (which
// carry an Origin header) aren't rejected by the CORS guard. In production the
// client and server share an origin and this isn't needed.
process.env.ALLOWED_ORIGIN = `http://localhost:${port}`;

const fake = new FakeSupabase([
  {
    id: SESSION_ID,
    pdf_path: "",
    pdf_url: "/test.pdf",
    filename: "E2E Deck",
    total_slides: TOTAL_SLIDES,
    current_slide: 1,
    note_prefix: "note:",
    local: false,
    controller_token: CONTROLLER_TOKEN,
    passphrase: "E2EPASS1",
    user_id: null,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  },
]);

const io = new Server();
const inner = createApp({ supabase: fake as unknown as SupabaseClient, io });

// Wrap createApp so the example PDF route is matched before its catch-all.
const app = express();
app.get("/test.pdf", (_req, res) => {
  res.sendFile(path.resolve(__dirname, "../example/example.pdf"));
});
app.use(inner);

const server = http.createServer(app);
io.attach(server);
registerSocketHandlers(io, fake as unknown as SupabaseClient, createSocketState());

server.listen(port, () => {
  console.log(`E2E harness on http://localhost:${port}`);
});
