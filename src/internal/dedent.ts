/**
 * Removes leading indentation from each line of the text. Removes lines which
 * only include #-comments (to save some space; UserData is limited by 16K).
 * Also, it some line contains only the indentation spaces immediately followed
 * by \n, the line is removed entirely.
 */
export function dedent(text: string): string {
  text = text.replace(/^([ \t\r]*\n)+/s, "").trimEnd();
  text = text.replace(/^[ \t]*#(?![!])[^\n]*\n/gm, "");
  const spacePrefix = text.match(/^([ \t]+)/s) ? RegExp.$1 : null;
  return (
    (spacePrefix
      ? text
          .replace(new RegExp(`^${spacePrefix}\n`, "mg"), "")
          .replace(new RegExp(`^${spacePrefix}`, "mg"), "")
      : text) + "\n"
  );
}
