import { namer } from "../namer";

test("namer", () => {
  expect(namer("OneTwo" as any).kebab).toBe("one-two");
  expect(namer("one-two" as any).pascal).toBe("OneTwo");
  expect(namer("one", "two").pascal).toBe("OneTwo");
  expect(namer("*").pathKebabFrom({ node: { path: "abc" } })).toBe("abc-*");
});
