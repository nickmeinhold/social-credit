/**
 * Security-critical gating for the upstream-owner gateway provider.
 *
 * The rule (task #51): the owner's LLM credits are used ONLY when the fork
 * explicitly opted in — provider enabled, gateway baseURL configured, AND a
 * PROXY_TOKEN grant present in the env. Any gap must default to NOT using the
 * owner's credits, so the fork falls back to its own free providers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatewayGranted } from "./index.js";

const base = { enabled: true, baseURL: "https://gateway.example/v1" };

test("granted only when enabled + baseURL + token all present", () => {
  assert.equal(gatewayGranted(base, "tok"), true);
});

test("not granted when the provider is disabled (default off)", () => {
  assert.equal(gatewayGranted({ ...base, enabled: false }, "tok"), false);
});

test("not granted when no baseURL is configured", () => {
  assert.equal(gatewayGranted({ enabled: true, baseURL: undefined }, "tok"), false);
});

test("not granted when PROXY_TOKEN is unset (not granted / revoked)", () => {
  assert.equal(gatewayGranted(base, undefined), false);
});

test("not granted when PROXY_TOKEN is empty (env interpolation of an unset var)", () => {
  // config.ts interpolates a missing ${PROXY_TOKEN} to "" — must NOT count.
  assert.equal(gatewayGranted(base, ""), false);
});

test("not granted when the gateway provider is entirely absent from config", () => {
  assert.equal(gatewayGranted(undefined, "tok"), false);
});
