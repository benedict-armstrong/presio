# shared/

Code both the client (`client/`, bundled by Vite) and the server (`server/`,
run by tsx) import, so a protocol constant, type or validator exists once.

- The client imports it as `@shared/<file>` (a Vite alias and a tsconfig path).
- The server imports it by relative path, as `../shared/<file>.js`.
- It runs in both a browser and Node: no DOM, no `Buffer`, no `node:` modules,
  no npm dependencies. Where the two differ (SHA-256), each side passes its own in.
- The image copies it next to `client/` and `server/` (`deploy/Dockerfile`).
