// A session's id: its join code.

/** Characters in a join code. */
export const SESSION_CODE_LENGTH = 6;

// The shape of a join code, used as a free pre-filter before touching the DB.
// Deliberately looser than the generator's alphabet (which omits I/O/0/1):
// this is a cheap "could this possibly be a code?" guard, not an auth
// boundary, and it must keep accepting ids minted by older builds and fixtures.
export const SESSION_ID_RE = /^[A-Z0-9]{6}$/;
