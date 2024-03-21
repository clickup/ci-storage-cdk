import { App, Duration, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";
import { CiStorage } from "../CiStorage";
import { namer } from "../internal/namer";
import type { Namer } from "../internal/namer";

class CiStorageStack extends Stack {
  public readonly vpc: Vpc;
  public readonly ciStorage: CiStorage;

  constructor(
    public readonly app: Construct,
    public readonly key: Namer,
    public readonly props: {},
  ) {
    super(app, key.pascal, {
      description: "A stack to generate unit tests for CiStorage construct",
    });

    this.vpc = new Vpc(this, "Vpc", {});
    this.ciStorage = new CiStorage(this, "CiStorage", {
      vpc: this.vpc,
      inlinePolicies: {},
      securityGroupId: "test-securityGroupId",
      hostedZone: {
        hostedZoneId: "test-hostedZoneId",
        zoneName: "test-zoneName",
      },
      ghTokenSecretName: "ci-storage/gh-token",
      timeZone: "America/Los_Angeles",
      runner: {
        ghRepository: "time-loop/slapdash",
        ghDockerComposeDirectoryUrl:
          "https://github.com/dimikot/ci-storage#:docker",
        imageSsmName: "test-imageSsmName",
        volumeGb: 50,
        instanceRequirements: [
          {
            memoryMiB: { min: 8192, max: 16384 },
            vCpuCount: { min: 4, max: 8 },
          },
        ],
        scale: {
          onDemandPercentageAboveBaseCapacity: 10,
          maxActiveRunnersPercent: {
            periodSec: 600,
            value: 70,
          },
          minCapacity: [
            {
              id: "CaWorkDayStarts",
              value: 10,
              cron: { hour: "8" },
            },
            {
              id: "CaWorkDayEnds",
              value: 5,
              cron: { hour: "18" },
            },
          ],
          maxCapacity: 20,
          maxInstanceLifetime: Duration.days(1),
        },
      },
      host: {
        ghDockerComposeDirectoryUrl:
          "https://github.com/dimikot/ci-storage#:docker",
        imageSsmName: "test-imageSsmName",
        volumeIops: 3000,
        volumeThroughput: 125,
        volumeGb: 200,
        instanceType: "t3.large",
        machines: 1,
      },
    });
  }
}

test("CiStorage", () => {
  const app = new App();
  const stack = new CiStorageStack(app, namer("test"), {});
  expect(Template.fromStack(stack).toJSON()).toMatchSnapshot();
});
