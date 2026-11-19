import { expect, test } from "bun:test";
import { afterSignIn, verificationCallback } from "../apps/dashboard/src/lib/auth-client";

const origin = "https://highkey.example";

test("after signing in, only same-site paths are followed", () => {
  const go = (redirect: string) => afterSignIn(`?redirect=${encodeURIComponent(redirect)}`, origin);
  expect(go("/acme/orbit?days=7")).toBe("/acme/orbit?days=7");
  expect(go("/join/abc")).toBe("/join/abc");
  for (const hostile of [
    "//evil.example",
    "/\\evil.example",
    "/\tevil.example",
    "/\t/evil.example",
    "https://evil.example/",
    "javascript:alert(1)",
    "evil.example",
  ])
    expect({ hostile, to: go(hostile) }).toEqual({ hostile, to: "/" });
  expect(afterSignIn("", origin)).toBe("/");
});

test("a verification link returns to where the new account was going", () => {
  const join = `?email=a%40b.example&redirect=${encodeURIComponent("/join/abc")}`;
  expect(verificationCallback(join, origin)).toBe("/verify-email?redirect=%2Fjoin%2Fabc");
  expect(verificationCallback("", origin)).toBe("/verify-email");
  expect(verificationCallback(`?redirect=${encodeURIComponent("//evil.example")}`, origin)).toBe(
    "/verify-email",
  );
});
