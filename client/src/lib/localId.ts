// Identifiers for decks that live only in this browser.
//
// A deck kept local has no server row, so nothing mints a join code for it —
// the code is only created when the deck is shared, server-side. Until then it
// needs an id of its own for the IndexedDB key, the `/s/:id` URL, the viewer
// window name and the BroadcastChannel.
//
// That id is deliberately *not* code-shaped: join codes are six characters
// from an unambiguous uppercase alphabet, and a viewer types them into a
// six-box field. A local id is prefixed and far longer, so it can never be
// mistaken for a join code, typed into that field, or collide with one.

const PREFIX = "local-";
/** Lowercase + digits, disjoint from the join-code alphabet's case. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const LENGTH = 20;

/** Mint an id for a deck that exists only in this browser. */
export function newLocalDeckId(): string {
  const bytes = new Uint8Array(LENGTH);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    // No WebCrypto (very old browsers, exotic embeddings): this id is not a
    // secret — it never authorizes anything — so Math.random is acceptable.
    for (let i = 0; i < LENGTH; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = PREFIX;
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** Whether an id belongs to a browser-local deck (so no server row exists for
 *  it, and nothing should be fetched by it). */
export function isLocalDeckId(id: string): boolean {
  return id.startsWith(PREFIX);
}
