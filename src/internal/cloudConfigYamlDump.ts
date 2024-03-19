import * as yaml from "js-yaml";

/**
 * Converts JS cloud-config representation to yaml user data script.
 */
export function cloudConfigYamlDump(obj: object): string {
  return (
    "#cloud-config\n" +
    yaml.dump(obj, {
      lineWidth: -1,
      quotingType: '"',
      styles: { "!!str": "literal" },
    })
  );
}
