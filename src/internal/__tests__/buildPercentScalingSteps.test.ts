import { inspect } from "util";
import { buildPercentScalingSteps } from "../buildPercentScalingSteps";

test("buildPercentScalingSteps", () => {
  expect(
    inspect(buildPercentScalingSteps(70, 4), { compact: true }),
  ).toMatchSnapshot();
  expect(
    inspect(buildPercentScalingSteps(50, 4), { compact: true }),
  ).toMatchSnapshot();
});
