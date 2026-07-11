# Changelog

## [1.5.0](https://github.com/chrischall/untappd-mcp/compare/v1.4.0...v1.5.0) (2026-07-11)


### Features

* fix remote cache env wiring; add untappd_cache_not_had ([#53](https://github.com/chrischall/untappd-mcp/issues/53)) ([d38bbc7](https://github.com/chrischall/untappd-mcp/commit/d38bbc7addd003fa5d9b93c43bc30b526d943cd8))

## [1.4.0](https://github.com/chrischall/untappd-mcp/compare/v1.3.1...v1.4.0) (2026-07-11)


### Features

* check-in cache diagnostics and remote-connector (Durable Object) support ([#51](https://github.com/chrischall/untappd-mcp/issues/51)) ([696a67d](https://github.com/chrischall/untappd-mcp/commit/696a67da515e8eed91f10866f4d0dd0a1c6d726e))

## [1.3.1](https://github.com/chrischall/untappd-mcp/compare/v1.3.0...v1.3.1) (2026-07-11)


### Bug Fixes

* **deps:** bump @modelcontextprotocol/sdk to 1.29.0 and agents to 0.17.3 in /packages/mcp-connector ([#40](https://github.com/chrischall/untappd-mcp/issues/40)) ([a8be812](https://github.com/chrischall/untappd-mcp/commit/a8be81234c5bc8ccadd5c4ea59eaa27844f7011a))
* **deps:** bump agents ([#46](https://github.com/chrischall/untappd-mcp/issues/46)) ([7d706e0](https://github.com/chrischall/untappd-mcp/commit/7d706e06b96633d7e279247fd7af1a5ec2ce68c6))

## [1.3.0](https://github.com/chrischall/untappd-mcp/compare/v1.2.0...v1.3.0) (2026-07-09)


### Features

* **mcp-connector:** polished, theme-aware connector login page ([#42](https://github.com/chrischall/untappd-mcp/issues/42)) ([96f73ad](https://github.com/chrischall/untappd-mcp/commit/96f73ade3de69ed4360279faa94357b4aae1a8bf))

## [1.2.0](https://github.com/chrischall/untappd-mcp/compare/v1.1.0...v1.2.0) (2026-07-09)


### Features

* reusable remote-connector harness + Untappd Cloudflare worker ([#38](https://github.com/chrischall/untappd-mcp/issues/38)) ([2bf0c3a](https://github.com/chrischall/untappd-mcp/commit/2bf0c3ac5b48e8d1df04cb649e7bf07d0591a4ed))


### Bug Fixes

* worker boots off-Node + production wrangler config ([#41](https://github.com/chrischall/untappd-mcp/issues/41)) ([1af0974](https://github.com/chrischall/untappd-mcp/commit/1af09740e89574e98875197e3fce8127e5b49c16))


### Refactor

* inject the client into tools (remote-connector prep) ([#36](https://github.com/chrischall/untappd-mcp/issues/36)) ([f84ed8a](https://github.com/chrischall/untappd-mcp/commit/f84ed8a3d84bc64927e118b411c21fc876bd4571))

## [1.1.0](https://github.com/chrischall/untappd-mcp/compare/v1.0.0...v1.1.0) (2026-07-08)


### Features

* compact projections for wishlist and distinct beers ([#31](https://github.com/chrischall/untappd-mcp/issues/31)) ([c5bce61](https://github.com/chrischall/untappd-mcp/commit/c5bce616e20c1b6f999c493d342c612ad6409210))
* friend-management writes (add/accept/reject/remove) ([#26](https://github.com/chrischall/untappd-mcp/issues/26)) ([26a5a6b](https://github.com/chrischall/untappd-mcp/commit/26a5a6b6b953cafc52f954626e529ebeb9961b85))
* opt-in compact projections for fat list responses ([#28](https://github.com/chrischall/untappd-mcp/issues/28)) ([00986dd](https://github.com/chrischall/untappd-mcp/commit/00986ddca9ed759e5e366f8c48b4bf5a8b3798d2))
* untappd_open_url (resolve + fetch) and reconcile the manifest tool list ([#33](https://github.com/chrischall/untappd-mcp/issues/33)) ([c560e24](https://github.com/chrischall/untappd-mcp/commit/c560e2421f9136b4cf99c825f88faae67b2476ae))
* untappd_pending_friends (incoming friend requests) ([#23](https://github.com/chrischall/untappd-mcp/issues/23)) ([37b27b6](https://github.com/chrischall/untappd-mcp/commit/37b27b688e5802ab3993149a1a4f03b2a810d087))
* URL resolver + user venues + Foursquare venue lookup ([#27](https://github.com/chrischall/untappd-mcp/issues/27)) ([d22888e](https://github.com/chrischall/untappd-mcp/commit/d22888e55848399239a1f945d2103df92e3181f5))


### Documentation

* complete user_beers compact field list in its description ([#34](https://github.com/chrischall/untappd-mcp/issues/34)) ([baab0a9](https://github.com/chrischall/untappd-mcp/commit/baab0a90ca2cc5bb564c8de5ebecf47d33083aaf))

## 1.0.0 (2026-07-08)


### Features

* add six read tools (beer/venue activity, brewery beers, trending, notifications, local) ([#11](https://github.com/chrischall/untappd-mcp/issues/11)) ([81c4dd6](https://github.com/chrischall/untappd-mcp/commit/81c4dd62d64d0b7d509987632db0b6b28b1f75e9)), closes [#3](https://github.com/chrischall/untappd-mcp/issues/3) [#4](https://github.com/chrischall/untappd-mcp/issues/4) [#5](https://github.com/chrischall/untappd-mcp/issues/5) [#6](https://github.com/chrischall/untappd-mcp/issues/6) [#7](https://github.com/chrischall/untappd-mcp/issues/7) [#8](https://github.com/chrischall/untappd-mcp/issues/8)
* initial untappd-mcp — Untappd v4 mobile API MCP server ([146dada](https://github.com/chrischall/untappd-mcp/commit/146dadaaa24a1b39b4c880f9306ec2d8ee45d1f9))
* photo check-ins and delete-checkin (completes [#10](https://github.com/chrischall/untappd-mcp/issues/10)) ([#18](https://github.com/chrischall/untappd-mcp/issues/18)) ([ead8f57](https://github.com/chrischall/untappd-mcp/commit/ead8f57bd69c93667680a76b4ff4f011fff14642))
* untappd_delete_comment write tool ([#17](https://github.com/chrischall/untappd-mcp/issues/17)) ([b2088f4](https://github.com/chrischall/untappd-mcp/commit/b2088f44595a88cd1ef587adb7032d25d7909144)), closes [#16](https://github.com/chrischall/untappd-mcp/issues/16)
* wishlist add/remove write tools ([#15](https://github.com/chrischall/untappd-mcp/issues/15)) ([b7b8b4a](https://github.com/chrischall/untappd-mcp/commit/b7b8b4afc5060bf9f74e90dd6a15e56724e80f15)), closes [#9](https://github.com/chrischall/untappd-mcp/issues/9)


### Bug Fixes

* address auto-review nits on photo check-in flow ([#20](https://github.com/chrischall/untappd-mcp/issues/20)) ([551a8ca](https://github.com/chrischall/untappd-mcp/commit/551a8ca54e4699ccaccccc5ccf02d5f3d714d425)), closes [#19](https://github.com/chrischall/untappd-mcp/issues/19)


### Documentation

* list the six new read tools in the README ([#14](https://github.com/chrischall/untappd-mcp/issues/14)) ([a369104](https://github.com/chrischall/untappd-mcp/commit/a369104c017cd956c3631ce70b79cc981a16291f)), closes [#12](https://github.com/chrischall/untappd-mcp/issues/12)
