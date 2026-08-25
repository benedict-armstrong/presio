// The running build's version, baked in by deploy/Dockerfile from the release
// tag (see .github/workflows/publish-local-image.yml). Self-hosted deployments
// are the reason this exists: a bug report from someone else's server is not
// actionable without knowing which image produced it, and `docker inspect` on
// a floating tag doesn't answer it either.
//
// "dev" means an unversioned build — a local checkout, or an image built
// outside the release workflow.
export const APP_VERSION = process.env.APP_VERSION || "dev";
