import { App, Duration, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Port, Vpc } from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";
import { CiStorage } from "../CiStorage";
import { namer } from "../internal/namer";
import type { Namer } from "../internal/namer";
import { skipKeys } from "./internal/skipKeys";

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
    this.ciStorage = new CiStorage(this, "cnstrct", {
      vpc: this.vpc,
      inlinePolicies: {},
      instanceNamePrefix: "my-ci",
      hostedZone: {
        hostedZoneId: "test-hostedZoneId",
        zoneName: "test-zoneName",
      },
      ghTokenSecretName: "ci-storage/gh-token",
      timeZone: "America/Los_Angeles",
      runners: [
        {
          label: "ci-small",
          ghRepository: "clickup/ci-storage-cdk",
          ghDockerComposeDirectoryUrl:
            "https://github.com/dimikot/ci-storage#:docker",
          volumeRootGb: 20,
          volumeLogsGb: 5,
          swapSizeGb: 4,
          instanceRequirements: [
            {
              memoryMiB: { min: 4096, max: 8192 },
              vCpuCount: { min: 2, max: 4 },
            },
          ],
          onDemandPercentageAboveBaseCapacity: 10,
          minCapacity: [
            { id: "CaWorkDayStarts", value: 10, cron: { hour: "8" } },
            { id: "CaWorkDayEnds", value: 5, cron: { hour: "18" } },
          ],
          maxCapacity: 10,
          maxInstanceLifetime: Duration.days(1),
        },
        {
          label: "ci-large",
          ghRepository: "clickup/ci-storage-cdk",
          ghDockerComposeDirectoryUrl:
            "https://github.com/dimikot/ci-storage#:docker",
          volumeRootGb: 40,
          volumeLogsGb: 5,
          swapSizeGb: 8,
          instanceRequirements: [
            {
              memoryMiB: { min: 8192, max: 16384 },
              vCpuCount: { min: 4, max: 8 },
            },
          ],
          onDemandPercentageAboveBaseCapacity: 10,
          minCapacity: [
            { id: "CaWorkDayStarts", value: 10, cron: { hour: "8" } },
            { id: "CaWorkDayEnds", value: 5, cron: { hour: "18" } },
          ],
          maxCapacity: 20,
          maxInstanceLifetime: Duration.days(1),
        },
      ],
      host: {
        ghDockerComposeDirectoryUrl:
          "https://github.com/dimikot/ci-storage#:docker",
        dockerComposeProfiles: ["ci"],
        volumeRootGb: 20,
        varLibDockerOnTmpfsMaxSizeGb: 4,
        instanceType: "t3.large",
        ports: [
          { port: Port.tcp(26022), description: "ci-storage" },
          { port: Port.tcp(28088), description: "ci-scaler", isWebhook: true },
          { port: Port.tcpRange(42000, 42042), description: "test ports" },
        ],
      },
    });
  }
}

test("CiStorage", () => {
  const app = new App();
  const stack = new CiStorageStack(app, namer("stk"), {});
  const json = Template.fromStack(stack).toJSON();
  expect(skipKeys(json, ["S3Key", "Mappings"])).toMatchSnapshot();
});
