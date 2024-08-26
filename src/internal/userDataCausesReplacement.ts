import { createHash } from "crypto";
import type { UserData } from "aws-cdk-lib/aws-ec2";
import { Lazy, type CfnElement, Stack } from "aws-cdk-lib/core";

/**
 * Triggers replacement (via new logical ID) on user data change. We need it to
 * recreate the instance, since its cloud-init script defines how the instance
 * is created.
 *
 * The logic is copied from ec2.Instance construct which we can't use since it
 * doesn't support httpPutResponseHopLimit attribute:
 * https://github.com/aws/aws-cdk/blob/f470271864ee5/packages/aws-cdk-lib/aws-ec2/lib/instance.ts#L527
 */
export function userDataCausesReplacement(
  element: CfnElement,
  userData: UserData,
) {
  const originalLogicalId = Stack.of(element).getLogicalId(element);
  let recursing = false;
  element.overrideLogicalId(
    Lazy.uncachedString({
      produce: (context) => {
        const fragments: string[] = [];
        recursing = true;
        try {
          fragments.push(JSON.stringify(context.resolve(userData.render())));
        } finally {
          recursing = false;
        }

        const digest = createHash("sha256")
          .update(fragments.join(""))
          .digest("hex")
          .slice(0, 16);
        return `${originalLogicalId}${digest}`;
      },
    }),
  );
  recursing; // TS quirk
}
