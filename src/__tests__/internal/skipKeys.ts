export function skipKeys<T>(obj: T, keys: string[]): T {
  if (obj instanceof Array) {
    for (const item of obj) {
      skipKeys(item, keys);
    }
  } else if (typeof obj === "object" && obj !== null) {
    for (const [key, value] of Object.entries(obj)) {
      if (keys.includes(key)) {
        (obj as Record<string, unknown>)[key] = "<skipped>";
      } else {
        skipKeys(value, keys);
      }
    }
  }

  return obj;
}
