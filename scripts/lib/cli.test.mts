import { describe, expect, test } from "bun:test";
import { COMMANDS, parseCommand } from "./cli.mts";

describe("parseCommand", () => {
  test("no args -> usage error", () => {
    expect(() => parseCommand([])).toThrow(/usage/i);
  });

  for (const cmd of COMMANDS) {
    test(`accepts '${cmd}'`, () => {
      expect(parseCommand([cmd]).cmd).toBe(cmd);
    });
  }

  test("unknown command -> error naming it", () => {
    expect(() => parseCommand(["bogus"])).toThrow(/bogus/);
  });

  test("passes through trailing args", () => {
    expect(parseCommand(["status", "--verbose"]).args).toEqual(["--verbose"]);
  });
});
