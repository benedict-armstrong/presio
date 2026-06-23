// Shared constants for the E2E harness and specs. Kept free of any server
// dependencies so it can be imported from both root-resolved (spec) and
// server-resolved (harness) module contexts.
export const PORT = 4180;
export const SESSION_ID = "E2ETST";
export const CONTROLLER_TOKEN = "e2e-controller-token";
export const TOTAL_SLIDES = 7; // example/example.pdf has 7 pages
