# Changelog

## [2.1.0](https://github.com/benedict-armstrong/presio/compare/v2.0.0...v2.1.0) (2026-09-26)


### Features

* **deploy:** retire the Let's Encrypt resolver and monitor origin certs ([#122](https://github.com/benedict-armstrong/presio/issues/122)) ([fe8d86a](https://github.com/benedict-armstrong/presio/commit/fe8d86a5115da1597942d5c1e364a609ddc11d75)), closes [#64](https://github.com/benedict-armstrong/presio/issues/64)
* plugins ([#130](https://github.com/benedict-armstrong/presio/issues/130)) ([85c629b](https://github.com/benedict-armstrong/presio/commit/85c629b0963db61e4f19437715423cc41e1ed965))

## [2.0.0](https://github.com/benedict-armstrong/presio/compare/v1.1.0...v2.0.0) (2026-09-21)


### Features

* clickable PDF links, sharper slide canvases, and a minimal landing layout ([#113](https://github.com/benedict-armstrong/presio/issues/113)) ([1a25e3e](https://github.com/benedict-armstrong/presio/commit/1a25e3e134428827589c16fd2e15d570384ff50d)), closes [#94](https://github.com/benedict-armstrong/presio/issues/94) [#95](https://github.com/benedict-armstrong/presio/issues/95)
* **deps:** migrate to pdfjs-dist 6 ([#106](https://github.com/benedict-armstrong/presio/issues/106)) ([40b75e1](https://github.com/benedict-armstrong/presio/commit/40b75e127c89f903c71c6c2f71f924e2c425c261))
* **deps:** migrate to react-mosaic-component 7 ([#107](https://github.com/benedict-armstrong/presio/issues/107)) ([882ad3d](https://github.com/benedict-armstrong/presio/commit/882ad3d9213f5e57325b1134f09b04d2e909e10d))
* let local deploys rewrite share links to the machine's LAN address ([#68](https://github.com/benedict-armstrong/presio/issues/68)) ([8dac1e0](https://github.com/benedict-armstrong/presio/commit/8dac1e07ae23bc43c303a0216490d26a3db882cd))
* move HTTP rate limiting from the app to the Cloudflare edge ([#63](https://github.com/benedict-armstrong/presio/issues/63)) ([6271725](https://github.com/benedict-armstrong/presio/commit/627172535cdfa72c0412c6f02fdcff7790d29b1f))
* serve the app on presio.ch alongside presio.xyz ([#110](https://github.com/benedict-armstrong/presio/issues/110)) ([f09d9ae](https://github.com/benedict-armstrong/presio/commit/f09d9aea7fe612c56a9599bef445fccf31c26392))


### Bug Fixes

* **csp:** allow WebAssembly so syntax highlighting works on deployed origins ([29fd9e4](https://github.com/benedict-armstrong/presio/commit/29fd9e4bc9dd37f22f0798031ccca3f1c4bc9c77))
* **csp:** load the pre-paint theme script from a file, not inline ([#111](https://github.com/benedict-armstrong/presio/issues/111)) ([0c6e938](https://github.com/benedict-armstrong/presio/commit/0c6e9385a7a7b00234d9c9b0f1e367318cf35c63))
* **deploy:** keep the analytics and uptime hostnames routed across a move ([#114](https://github.com/benedict-armstrong/presio/issues/114)) ([6dd03b5](https://github.com/benedict-armstrong/presio/commit/6dd03b5788b71a1b2c331bd4b5953391caf8be2e))
* document a verification command that actually works ([#55](https://github.com/benedict-armstrong/presio/issues/55)) ([4399133](https://github.com/benedict-armstrong/presio/commit/439913397a3b6cff45e6a17f34ceed47f5f207fb))
* responsive controller chrome + clear the react-hooks lint errors ([#109](https://github.com/benedict-armstrong/presio/issues/109)) ([717b545](https://github.com/benedict-armstrong/presio/commit/717b545fa1a1d3fe2f0e611a460240bef2b800a6))


### Miscellaneous Chores

* release 2.0.0 ([bd8eb34](https://github.com/benedict-armstrong/presio/commit/bd8eb345c84c10c0dadf027a22e630b12772770e)), closes [#112](https://github.com/benedict-armstrong/presio/issues/112)

## [1.1.0](https://github.com/benedict-armstrong/presio/compare/v1.0.0...v1.1.0) (2026-08-25)


### Features

* build and smoke-test the image on PRs that touch it ([#52](https://github.com/benedict-armstrong/presio/issues/52)) ([71b9acb](https://github.com/benedict-armstrong/presio/commit/71b9acb33b91f771fcc2d6486e105e2db90d83da))
* make PR previews opt-in via /preview comment or label ([#48](https://github.com/benedict-armstrong/presio/issues/48)) ([71424a9](https://github.com/benedict-armstrong/presio/commit/71424a9be9996da8da05c0ad94c54878a65fd16d))
* version, gate and protect releases for self-hosters ([#33](https://github.com/benedict-armstrong/presio/issues/33)) ([ceb5677](https://github.com/benedict-armstrong/presio/commit/ceb5677b4cb4aba458ec4740c181440a910cc57c))


### Bug Fixes

* point the staging deploy at the real stack env file ([#38](https://github.com/benedict-armstrong/presio/issues/38)) ([7033745](https://github.com/benedict-armstrong/presio/commit/7033745fb62bc69bc5b37841208950cd16d95c32))
* verify staging is serving the commit that was just deployed ([#49](https://github.com/benedict-armstrong/presio/issues/49)) ([944aeab](https://github.com/benedict-armstrong/presio/commit/944aeab20b00816a87057f8c067ee4ac6b869afa))
* verify the staging deploy on the host, not through Cloudflare ([#51](https://github.com/benedict-armstrong/presio/issues/51)) ([76be752](https://github.com/benedict-armstrong/presio/commit/76be75253bcc8445c8ec7b1ab199055785ba396a))
