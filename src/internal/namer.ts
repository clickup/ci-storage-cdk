import compact from "lodash/compact";
import flatten from "lodash/flatten";
import { Namer as NamerOrig } from "multi-convention-namer";

export type Namer = NamerOrig & {
  /**
   * Returns full path from a scope, including this namer:
   * - Some/Scope/CurName -> some-scope-curname
   */
  pathKebabFrom: (scope: { node: { path: string } }) => string;
  /**
   * Returns full path from a scope, including this namer:
   * - Some/Scope/CurName -> SomeScopeCurName
   */
  pathPascalFrom: (scope: { node: { path: string } }) => string;
};

/**
 * Allows to build PascalCased or kebab-cased identifiers from
 * always-lower-cased parts. In different places of CloudFormation, different
 * notation should be used to achieve best naming look-and-feel. Sometimes AWS
 * glues parent scope with the identifier with "/", sometimes with "-" and
 * sometimes just appends to each other (and shortens, plus add an ugly hash in
 * the end). So this is all ad-hoc and experimental.
 */
export function namer<T extends string>(
  ...names: Array<
    (T extends Lowercase<T> ? (string extends T ? never : T) : never) | Namer
  >
) {
  const namer = new NamerOrig(
    flatten(
      names.map((name) => (typeof name === "string" ? name : name.parts)),
    ),
  ) as Namer;
  namer.pathKebabFrom = (scope) =>
    (scope.node.path + "/" + namer.pascal).replace(/\//g, "-").toLowerCase();
  namer.pathPascalFrom = (scope) =>
    new NamerOrig(compact([...scope.node.path.split(/\W+/), ...namer.parts]))
      .pascal;
  return namer;
}
